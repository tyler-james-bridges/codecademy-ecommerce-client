const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const request = require('supertest');
const Stripe = require('stripe');
const { databaseUrl } = require('../src/config');
const { createApp } = require('../src/app');
const { createPayments } = require('../src/payments');
const c = require('../src/commerce');

const secretKey = 'sk_test_course_fixture';
const webhookSecret = 'whsec_course_fixture';
const stripeSdk = new Stripe(secretKey);
const base = '/api/checkout/sessions';
let pool, app, provider, counter = 0;

function fakeStripe() {
  const sessions = new Map();
  const requests = new Map();
  const provider = {
    sessions, requests, createCalls: 0, failAfterCreate: false, failBeforeCreate: false, expireFailure: false, payDuringCancel: false,
    webhooks: stripeSdk.webhooks,
    checkout: { sessions: {
      async create(params, options) {
        provider.createCalls++;
        if (provider.failBeforeCreate) throw new Error('Injected network failure before response');
        let saved = requests.get(options.idempotencyKey);
        if (saved) assert.deepEqual(params, saved.params, 'Stripe retries must use identical persisted parameters');
        else {
          const id = `cs_test_course_${requests.size + 1}`;
          saved = { params: structuredClone(params), id };
          requests.set(options.idempotencyKey, saved);
          sessions.set(id, { id, livemode: false, mode: 'payment', currency: 'usd',
            amount_total: params.line_items.reduce((sum, item) => sum + item.quantity * item.price_data.unit_amount, 0),
            metadata: structuredClone(params.metadata), client_reference_id: params.client_reference_id,
            status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.com/c/pay/${id}` });
        }
        if (provider.failAfterCreate) { provider.failAfterCreate = false; throw new Error('Injected lost provider response'); }
        return structuredClone(sessions.get(saved.id));
      },
      async retrieve(id) {
        if (!sessions.has(id)) throw new Error('Unknown provider session');
        return structuredClone(sessions.get(id));
      },
      async expire(id) {
        const session = sessions.get(id);
        if (provider.payDuringCancel) { session.status = 'complete'; session.payment_status = 'paid'; throw new Error('Payment won race'); }
        if (provider.expireFailure) throw new Error('Injected expire failure');
        if (session.status !== 'open') throw new Error('Session not open');
        session.status = 'expired'; session.url = null;
        return structuredClone(session);
      }
    } }
  };
  return provider;
}

before(async () => {
  pool = new Pool({ connectionString: databaseUrl(true), max: 15 });
  await pool.query(await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
  const migration = await fs.readFile(path.join(__dirname, '../sql/payment-schema.sql'), 'utf8');
  await pool.query(migration);
  await pool.query(migration); // Migration must be safe to repeat on existing orders.
});
beforeEach(async () => {
  await pool.query('TRUNCATE order_items, orders, cart_items, carts, products, users, sessions RESTART IDENTITY CASCADE');
  provider = fakeStripe();
  app = createApp({ pool, sessionSecret: 'only-for-isolated-payment-tests-123456789', origin: 'http://localhost:3002',
    stripe: provider, stripeSecretKey: secretKey, stripeWebhookSecret: webhookSecret });
});
afterEach(() => app?.locals.sessionStore.close());
after(async () => pool?.end());

async function shopper() {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({ username: `payment_${++counter}`, password: 'Fictional-Password-123', displayName: 'Test Shopper' }).expect(201);
  return { agent, user: response.body.user };
}
async function product(stock = 5, priceCents = 1250) {
  const { rows } = await pool.query('INSERT INTO products (sku,name,price_cents,stock) VALUES ($1,$2,$3,$4) RETURNING id',
    [`PAY-${++counter}`, 'Test Product', priceCents, stock]);
  return rows[0].id;
}
async function cart(agent, productId, quantity = 2) {
  const { body } = await agent.post('/api/carts').send({}).expect(201);
  await agent.put(`/api/carts/${body.cart.id}`).send({ items: [{ productId, quantity }] }).expect(200);
  return body.cart.id;
}
async function stock(productId) { return (await pool.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock; }
async function fixture() {
  const { agent, user } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  const { body } = await agent.post(base).send({ cartId, note: 'Test-mode purchase' }).expect(201);
  return { agent, user, productId, cartId, ...body };
}
function eventFor(sessionId, type = 'checkout.session.completed') {
  return { id: `evt_test_${++counter}`, object: 'event', livemode: false, type,
    data: { object: structuredClone(provider.sessions.get(sessionId)) } };
}
function webhook(event, valid = true) {
  const payload = JSON.stringify(event);
  const signature = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: valid ? webhookSecret : 'whsec_wrong' });
  return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('stripe-signature', signature).send(payload);
}

// These use real HTTP handling, PostgreSQL transactions, and Stripe's real HMAC
// verifier. Only provider network calls are replaced; no Stripe account is used.
test('checkout rejects live configuration, missing credentials, anonymous users and client prices', async () => {
  assert.throws(() => createPayments({ pool, secretKey: 'sk_live_rejected' }), /test-mode/);
  const disabled = createApp({ pool, sessionSecret: 'only-for-isolated-payment-tests-123456789' });
  try {
    await request(disabled).post('/api/payments/webhook').send({}).expect(503);
  } finally { disabled.locals.sessionStore.close(); }
  await request(app).post(base).send({ cartId: 1 }).expect(401);
  const { agent } = await shopper();
  await agent.post(base).send({ cartId: 1, amount: 1 }).expect(400);
  assert.equal(provider.createCalls, 0);
});

test('reservation uses current server prices, snapshots items and freezes cart/account writes', async () => {
  const { agent, user } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  await pool.query('UPDATE products SET price_cents=1500 WHERE id=$1', [productId]);
  const { body } = await agent.post(base).send({ cartId, note: 'Saved note' }).expect(201);
  assert.equal(await stock(productId), 3);
  const { body: orderResult } = await agent.get(`/api/orders/${body.orderId}`).expect(200);
  assert.equal(orderResult.order.status, 'pending');
  assert.equal(orderResult.order.totalCents, 3000);
  assert.equal(orderResult.order.items[0].priceCents, 1500);
  const params = [...provider.requests.values()][0].params;
  assert.equal(params.cancel_url, `http://localhost:3002/checkout/cancel?order_id=${body.orderId}`);
  assert.equal(params.success_url, 'http://localhost:3002/checkout/success?session_id={CHECKOUT_SESSION_ID}');
  assert.deepEqual(params.payment_method_types, ['card']);
  await agent.put(`/api/carts/${cartId}`).send({ items: [] }).expect(409);
  await agent.delete(`/api/carts/${cartId}`).expect(409);
  await agent.delete(`/api/users/${user.id}`).expect(409);
  await agent.put(`/api/orders/${body.orderId}`).send({ status: 'cancelled' }).expect(409);
  // Even if Stripe configuration disappears, the core commerce lock guards it.
  await assert.rejects(c.checkout(pool, user.id, cartId, { note: '', simulatePayment: 'success' }), error => error.code === 'checkout_pending');
});

test('parallel retries create one reservation and one idempotent provider session', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  const results = await Promise.all([agent.post(base).send({ cartId }), agent.post(base).send({ cartId })]);
  assert.deepEqual(results.map(r => r.status), [201, 201]);
  assert.equal(results[0].body.sessionId, results[1].body.sessionId);
  assert.equal(provider.requests.size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  assert.equal(await stock(productId), 3);
});

test('confirm uses trusted paid state, clears the cart and does not fake a refund', async () => {
  const f = await fixture();
  await f.agent.post(`${base}/confirm`).send({ sessionId: f.sessionId, paid: true }).expect(400);
  let result = await f.agent.post(`${base}/confirm`).send({ sessionId: f.sessionId }).expect(200);
  assert.equal(result.body.order.status, 'pending');
  Object.assign(provider.sessions.get(f.sessionId), { status: 'complete', payment_status: 'paid' });
  result = await f.agent.post(`${base}/confirm`).send({ sessionId: f.sessionId }).expect(200);
  assert.equal(result.body.order.paymentStatus, 'stripe_paid');
  assert.equal(result.body.order.status, 'placed');
  assert.equal((await f.agent.get(`/api/carts/${f.cartId}`)).body.cart.items.length, 0);
  const history = await f.agent.get('/api/orders').expect(200);
  assert.equal(history.body.orders[0].paymentStatus, 'stripe_paid');
  await f.agent.put(`/api/orders/${f.orderId}`).send({ status: 'cancelled' }).expect(409);
  await f.agent.post(`${base}/cancel`).send({ orderId: f.orderId }).expect(409);
  await f.agent.delete(`/api/orders/${f.orderId}`).expect(409);
  await webhook(eventFor(f.sessionId)).expect(200);
  await webhook(eventFor(f.sessionId)).expect(200);
  assert.equal(await stock(f.productId), 3);
});

test('other accounts cannot create, confirm or cancel another owner checkout', async () => {
  const f = await fixture();
  const other = await shopper();
  await other.agent.post(base).send({ cartId: f.cartId }).expect(404);
  await other.agent.post(`${base}/confirm`).send({ sessionId: f.sessionId }).expect(404);
  await other.agent.post(`${base}/cancel`).send({ sessionId: f.sessionId }).expect(404);
  await other.agent.post(`${base}/cancel`).send({ orderId: f.orderId }).expect(404);
  assert.equal(await stock(f.productId), 3);
});

test('verification rejects mismatched totals, currency, mode, metadata, reference and live sessions', async () => {
  const f = await fixture();
  const original = structuredClone(provider.sessions.get(f.sessionId));
  const mutations = [{ amount_total: 1 }, { currency: 'eur' }, { livemode: true }, { mode: 'subscription' },
    { client_reference_id: '999' }, { metadata: { ...original.metadata, orderId: '999' } },
    { metadata: { ...original.metadata, paymentAttempt: 'wrong' } }];
  for (const change of mutations) {
    provider.sessions.set(f.sessionId, { ...original, status: 'complete', payment_status: 'paid', ...change });
    await f.agent.post(`${base}/confirm`).send({ sessionId: f.sessionId }).expect(502);
  }
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [f.orderId])).rows[0].status, 'pending');
  assert.equal(await stock(f.productId), 3);
});

test('verified cancellation and duplicate expiry release stock once and preserve the cart', async () => {
  const f = await fixture();
  const result = await f.agent.post(`${base}/cancel`).send({ orderId: f.orderId }).expect(200);
  assert.equal(result.body.order.paymentStatus, 'stripe_cancelled');
  await f.agent.post(`${base}/cancel`).send({ sessionId: f.sessionId }).expect(200);
  await webhook(eventFor(f.sessionId, 'checkout.session.expired')).expect(200);
  assert.equal(await stock(f.productId), 5);
  assert.equal((await f.agent.get(`/api/carts/${f.cartId}`)).body.cart.items[0].quantity, 2);
  await f.agent.put(`/api/carts/${f.cartId}`).send({ items: [] }).expect(200);
  await f.agent.delete(`/api/orders/${f.orderId}`).expect(204);
  await f.agent.delete(`/api/users/${f.user.id}`).expect(204);
  await webhook(eventFor(f.sessionId, 'checkout.session.expired')).expect(200);
  assert.equal(await stock(f.productId), 5);
});

test('cancellation racing a completed payment never releases paid stock', async () => {
  const f = await fixture();
  provider.payDuringCancel = true;
  await f.agent.post(`${base}/cancel`).send({ sessionId: f.sessionId }).expect(409);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1', [f.orderId])).rows[0].payment_status, 'stripe_paid');
  assert.equal(await stock(f.productId), 3);
});

test('failed cancellation leaves an open session and reservation intact', async () => {
  const f = await fixture();
  provider.expireFailure = true;
  await f.agent.post(`${base}/cancel`).send({ sessionId: f.sessionId }).expect(409);
  assert.equal(await stock(f.productId), 3);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [f.orderId])).rows[0].status, 'pending');
});

