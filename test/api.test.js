const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { databaseUrl } = require('../src/config');
const { createApp } = require('../src/app');

let pool;
let app;
let counter = 0;
const password = 'Fictional-Test-Password-123';
before(async () => {
  // databaseUrl(true) refuses any database except ecommerce_course_test.
  pool = new Pool({ connectionString: databaseUrl(true), max: 15 });
  await pool.query(await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
  app = createApp({ pool, sessionSecret: 'only-for-isolated-api-tests-123456789', origin: 'http://localhost:3002' });
});
beforeEach(async () => {
  await pool.query('TRUNCATE order_items, orders, cart_items, carts, products, users, sessions RESTART IDENTITY CASCADE');
});
after(async () => {
  if (app) app.locals.sessionStore.close();
  if (pool) await pool.end();
});

async function account(admin = false) {
  const agent = request.agent(app);
  const username = `shopper_${++counter}`;
  const response = await agent.post('/api/auth/register').send({ username, password, displayName: 'Fictional Shopper' }).expect(201);
  const user = response.body.user;
  if (admin) await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
  return { agent, user, username, response };
}
async function product(overrides = {}) {
  const { rows } = await pool.query(`INSERT INTO products (sku, name, price_cents, stock)
    VALUES ($1, $2, $3, $4) RETURNING id`, [`SKU-${++counter}`, overrides.name ?? 'Desk Lamp', overrides.priceCents ?? 3499, overrides.stock ?? 10]);
  return rows[0].id;
}
async function cart(agent, items = []) {
  const created = await agent.post('/api/carts').send({}).expect(201);
  const cartId = created.body.cart.id;
  await agent.put(`/api/carts/${cartId}`).send({ items }).expect(200);
  return cartId;
}
async function stock(productId) { return (await pool.query('SELECT stock FROM products WHERE id = $1', [productId])).rows[0].stock; }
async function orderCount() { return Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count); }

test('registration hashes passwords, normalizes names and blocks duplicates/role assignment', async () => {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({ username: 'Shopper', password, displayName: 'Sam' }).expect(201);
  assert.equal(response.body.user.username, 'shopper');
  assert.equal(response.body.user.role, 'user');
  assert.equal(JSON.stringify(response.body).includes('password'), false);
  const stored = (await pool.query('SELECT password_hash FROM users')).rows[0].password_hash;
  assert.notEqual(stored, password);
  assert.ok(await bcrypt.compare(password, stored));
  await agent.get('/api/auth/me').expect(200);
  await request(app).post('/api/auth/register').send({ username: 'SHOPPER', password, displayName: 'Duplicate' }).expect(409);
  await request(app).post('/api/auth/register').send({ username: 'hacker', password, displayName: 'Bad', role: 'admin' }).expect(400);
  await request(app).post('/api/auth/register').send({ username: 'tiny', password: 'short', displayName: 'Tiny' }).expect(400);
  await request(app).post('/api/auth/register').send({ username: 'long', password: '🐶'.repeat(19), displayName: 'Long' }).expect(400);
});

test('login rotates sessions; logout and password changes invalidate old sessions', async () => {
  const { agent, user, username, response } = await account();
  const oldCookie = response.headers['set-cookie'][0].split(';')[0];
  await agent.post('/api/auth/login').send({ username, password: 'Definitely-Wrong-Password' }).expect(401);
  const login = await agent.post('/api/auth/login').send({ username, password }).expect(200);
  assert.notEqual(login.headers['set-cookie'][0].split(';')[0], oldCookie);
  await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  const otherSession = request.agent(app);
  await otherSession.post('/api/auth/login').send({ username, password }).expect(200);
  await agent.put(`/api/users/${user.id}`).send({ password: 'New-Fictional-Password-123', currentPassword: password }).expect(200);
  await otherSession.get('/api/auth/me').expect(401);
  await agent.get('/api/auth/me').expect(200);
  await agent.post('/api/auth/logout').expect(204);
  await agent.get('/api/auth/me').expect(401);
});

test('a login paused before password replacement cannot revive the old credentials', async () => {
  const a = await account();
  const delayed = request.agent(app);
  const original = pool.query;
  let signalLookup;
  let resumeLogin;
  const lookupSeen = new Promise(resolve => { signalLookup = resolve; });
  const resume = new Promise(resolve => { resumeLogin = resolve; });
  pool.query = function (...args) {
    const result = original.apply(this, args);
    if (args[0] === 'SELECT * FROM users WHERE username = $1 AND deleted_at IS NULL' && args[1][0] === a.username) {
      return result.then(async rows => { signalLookup(); await resume; return rows; });
    }
    return result;
  };
  const pendingLogin = delayed.post('/api/auth/login').send({ username: a.username, password }).then(response => response);
  try {
    await lookupSeen;
    await a.agent.put(`/api/users/${a.user.id}`).send({ password: 'Replacement-Password-123', currentPassword: password }).expect(200);
  } finally {
    pool.query = original;
    resumeLogin();
  }
  await pendingLogin;
  await delayed.get('/api/auth/me').expect(401);
  await a.agent.get('/api/auth/me').expect(200);
});

