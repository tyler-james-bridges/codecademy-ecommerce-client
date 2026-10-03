const { randomUUID } = require('node:crypto');
const v = require('./validation');
const c = require('./commerce');

const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const sessionIdInput = body => {
  v.object(body, ['sessionId'], ['sessionId']);
  if (typeof body.sessionId !== 'string' || !/^cs_test_[A-Za-z0-9_]{1,240}$/.test(body.sessionId)) {
    v.fail(400, 'invalid_input', 'Provide a test Checkout session ID.');
  }
  return body.sessionId;
};

function createPayments({ pool, stripe, secretKey, webhookSecret, appOrigin }) {
  if (secretKey && !secretKey.startsWith('sk_test_')) throw new Error('Only a Stripe test-mode secret key is permitted.');
  const enabled = Boolean(stripe && secretKey && webhookSecret);
  const origin = new URL(appOrigin || 'http://localhost:3002');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Payment appOrigin must be an HTTP(S) origin.');
  }
  function available() {
    if (!enabled) v.fail(503, 'payment_unavailable', 'Stripe test checkout is not configured.');
  }
  async function assertCartAvailable(client, cartId) {
    const { rowCount } = await client.query("SELECT 1 FROM checkout_payments WHERE cart_id = $1 AND reservation_state = 'reserved'", [cartId]);
    if (rowCount) v.fail(409, 'checkout_pending', 'Finish or cancel the pending checkout before changing this cart.');
  }
  async function paymentBySession(sessionId, userId) {
    const { rows } = await pool.query(`SELECT cp.*, o.user_id, o.total_cents FROM checkout_payments cp
      JOIN orders o ON o.id = cp.order_id WHERE cp.session_id = $1 AND o.user_id = $2 AND o.deleted_at IS NULL`, [sessionId, userId]);
    if (!rows[0]) v.fail(404, 'not_found', 'Checkout session not found.');
    return rows[0];
  }
  async function paymentForCancel(body, userId) {
    v.object(body, ['sessionId', 'orderId']);
    if (Object.hasOwn(body, 'sessionId') === Object.hasOwn(body, 'orderId')) {
      v.fail(400, 'invalid_input', 'Provide exactly one Checkout session ID or order ID.');
    }
    if (body.sessionId !== undefined) return paymentBySession(sessionIdInput(body), userId);
    const orderId = v.integer(body.orderId, 'orderId');
    const { rows } = await pool.query(`SELECT cp.*, o.user_id, o.total_cents FROM checkout_payments cp
      JOIN orders o ON o.id = cp.order_id WHERE cp.order_id = $1 AND o.user_id = $2 AND o.deleted_at IS NULL`, [orderId, userId]);
    if (!rows[0]) v.fail(404, 'not_found', 'Checkout order not found.');
    if (!rows[0].session_id) v.fail(409, 'checkout_pending', 'Retry checkout for this cart to recover its provider session before cancellation.');
    return rows[0];
  }
  async function reserve(userId, cartId, note) {
    return c.transaction(pool, async client => {
      await c.lockUser(client, userId);
      await c.lockCart(client, cartId, userId, true);
      const { rows: prior } = await client.query(`SELECT cp.*, o.user_id, o.total_cents FROM checkout_payments cp
        JOIN orders o ON o.id = cp.order_id WHERE cp.cart_id = $1 AND cp.reservation_state = 'reserved'`, [cartId]);
      if (prior[0]) return prior[0];
      const { rows: items } = await client.query(`SELECT p.*, ci.quantity FROM cart_items ci
        JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = $1 ORDER BY p.id FOR UPDATE OF p`, [cartId]);
      if (!items.length) v.fail(409, 'empty_cart', 'Add products to the cart before checkout.');
      for (const item of items) {
        if (!item.active || item.stock < item.quantity) v.fail(409, 'stock_unavailable', 'A product is inactive or has insufficient stock.');
      }
      const total = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
      // This course integration accepts USD card payments, with a $0.50 minimum.
      if (total < 50) v.fail(400, 'amount_too_small', 'The checkout total must be at least $0.50 USD.');
      const { rows: orders } = await client.query(`INSERT INTO orders (user_id, status, payment_status, total_cents, note)
        VALUES ($1, 'pending', 'stripe_pending', $2, $3) RETURNING id`, [userId, total, note]);
      const orderId = orders[0].id;
      for (const item of items) {
        await client.query('INSERT INTO order_items (order_id, product_id, name, price_cents, quantity) VALUES ($1, $2, $3, $4, $5)',
          [orderId, item.id, item.name, item.price_cents, item.quantity]);
        await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.id]);
      }
      const attemptKey = randomUUID();
      // Persist the complete provider request: retries must use identical parameters.
      const params = {
        mode: 'payment', payment_method_types: ['card'],
        client_reference_id: String(orderId), metadata: { orderId: String(orderId), paymentAttempt: attemptKey },
        line_items: items.map(item => ({ quantity: item.quantity, price_data: {
          currency: 'usd', unit_amount: item.price_cents, product_data: { name: item.name }
        } })),
        success_url: `${origin.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin.origin}/checkout/cancel?order_id=${orderId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600
      };
      const { rows } = await client.query(`INSERT INTO checkout_payments (order_id, cart_id, attempt_key, create_params)
        VALUES ($1, $2, $3, $4) RETURNING *`, [orderId, cartId, attemptKey, params]);
      return { ...rows[0], user_id: userId, total_cents: total };
    });
  }
  function verifySession(session, payment) {
    if (!session || !/^cs_test_/.test(session.id || '') || session.livemode !== false || session.mode !== 'payment' ||
        session.currency !== 'usd' || session.amount_total !== Number(payment.total_cents) ||
        session.client_reference_id !== String(payment.order_id) ||
        session.metadata?.orderId !== String(payment.order_id) || session.metadata?.paymentAttempt !== payment.attempt_key ||
        (payment.session_id && payment.session_id !== session.id)) {
      v.fail(502, 'payment_verification_failed', 'The payment session could not be verified.');
    }
  }
  async function retrieve(sessionId) {
    try { return await stripe.checkout.sessions.retrieve(sessionId); }
    catch { v.fail(503, 'payment_pending', 'Payment verification is temporarily unavailable. Try again.'); }
  }
  async function reconcile(payment, session) {
    verifySession(session, payment);
    return c.transaction(pool, async client => {
      // Terminal webhook retries remain harmless after an account was soft-deleted.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [payment.user_id]);
      const { rows: orders } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [payment.order_id]);
      const { rows } = await client.query('SELECT * FROM checkout_payments WHERE order_id = $1 FOR UPDATE', [payment.order_id]);
      const current = { ...rows[0], user_id: payment.user_id, total_cents: orders[0].total_cents };
      verifySession(session, current);
      await client.query('UPDATE checkout_payments SET session_id = $1, updated_at = now() WHERE order_id = $2', [session.id, current.order_id]);
      if (current.reservation_state === 'reserved') {
        if (session.status === 'complete' && session.payment_status === 'paid') {
          await client.query("UPDATE orders SET status = 'placed', payment_status = 'stripe_paid' WHERE id = $1", [current.order_id]);
          await client.query("UPDATE checkout_payments SET reservation_state = 'captured' WHERE order_id = $1", [current.order_id]);
          await client.query('DELETE FROM cart_items WHERE cart_id = $1', [current.cart_id]);
        } else if (session.status === 'expired' && session.payment_status === 'unpaid') {
          const { rows: items } = await client.query(`SELECT p.id, oi.quantity FROM order_items oi JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = $1 ORDER BY p.id FOR UPDATE OF p`, [current.order_id]);
          for (const item of items) await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.id]);
          await client.query("UPDATE orders SET status = 'cancelled', payment_status = 'stripe_cancelled' WHERE id = $1", [current.order_id]);
          await client.query("UPDATE checkout_payments SET reservation_state = 'released' WHERE order_id = $1", [current.order_id]);
        }
      }
      return orders[0].deleted_at ? null : c.orderDto(client, current.order_id, payment.user_id);
    });
  }
  const createSession = route(async (req, res) => {
    available();
    v.object(req.body, ['cartId', 'note'], ['cartId']);
    const cartId = v.integer(req.body.cartId, 'cartId');
    const note = req.body.note === undefined ? '' : v.text(req.body.note, 'note', 500, 0);
    const payment = await reserve(req.user.id, cartId, note);
    let session;
    if (payment.session_id) session = await retrieve(payment.session_id);
    else {
      // Do not reuse an idempotency key beyond Stripe's retention window. Unknown
      // outcomes need a trusted webhook/provider reconciliation, never local expiry.
      if (Date.now() - new Date(payment.created_at).getTime() >= 23 * 60 * 60 * 1000) {
        v.fail(503, 'checkout_pending', 'This checkout needs payment-provider reconciliation before retrying.');
      }
      try { session = await stripe.checkout.sessions.create(payment.create_params, { idempotencyKey: payment.attempt_key }); }
      catch {
        // Even a timeout or 500 can occur after Stripe created a payable session.
        // Retain the same reservation and key; a retry or webhook can recover it.
        v.fail(503, 'checkout_pending', 'Checkout could not be confirmed. Retry the same cart to safely recover it.');
      }
    }
    const order = await reconcile(payment, session);
    if (order.status !== 'pending' || session.status !== 'open') {
      return res.status(409).json({ error: { code: 'checkout_closed', message: 'This checkout is already completed or expired.' }, order });
    }
    let checkoutUrl;
    try { checkoutUrl = new URL(session.url); } catch { v.fail(502, 'payment_verification_failed', 'The checkout address is invalid.'); }
    if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com' || checkoutUrl.username || checkoutUrl.password) {
      v.fail(502, 'payment_verification_failed', 'The checkout address is invalid.');
    }
    res.status(201).json({ url: session.url, sessionId: session.id, orderId: payment.order_id });
  });
  const confirmSession = route(async (req, res) => {
    available();
    const payment = await paymentBySession(sessionIdInput(req.body), req.user.id);
    const order = await reconcile(payment, await retrieve(payment.session_id));
    res.json({ order });
  });
  const cancelSession = route(async (req, res) => {
    available();
    const payment = await paymentForCancel(req.body, req.user.id);
    let session = await retrieve(payment.session_id);
    verifySession(session, payment);
    if (session.status === 'open') {
      try { session = await stripe.checkout.sessions.expire(session.id); }
      catch { session = await retrieve(payment.session_id); } // A concurrent payment may have won.
    }
    const order = await reconcile(payment, session);
    if (order.status !== 'cancelled') v.fail(409, 'checkout_not_cancelled', 'Checkout is paid or still processing; it was not cancelled or refunded.');
    res.json({ order });
  });
  const webhook = route(async (req, res) => {
    available();
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch { v.fail(400, 'invalid_signature', 'Webhook signature is invalid.'); }
    if (event.livemode !== false) v.fail(400, 'invalid_event', 'Only test-mode payment events are accepted.');
    if (!['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) {
      return res.json({ received: true });
    }
    const object = event.data?.object;
    if (!object || !/^cs_test_/.test(object.id || '')) v.fail(400, 'invalid_event', 'Checkout event is invalid.');
    const { rows } = await pool.query(`SELECT cp.*, o.user_id, o.total_cents FROM checkout_payments cp
      JOIN orders o ON o.id = cp.order_id WHERE cp.attempt_key::text = $1`, [object.metadata?.paymentAttempt || '']);
    if (rows[0]) await reconcile(rows[0], await retrieve(object.id));
    res.json({ received: true });
  });
  return { createSession, confirmSession, cancelSession, webhook, assertCartAvailable };
}

module.exports = { createPayments };