test('raw webhook verification rejects malformed, bad signatures and live events', async () => {
  const f = await fixture();
  await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send('not JSON').expect(400);
  await webhook(eventFor(f.sessionId), false).expect(400);
  await webhook({ ...eventFor(f.sessionId), livemode: true }).expect(400);
  assert.equal(await stock(f.productId), 3);
  // Stale event snapshots cannot override the currently retrieved provider state.
  const oldEvent = eventFor(f.sessionId);
  Object.assign(provider.sessions.get(f.sessionId), { status: 'complete', payment_status: 'paid' });
  await webhook(oldEvent).expect(200);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [f.orderId])).rows[0].status, 'placed');
});

test('lost provider creation response is recoverable with unchanged idempotency parameters', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  provider.failAfterCreate = true;
  const failed = await agent.post(base).send({ cartId, note: 'Original note' }).expect(503);
  assert.equal(failed.body.error.code, 'checkout_pending');
  assert.equal(await stock(productId), 3);
  const { body } = await agent.post(base).send({ cartId, note: 'Ignored retry change' }).expect(201);
  assert.equal(provider.requests.size, 1);
  assert.equal(await stock(productId), 3);
  assert.equal((await agent.get(`/api/orders/${body.orderId}`)).body.order.note, 'Original note');
});