test('account ownership, updates and admin-only listing are enforced', async () => {
  const a = await account();
  const b = await account();
  await a.agent.get('/api/users').expect(403);
  await a.agent.get(`/api/users/${b.user.id}`).expect(404);
  await a.agent.put(`/api/users/${b.user.id}`).send({ displayName: 'Wrong owner' }).expect(404);
  await a.agent.delete(`/api/users/${b.user.id}`).expect(404);
  await a.agent.put(`/api/users/${a.user.id}`).send({ role: 'admin' }).expect(400);
  await a.agent.put(`/api/users/${a.user.id}`).send({ username: 'renamed' }).expect(400);
  const changed = await a.agent.put(`/api/users/${a.user.id}`).send({ displayName: 'New Name', username: 'renamed', currentPassword: password }).expect(200);
  assert.equal(changed.body.user.displayName, 'New Name');
  const admin = await account(true);
  assert.equal((await admin.agent.get('/api/users').expect(200)).body.users.length, 3);
  await admin.agent.get(`/api/users/${a.user.id}`).expect(200);
  await admin.agent.put(`/api/users/${a.user.id}`).send({ displayName: 'Admin overwrite' }).expect(404);
});

test('product CRUD validates cents and stock, restricts writes, and soft deletes', async () => {
  const admin = await account(true);
  const customer = await account();
  const input = { sku: 'LAMP', name: 'Desk Lamp', description: 'Fictional', priceCents: 3499, stock: 8 };
  await request(app).post('/api/products').send(input).expect(401);
  await customer.agent.post('/api/products').send(input).expect(403);
  for (const invalid of [{ priceCents: 1.5 }, { priceCents: '3499' }, { stock: -1 }, { active: true }, { sku: '' }]) {
    await admin.agent.post('/api/products').send({ ...input, ...invalid }).expect(400);
  }
  const created = await admin.agent.post('/api/products').send(input).expect(201);
  const id = created.body.product.id;
  await admin.agent.post('/api/products').send(input).expect(409);
  assert.equal((await request(app).get('/api/products').expect(200)).body.products.length, 1);
  assert.equal((await request(app).get(`/api/products/${id}`).expect(200)).body.product.priceCents, 3499);
  const changed = await admin.agent.put(`/api/products/${id}`).send({ priceCents: 0, stock: 0, description: '' }).expect(200);
  assert.equal(changed.body.product.priceCents, 0);
  await admin.agent.delete(`/api/products/${id}`).expect(204);
  await request(app).get(`/api/products/${id}`).expect(404);
  assert.equal((await request(app).get('/api/products')).body.products.length, 0);
  assert.equal((await pool.query('SELECT active FROM products WHERE id = $1', [id])).rows[0].active, false);
});

test('cart CRUD rejects other owners, duplicate lines, quantity errors and price injection', async () => {
  const a = await account();
  const b = await account();
  const productId = await product();
  const cartId = await cart(a.agent, [{ productId, quantity: 2 }]);
  await a.agent.post('/api/carts').send({}).expect(409);
  await b.agent.get(`/api/carts/${cartId}`).expect(404);
  await b.agent.put(`/api/carts/${cartId}`).send({ items: [] }).expect(404);
  await b.agent.delete(`/api/carts/${cartId}`).expect(404);
  for (const items of [[{ productId, quantity: 0 }], [{ productId, quantity: 1.2 }], [{ productId, quantity: 100 }],
    [{ productId, quantity: 1, priceCents: 1 }], [{ productId, quantity: 1 }, { productId, quantity: 2 }]]) {
    await a.agent.put(`/api/carts/${cartId}`).send({ items }).expect(400);
  }
  await a.agent.put(`/api/carts/${cartId}`).send({ items: [{ productId, quantity: 11 }] }).expect(409);
  await a.agent.put(`/api/carts/${cartId}`).send({ items: [{ productId: 99999, quantity: 1 }] }).expect(404);
  const current = (await a.agent.get(`/api/carts/${cartId}`).expect(200)).body.cart;
  assert.equal(current.totalCents, 6998);
  assert.equal(current.items[0].quantity, 2);
  assert.equal((await a.agent.get('/api/carts').expect(200)).body.carts.length, 1);
  await a.agent.put(`/api/carts/${cartId}`).send({ items: [] }).expect(200);
  await a.agent.delete(`/api/carts/${cartId}`).expect(204);
  await a.agent.get(`/api/carts/${cartId}`).expect(404);
});

