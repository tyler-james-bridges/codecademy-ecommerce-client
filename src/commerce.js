const { fail } = require('./validation');

const userDto = row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, createdAt: row.created_at });
const productDto = row => ({ id: row.id, sku: row.sku, name: row.name, description: row.description, priceCents: row.price_cents, stock: row.stock, active: row.active });

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// All customer mutations lock the account first, then the cart/order, then
// products in ID order. Account deletion and concurrent checkout share this lock.
async function lockUser(client, userId) {
  const { rows } = await client.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId]);
  if (!rows[0]) fail(401, 'unauthenticated', 'Sign in to continue.');
  return rows[0];
}
async function lockCart(client, cartId, userId, allowPending = false) {
  const { rows } = await client.query('SELECT * FROM carts WHERE id = $1 AND user_id = $2 FOR UPDATE', [cartId, userId]);
  if (!rows[0]) fail(404, 'not_found', 'Cart not found.');
  // One cart per account: protect its reserved contents even if Stripe keys are
  // temporarily removed from configuration. This also guards legacy checkout.
  if (!allowPending) {
    const pending = await client.query("SELECT id FROM orders WHERE user_id = $1 AND status = 'pending' LIMIT 1", [userId]);
    if (pending.rowCount) fail(409, 'checkout_pending', 'Finish or cancel the pending checkout before changing this cart.');
  }
  return rows[0];
}
async function cartDto(client, cartId, userId) {
  const { rows: carts } = await client.query('SELECT * FROM carts WHERE id = $1 AND user_id = $2', [cartId, userId]);
  if (!carts[0]) fail(404, 'not_found', 'Cart not found.');
  const { rows } = await client.query(`SELECT p.*, ci.quantity FROM cart_items ci
    JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = $1 ORDER BY p.id`, [cartId]);
  const items = rows.map(row => ({ productId: row.id, sku: row.sku, name: row.name,
    priceCents: row.price_cents, quantity: row.quantity, stock: row.stock, active: row.active,
    lineTotalCents: row.price_cents * row.quantity }));
  return { id: carts[0].id, userId, items, totalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0) };
}
async function orderDto(client, orderId, userId) {
  const { rows: orders } = await client.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [orderId, userId]);
  const row = orders[0];
  if (!row) fail(404, 'not_found', 'Order not found.');
  const { rows } = await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_id', [orderId]);
  return { id: row.id, userId: row.user_id, status: row.status, paymentStatus: row.payment_status,
    totalCents: Number(row.total_cents), note: row.note, createdAt: row.created_at,
    items: rows.map(item => ({ productId: item.product_id, name: item.name,
      priceCents: item.price_cents, quantity: item.quantity, lineTotalCents: item.price_cents * item.quantity })) };
}

async function checkout(pool, userId, cartId, input) {
  return transaction(pool, async client => {
    await lockUser(client, userId);
    await lockCart(client, cartId, userId);
    const { rows: items } = await client.query(`SELECT p.*, ci.quantity FROM cart_items ci
      JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = $1 ORDER BY p.id FOR UPDATE OF p`, [cartId]);
    if (!items.length) fail(409, 'empty_cart', 'Add products to the cart before checkout.');
    for (const item of items) {
      if (!item.active || item.stock < item.quantity) fail(409, 'stock_unavailable', 'A product is inactive or has insufficient stock.');
    }
    const total = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
    const { rows: orders } = await client.query('INSERT INTO orders (user_id, total_cents, note) VALUES ($1, $2, $3) RETURNING id', [userId, total, input.note]);
    const orderId = orders[0].id;
    for (const item of items) {
      await client.query(`INSERT INTO order_items (order_id, product_id, name, price_cents, quantity)
        VALUES ($1, $2, $3, $4, $5)`, [orderId, item.id, item.name, item.price_cents, item.quantity]);
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.id]);
    }
    // Deliberately fail after writes: the transaction must undo every change.
    // This is a local simulation and never contacts a payment provider.
    if (input.simulatePayment === 'fail') fail(402, 'payment_failed', 'Simulated payment declined; the cart and stock were preserved.');
    await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
    return orderDto(client, orderId, userId);
  });
}

async function updateOrder(pool, userId, orderId, input, remove = false) {
  return transaction(pool, async client => {
    await lockUser(client, userId);
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [orderId, userId]);
    const order = rows[0];
    if (!order) fail(404, 'not_found', 'Order not found.');
    if (remove) {
      if (order.status !== 'cancelled') fail(409, 'order_not_cancelled', 'Cancel the order before deleting it.');
      await client.query('UPDATE orders SET deleted_at = now() WHERE id = $1', [orderId]);
      return;
    }
    if (input.status === 'cancelled' && ['stripe_pending', 'stripe_paid'].includes(order.payment_status)) {
      fail(409, 'provider_cancellation_required', 'Cancel pending Stripe checkout through its session. Paid Stripe orders require a real refund and cannot be cancelled here.');
    }
    if (input.status === 'cancelled' && order.status === 'placed') {
      const { rows: items } = await client.query(`SELECT p.id, oi.quantity FROM order_items oi
        JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.id FOR UPDATE OF p`, [orderId]);
      for (const item of items) await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.id]);
      await client.query("UPDATE orders SET status = 'cancelled', payment_status = 'simulated_refunded' WHERE id = $1", [orderId]);
    }
    if (input.note !== undefined) await client.query('UPDATE orders SET note = $1 WHERE id = $2', [input.note, orderId]);
    return orderDto(client, orderId, userId);
  });
}

module.exports = { userDto, productDto, transaction, lockUser, lockCart, cartDto, orderDto, checkout, updateOrder };