test('webhook recovers a paid session even when creation response was lost', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  provider.failAfterCreate = true;
  await agent.post(base).send({ cartId }).expect(503);
  const sessionId = [...provider.sessions.keys()][0];
  Object.assign(provider.sessions.get(sessionId), { status: 'complete', payment_status: 'paid' });
  await webhook(eventFor(sessionId)).expect(200);
  await agent.post(`${base}/confirm`).send({ sessionId }).expect(200);
  assert.equal((await pool.query('SELECT payment_status FROM orders')).rows[0].payment_status, 'stripe_paid');
  assert.equal(await stock(productId), 3);
});

test('failed creation before a response never locally assumes payment is impossible', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  provider.failBeforeCreate = true;
  await agent.post(base).send({ cartId }).expect(503);
  assert.equal(await stock(productId), 3);
  provider.failBeforeCreate = false;
  await agent.post(base).send({ cartId }).expect(201);
  assert.equal(await stock(productId), 3);
});

function rejectedCardParameter() {
  return new Stripe.errors.StripeInvalidRequestError({ statusCode: 400,
    type: 'invalid_request_error', param: 'payment_method_types', message: 'The parameter is no longer supported.' });
}

test('concurrent retries renew a cached card-parameter rejection once without changing the reservation', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  provider.failBeforeCreate = true;
  await agent.post(base).send({ cartId, note: 'Keep this order' }).expect(503);
  provider.failBeforeCreate = false;
  const expiredAt = Math.floor(Date.now() / 1000) - 3600;
  const { rows: [original] } = await pool.query(`UPDATE checkout_payments SET created_at = now() - interval '2 hours',
    create_params = jsonb_set(create_params, '{expires_at}', to_jsonb($1::bigint)) RETURNING *`, [expiredAt]);
  const create = provider.checkout.sessions.create;
  let rejectedCalls = 0, replacementCalls = 0, releaseOldRequests;
  const oldRequestsArrived = new Promise(resolve => { releaseOldRequests = resolve; });
  provider.checkout.sessions.create = async (params, options) => {
    if (options.idempotencyKey === original.attempt_key) {
      assert.deepEqual(params, original.create_params);
      if (++rejectedCalls === 2) releaseOldRequests();
      await oldRequestsArrived;
      throw rejectedCardParameter();
    }
    replacementCalls++;
    return create(params, options);
  };
  const results = await Promise.all([agent.post(base).send({ cartId }), agent.post(base).send({ cartId })]);
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.equal(results[0].body.sessionId, results[1].body.sessionId);
  assert.equal(rejectedCalls, 2);
  assert.ok(replacementCalls >= 1 && replacementCalls <= 2);
  const { rows: [renewed] } = await pool.query('SELECT * FROM checkout_payments');
  assert.equal(renewed.order_id, original.order_id);
  assert.equal(renewed.cart_id, original.cart_id);
  assert.equal(renewed.rejected_attempt_key, original.attempt_key);
  assert.notEqual(renewed.attempt_key, original.attempt_key);
  assert.equal(renewed.reservation_state, 'reserved');
  assert.ok(renewed.created_at > original.created_at);
  assert.ok(renewed.create_params.expires_at >= Math.floor(Date.now() / 1000) + 3500);
  assert.deepEqual(renewed.create_params, { ...original.create_params,
    metadata: { ...original.create_params.metadata, paymentAttempt: renewed.attempt_key },
    expires_at: renewed.create_params.expires_at });
  assert.equal(provider.requests.size, 1);
  assert.equal(provider.sessions.size, 1);
  assert.equal(await stock(productId), 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  assert.equal((await agent.get(`/api/orders/${original.order_id}`)).body.order.note, 'Keep this order');
  assert.equal((await agent.get(`/api/carts/${cartId}`)).body.cart.items[0].quantity, 2);
});