test('checkout commits exact totals, stock and immutable order snapshots; ownership stays private', async () => {
  const a = await account();
  const b = await account();
  const first = await product();
  const second = await product({ priceCents: 899, name: 'Notebook' });
  const cartId = await cart(a.agent, [{ productId: first, quantity: 2 }, { productId: second, quantity: 1 }]);
  await b.agent.post('/api/orders').send({ cartId }).expect(404);
  await a.agent.post('/api/orders').send({ cartId, totalCents: 1 }).expect(400);
  const order = (await a.agent.post('/api/orders').send({ cartId, note: 'Fictional order' }).expect(201)).body.order;
  assert.equal(order.totalCents, 7897);
  assert.equal(order.status, 'placed');
  assert.equal(order.paymentStatus, 'simulated_paid');
  assert.equal(await stock(first), 8);
  assert.equal(await stock(second), 9);
  assert.deepEqual((await a.agent.get(`/api/carts/${cartId}`)).body.cart.items, []);
  assert.equal((await a.agent.get('/api/orders')).body.orders.length, 1);
  for (const method of ['get', 'put', 'delete']) {
    let call = b.agent[method](`/api/orders/${order.id}`);
    if (method === 'put') call = call.send({ status: 'cancelled' });
    await call.expect(404);
  }
  await pool.query("UPDATE products SET name = 'Changed', price_cents = 1, active = false WHERE id = $1", [first]);
  const read = (await a.agent.get(`/api/orders/${order.id}`).expect(200)).body.order;
  assert.equal(read.items[0].name, 'Desk Lamp');
  assert.equal(read.items[0].priceCents, 3499);
  assert.equal(read.totalCents, 7897);
});