test('a rejected replacement is retained for reconciliation rather than rotating again', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  const attemptedKeys = [];
  provider.checkout.sessions.create = async (params, options) => {
    attemptedKeys.push(options.idempotencyKey);
    throw rejectedCardParameter();
  };
  await agent.post(base).send({ cartId }).expect(503);
  const { rows: [first] } = await pool.query('SELECT * FROM checkout_payments');
  await agent.post(base).send({ cartId }).expect(503);
  const { rows: [second] } = await pool.query('SELECT * FROM checkout_payments');
  assert.deepEqual(second, first);
  assert.deepEqual(attemptedKeys, [first.rejected_attempt_key, first.attempt_key, first.attempt_key]);
  assert.equal(await stock(productId), 3);
  assert.equal(provider.sessions.size, 0);
});

test('other validation, idempotency, server and network errors never renew the attempt', async () => {
  const { agent } = await shopper();
  const productId = await product();
  const cartId = await cart(agent, productId);
  const errors = [
    new Stripe.errors.StripeInvalidRequestError({ statusCode: 400, type: 'invalid_request_error', param: 'expires_at' }),
    new Stripe.errors.StripeIdempotencyError({ statusCode: 400, type: 'idempotency_error', param: 'payment_method_types' }),
    new Stripe.errors.StripeAPIError({ statusCode: 500, type: 'api_error', param: 'payment_method_types' }),
    new Error('Injected connection loss')
  ];
  let original;
  for (const error of errors) {
    provider.checkout.sessions.create = async () => { throw error; };
    await agent.post(base).send({ cartId }).expect(503);
    const { rows: [payment] } = await pool.query('SELECT * FROM checkout_payments');
    original ||= payment;
    assert.deepEqual(payment, original);
    assert.equal(payment.rejected_attempt_key, null);
  }
  assert.equal(await stock(productId), 3);
  assert.equal(provider.sessions.size, 0);
});

test('concurrent customers cannot reserve the last stock twice', async () => {
  const first = await shopper(), second = await shopper();
  const productId = await product(1);
  const firstCart = await cart(first.agent, productId, 1), secondCart = await cart(second.agent, productId, 1);
  const results = await Promise.all([first.agent.post(base).send({ cartId: firstCart }), second.agent.post(base).send({ cartId: secondCart })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(await stock(productId), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
});

test('too-small totals fail before reserving stock or contacting Stripe', async () => {
  const { agent } = await shopper();
  const productId = await product(2, 10);
  const cartId = await cart(agent, productId, 1);
  await agent.post(base).send({ cartId }).expect(400);
  assert.equal(await stock(productId), 2);
  assert.equal(provider.createCalls, 0);
});