test('declined simulated payment rolls back every write and allows retry', async () => {
  const a = await account();
  const productId = await product();
  const cartId = await cart(a.agent, [{ productId, quantity: 3 }]);
  const before = (await a.agent.get(`/api/carts/${cartId}`)).body.cart;
  await a.agent.post(`/api/carts/${cartId}/checkout`).send({ simulatePayment: null }).expect(400);
  const failed = await a.agent.post(`/api/carts/${cartId}/checkout`).send({ simulatePayment: 'fail' }).expect(402);
  assert.equal(failed.body.error.code, 'payment_failed');
  assert.equal(await stock(productId), 10);
  assert.equal(await orderCount(), 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM order_items')).rows[0].count), 0);
  assert.deepEqual((await a.agent.get(`/api/carts/${cartId}`)).body.cart, before);
  await a.agent.post(`/api/carts/${cartId}/checkout`).send({ simulatePayment: 'success' }).expect(201);
  assert.equal(await stock(productId), 7);
});

test('empty, inactive and insufficient-stock checkouts preserve database state', async () => {
  const a = await account();
  const productId = await product();
  const cartId = await cart(a.agent);
  await a.agent.post('/api/orders').send({ cartId }).expect(409);
  await a.agent.put(`/api/carts/${cartId}`).send({ items: [{ productId, quantity: 2 }] }).expect(200);
  await pool.query('UPDATE products SET stock = 1 WHERE id = $1', [productId]);
  await a.agent.post('/api/orders').send({ cartId }).expect(409);
  await pool.query('UPDATE products SET stock = 10, active = false WHERE id = $1', [productId]);
  await a.agent.post('/api/orders').send({ cartId }).expect(409);
  assert.equal(await stock(productId), 10);
  assert.equal(await orderCount(), 0);
  assert.equal((await a.agent.get(`/api/carts/${cartId}`)).body.cart.items[0].quantity, 2);
});

test('concurrent same-cart checkout creates one order; different buyers cannot oversell', async () => {
  const a = await account();
  const productId = await product({ stock: 3 });
  const cartId = await cart(a.agent, [{ productId, quantity: 1 }]);
  const same = await Promise.all([a.agent.post('/api/orders').send({ cartId }), a.agent.post('/api/orders').send({ cartId })]);
  assert.deepEqual(same.map(result => result.status).sort(), [201, 409]);
  assert.equal(await orderCount(), 1);
  assert.equal(await stock(productId), 2);
  const b = await account();
  const c = await account();
  const lastItem = await product({ stock: 1 });
  const bCart = await cart(b.agent, [{ productId: lastItem, quantity: 1 }]);
  const cCart = await cart(c.agent, [{ productId: lastItem, quantity: 1 }]);
  const competing = await Promise.all([b.agent.post('/api/orders').send({ cartId: bCart }), c.agent.post('/api/orders').send({ cartId: cCart })]);
  assert.deepEqual(competing.map(result => result.status).sort(), [201, 409]);
  assert.equal(await stock(lastItem), 0);
  assert.equal(await orderCount(), 2);
});

test('order cancellation restores stock once; deletion requires cancellation and retains history', async () => {
  const a = await account();
  const productId = await product();
  const cartId = await cart(a.agent, [{ productId, quantity: 2 }]);
  const order = (await a.agent.post('/api/orders').send({ cartId }).expect(201)).body.order;
  await a.agent.delete(`/api/orders/${order.id}`).expect(409);
  await a.agent.put(`/api/orders/${order.id}`).send({ status: 'placed' }).expect(400);
  await a.agent.put(`/api/orders/${order.id}`).send({ totalCents: 1 }).expect(400);
  assert.equal((await a.agent.put(`/api/orders/${order.id}`).send({ note: 'Updated' }).expect(200)).body.order.note, 'Updated');
  await pool.query('UPDATE products SET active = false WHERE id = $1', [productId]);
  const cancellations = await Promise.all([a.agent.put(`/api/orders/${order.id}`).send({ status: 'cancelled' }), a.agent.put(`/api/orders/${order.id}`).send({ status: 'cancelled' })]);
  assert.ok(cancellations.every(result => result.status === 200 && result.body.order.paymentStatus === 'simulated_refunded'));
  assert.equal(await stock(productId), 10);
  await a.agent.delete(`/api/orders/${order.id}`).expect(204);
  await a.agent.get(`/api/orders/${order.id}`).expect(404);
  assert.equal((await a.agent.get('/api/orders')).body.orders.length, 0);
  assert.equal(await orderCount(), 1);
  assert.equal(await stock(productId), 10);
});

test('account deletion protects placed orders and revokes every session after cancellation', async () => {
  const a = await account();
  const secondSession = request.agent(app);
  await secondSession.post('/api/auth/login').send({ username: a.username, password }).expect(200);
  const productId = await product();
  const cartId = await cart(a.agent, [{ productId, quantity: 1 }]);
  const order = (await a.agent.post('/api/orders').send({ cartId })).body.order;
  await a.agent.delete(`/api/users/${a.user.id}`).expect(409);
  await a.agent.put(`/api/orders/${order.id}`).send({ status: 'cancelled' }).expect(200);
  await a.agent.delete(`/api/users/${a.user.id}`).expect(204);
  await a.agent.get('/api/auth/me').expect(401);
  await secondSession.get('/api/auth/me').expect(401);
  await request(app).post('/api/auth/login').send({ username: a.username, password }).expect(401);
  await request(app).post('/api/auth/register').send({ username: a.username, password, displayName: 'Replacement' }).expect(409);
  assert.equal(Number((await pool.query('SELECT count(*) FROM carts')).rows[0].count), 0);
  assert.equal(await orderCount(), 1);
});

test('account deletion racing checkout cannot orphan a placed order', async () => {
  const a = await account();
  const productId = await product();
  const cartId = await cart(a.agent, [{ productId, quantity: 1 }]);
  const [checkout, deletion] = await Promise.all([a.agent.post('/api/orders').send({ cartId }), a.agent.delete(`/api/users/${a.user.id}`)]);
  const user = (await pool.query('SELECT deleted_at FROM users WHERE id = $1', [a.user.id])).rows[0];
  if (checkout.status === 201) {
    assert.equal(deletion.status, 409);
    assert.equal(user.deleted_at, null);
    assert.equal(await stock(productId), 9);
  } else {
    assert.equal(deletion.status, 204);
    assert.equal(checkout.status, 401);
    assert.ok(user.deleted_at);
    assert.equal(await orderCount(), 0);
    assert.equal(await stock(productId), 10);
  }
});

test('request boundaries reject unsafe origins, malformed bodies and SQL-like identifiers; docs are served', async () => {
  const a = await account();
  await a.agent.post('/api/carts').set('Origin', 'https://untrusted.example').send({}).expect(403);
  await a.agent.post('/api/carts').set('Origin', 'http://localhost:3002').send({}).expect(201);
  await request(app).post('/api/auth/login').type('form').send({ username: 'sam', password }).expect(415);
  await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{').expect(400);
  await request(app).get('/api/products/1%20OR%201=1').expect(404);
  await request(app).get('/api/products/2147483648').expect(404);
  await request(app).get('/api/not-a-route').expect(404);
  assert.equal((await request(app).get('/health').expect(200)).body.status, 'ok');
  assert.equal((await request(app).get('/openapi.json').expect(200)).body.openapi, '3.0.3');
  assert.match((await request(app).get('/docs/').expect(200)).text, /Swagger UI/);
});
