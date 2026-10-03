const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const swaggerUi = require('swagger-ui-express');
const spec = require('../openapi.json');
const path = require('node:path');
const fs = require('node:fs');
const { mountGithubOAuth, githubEnabled } = require('./oauth');
const { createPayments } = require('./payments');
const v = require('./validation');
const c = require('./commerce');

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const sessionCall = (req, method) => new Promise((resolve, reject) => req.session[method](error => error ? reject(error) : resolve()));

function createApp({ pool, sessionSecret, origin = 'http://localhost:3002', production = false,
  github = null, stripe = null, stripeSecretKey = '', stripeWebhookSecret = '',
  clientDist = path.join(__dirname, '../client/dist') }) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('A private session secret of at least 32 characters is required.');
  const app = express();
  const servedSpec = { ...spec, servers: [{ url: '/', description: 'Current server' }] };
  app.disable('x-powered-by');
  if (production) app.set('trust proxy', 1);
  const stripeCheckoutEnabled = Boolean(stripe && stripeSecretKey.startsWith('sk_test_') && stripeWebhookSecret);
  const simulatedCheckoutEnabled = !production && !stripeCheckoutEnabled;
  const payments = createPayments({ pool, stripe, secretKey: stripeSecretKey,
    webhookSecret: stripeWebhookSecret, appOrigin: origin });
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (production) res.set('Strict-Transport-Security', 'max-age=15552000');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  // Stripe verifies signatures over the original bytes, before JSON parsing.
  app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), payments.webhook);
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') && req.get('Origin') !== origin) {
      return next(new v.ApiError(403, 'origin_rejected', 'This request origin is not allowed.'));
    }
    if (['POST', 'PUT', 'PATCH'].includes(req.method) &&
        (Number(req.get('Content-Length')) > 0 || req.get('Transfer-Encoding')) && !req.is('application/json')) {
      return next(new v.ApiError(415, 'unsupported_media_type', 'Send request bodies as application/json.'));
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const store = new PgSession({ pool, tableName: 'sessions', createTableIfMissing: false,
    errorLog: () => console.error('Session storage operation failed.') });
  app.locals.sessionStore = store;
  app.use(session({ store, name: 'ecommerce.sid', secret: sessionSecret,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 7 * 24 * 60 * 60 * 1000 } }));

  const auth = asyncRoute(async (req, res, next) => {
    if (!req.session.userId) v.fail(401, 'unauthenticated', 'Sign in to continue.');
    const { rows } = await pool.query(`SELECT u.*, EXISTS (SELECT 1 FROM oauth_identities i WHERE i.user_id = u.id) AS has_github_identity
      FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`, [req.session.userId]);
    if (!rows[0] || rows[0].credential_version !== req.session.credentialVersion) v.fail(401, 'unauthenticated', 'Sign in to continue.');
    req.user = rows[0];
    next();
  });
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : next(new v.ApiError(403, 'forbidden', 'Administrator access is required.'));
  async function signIn(req, user) {
    await sessionCall(req, 'regenerate');
    req.session.userId = user.id;
    // A delayed login using an old password cannot revive a revoked session.
    req.session.credentialVersion = user.credential_version;
    await sessionCall(req, 'save');
  }
  function ownId(req) {
    const userId = v.id(req.params.id);
    if (userId !== req.user.id) v.fail(404, 'not_found', 'Account not found.');
    return userId;
  }

  mountGithubOAuth(app, { pool, github, signIn });
  app.get('/api/config', (req, res) => res.json({ githubLoginEnabled: githubEnabled(github),
    stripeCheckoutEnabled, simulatedCheckoutEnabled }));
  app.post('/api/checkout/sessions', auth, payments.createSession);
  app.post('/api/checkout/sessions/confirm', auth, payments.confirmSession);
  app.post('/api/checkout/sessions/cancel', auth, payments.cancelSession);

  app.get('/health', asyncRoute(async (req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }));
  app.get('/openapi.json', (req, res) => res.json(servedSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(servedSpec));

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    v.object(req.body, ['username', 'password', 'displayName'], ['username', 'password', 'displayName']);
    const username = v.username(req.body.username);
    const password = v.password(req.body.password);
    const displayName = v.text(req.body.displayName, 'displayName', 80);
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query('INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *', [username, hash, displayName]);
    await signIn(req, rows[0]);
    res.status(201).json({ user: c.userDto(rows[0]) });
  }));
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    v.object(req.body, ['username', 'password'], ['username', 'password']);
    const username = v.username(req.body.username);
    v.password(req.body.password);
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND deleted_at IS NULL', [username]);
    const user = rows[0];
    if (!user || !await bcrypt.compare(req.body.password, user.password_hash)) v.fail(401, 'invalid_credentials', 'Username or password is incorrect.');
    await signIn(req, user);
    res.json({ user: c.userDto(user) });
  }));
  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    await sessionCall(req, 'destroy');
    res.clearCookie('ecommerce.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: production });
    res.sendStatus(204);
  }));
  app.get('/api/auth/me', auth, (req, res) => res.json({ user: { ...c.userDto(req.user),
    authProvider: req.user.has_github_identity ? 'github' : 'password' } }));

  app.get('/api/users', auth, admin, asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id');
    res.json({ users: rows.map(c.userDto) });
  }));
  app.get('/api/users/:id', auth, asyncRoute(async (req, res) => {
    const userId = v.id(req.params.id);
    if (userId !== req.user.id && req.user.role !== 'admin') v.fail(404, 'not_found', 'Account not found.');
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (!rows[0]) v.fail(404, 'not_found', 'Account not found.');
    res.json({ user: c.userDto(rows[0]) });
  }));
  app.put('/api/users/:id', auth, asyncRoute(async (req, res) => {
    const userId = ownId(req);
    const body = v.object(req.body, ['username', 'displayName', 'password', 'currentPassword']);
    if (!['username', 'displayName', 'password'].some(key => Object.hasOwn(body, key))) v.fail(400, 'invalid_input', 'Provide an account field to update.');
    const username = body.username === undefined ? undefined : v.username(body.username);
    const displayName = body.displayName === undefined ? undefined : v.text(body.displayName, 'displayName', 80);
    const password = body.password === undefined ? undefined : v.password(body.password);
    if (username !== undefined || password !== undefined) v.password(body.currentPassword);
    const user = await c.transaction(pool, async client => {
      const current = await c.lockUser(client, userId);
      if ((username !== undefined || password !== undefined) && !await bcrypt.compare(body.currentPassword, current.password_hash)) {
        v.fail(401, 'invalid_credentials', 'Current password is incorrect.');
      }
      const hash = password === undefined ? current.password_hash : await bcrypt.hash(password, 10);
      const { rows } = await client.query('UPDATE users SET username = $1, display_name = $2, password_hash = $3, credential_version = credential_version + $5 WHERE id = $4 RETURNING *',
        [username ?? current.username, displayName ?? current.display_name, hash, userId, password === undefined ? 0 : 1]);
      if (password !== undefined) await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1", [String(userId)]);
      return rows[0];
    });
    if (password !== undefined) await signIn(req, user);
    res.json({ user: c.userDto(user) });
  }));
  app.delete('/api/users/:id', auth, asyncRoute(async (req, res) => {
    const userId = ownId(req);
    await c.transaction(pool, async client => {
      await c.lockUser(client, userId);
      const { rows } = await client.query("SELECT id FROM orders WHERE user_id = $1 AND status IN ('placed', 'pending') LIMIT 1", [userId]);
      if (rows.length) v.fail(409, 'open_orders', 'Resolve pending or placed orders before deleting the account.');
      await client.query('DELETE FROM carts WHERE user_id = $1', [userId]);
      await client.query('UPDATE users SET deleted_at = now() WHERE id = $1', [userId]);
      await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1", [String(userId)]);
    });
    await sessionCall(req, 'destroy');
    res.clearCookie('ecommerce.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: production });
    res.sendStatus(204);
  }));

  app.get('/api/products', asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE active ORDER BY id');
    res.json({ products: rows.map(c.productDto) });
  }));
  app.get('/api/products/:id', asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1 AND active', [v.id(req.params.id)]);
    if (!rows[0]) v.fail(404, 'not_found', 'Product not found.');
    res.json({ product: c.productDto(rows[0]) });
  }));
  app.post('/api/products', auth, admin, asyncRoute(async (req, res) => {
    const input = v.productInput(req.body);
    const { rows } = await pool.query(`INSERT INTO products (sku, name, description, price_cents, stock)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [input.sku, input.name, input.description ?? '', input.price_cents, input.stock]);
    res.status(201).json({ product: c.productDto(rows[0]) });
  }));
  app.put('/api/products/:id', auth, admin, asyncRoute(async (req, res) => {
    const productId = v.id(req.params.id);
    const input = v.productInput(req.body, true);
    const { rows } = await pool.query(`UPDATE products SET sku = COALESCE($1, sku), name = COALESCE($2, name),
      description = COALESCE($3, description), price_cents = COALESCE($4, price_cents), stock = COALESCE($5, stock)
      WHERE id = $6 AND active RETURNING *`, [input.sku, input.name, input.description, input.price_cents, input.stock, productId]);
    if (!rows[0]) v.fail(404, 'not_found', 'Product not found.');
    res.json({ product: c.productDto(rows[0]) });
  }));
  app.delete('/api/products/:id', auth, admin, asyncRoute(async (req, res) => {
    const { rowCount } = await pool.query('UPDATE products SET active = false WHERE id = $1 AND active', [v.id(req.params.id)]);
    if (!rowCount) v.fail(404, 'not_found', 'Product not found.');
    res.sendStatus(204);
  }));

  app.get('/api/carts', auth, asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT id FROM carts WHERE user_id = $1 ORDER BY id', [req.user.id]);
    res.json({ carts: await Promise.all(rows.map(row => c.cartDto(pool, row.id, req.user.id))) });
  }));
  app.post('/api/carts', auth, asyncRoute(async (req, res) => {
    v.object(req.body ?? {}, []);
    const cart = await c.transaction(pool, async client => {
      await c.lockUser(client, req.user.id);
      const { rows } = await client.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [req.user.id]);
      return c.cartDto(client, rows[0].id, req.user.id);
    });
    res.status(201).json({ cart });
  }));
  app.get('/api/carts/:id', auth, asyncRoute(async (req, res) => res.json({ cart: await c.cartDto(pool, v.id(req.params.id), req.user.id) })));
  app.put('/api/carts/:id', auth, asyncRoute(async (req, res) => {
    const cartId = v.id(req.params.id);
    const items = v.cartItems(req.body);
    const cart = await c.transaction(pool, async client => {
      await c.lockUser(client, req.user.id);
      await c.lockCart(client, cartId, req.user.id);
      if (stripeCheckoutEnabled) await payments.assertCartAvailable(client, cartId);
      const { rows } = await client.query('SELECT * FROM products WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE', [items.map(item => item.productId)]);
      for (const item of items) {
        const product = rows.find(row => row.id === item.productId);
        if (!product || !product.active) v.fail(404, 'not_found', 'Product not found.');
        if (item.quantity > product.stock) v.fail(409, 'stock_unavailable', 'A product has insufficient stock.');
      }
      await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
      for (const item of items) await client.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)', [cartId, item.productId, item.quantity]);
      return c.cartDto(client, cartId, req.user.id);
    });
    res.json({ cart });
  }));
  app.delete('/api/carts/:id', auth, asyncRoute(async (req, res) => {
    const cartId = v.id(req.params.id);
    await c.transaction(pool, async client => {
      await c.lockUser(client, req.user.id);
      await c.lockCart(client, cartId, req.user.id);
      if (stripeCheckoutEnabled) await payments.assertCartAvailable(client, cartId);
      await client.query('DELETE FROM carts WHERE id = $1', [cartId]);
    });
    res.sendStatus(204);
  }));

  function requireSimulation(req, res, next) {
    if (!simulatedCheckoutEnabled) return next(new v.ApiError(403, 'simulation_disabled', 'Use the configured payment checkout.'));
    next();
  }
  app.post('/api/orders', auth, requireSimulation, asyncRoute(async (req, res) => {
    const input = v.checkoutInput(req.body, true);
    res.status(201).json({ order: await c.checkout(pool, req.user.id, req.body.cartId, input) });
  }));
  app.post('/api/carts/:id/checkout', auth, requireSimulation, asyncRoute(async (req, res) => {
    const cartId = v.id(req.params.id);
    const input = v.checkoutInput(req.body ?? {}, false);
    res.status(201).json({ order: await c.checkout(pool, req.user.id, cartId, input) });
  }));
  app.get('/api/orders', auth, asyncRoute(async (req, res) => {
    const { rows } = await pool.query('SELECT id FROM orders WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id', [req.user.id]);
    res.json({ orders: await Promise.all(rows.map(row => c.orderDto(pool, row.id, req.user.id))) });
  }));
  app.get('/api/orders/:id', auth, asyncRoute(async (req, res) => res.json({ order: await c.orderDto(pool, v.id(req.params.id), req.user.id) })));
  app.put('/api/orders/:id', auth, asyncRoute(async (req, res) => {
    const orderId = v.id(req.params.id);
    const input = v.object(req.body, ['status', 'note']);
    if (!Object.keys(input).length || (Object.hasOwn(input, 'status') && input.status !== 'cancelled')) v.fail(400, 'invalid_input', 'Only cancellation and notes can be updated.');
    if (input.note !== undefined) v.text(input.note, 'note', 500, 0);
    res.json({ order: await c.updateOrder(pool, req.user.id, orderId, input) });
  }));
  app.delete('/api/orders/:id', auth, asyncRoute(async (req, res) => {
    await c.updateOrder(pool, req.user.id, v.id(req.params.id), {}, true);
    res.sendStatus(204);
  }));

  // API misses stay JSON; browser routes are handled by the built React client.
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found.' } }));
  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false }));
    app.get('*', (req, res, next) => {
      if (path.extname(req.path) || !req.accepts('html')) return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found.' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof v.ApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'body_too_large', message: 'Request body is too large.' } });
    if (error.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'This username, SKU or account cart already exists.' } });
    if (['23514', '22003', '23502'].includes(error.code)) return res.status(400).json({ error: { code: 'invalid_input', message: 'A value exceeds a database constraint.' } });
    console.error('Request failed unexpectedly.');
    res.status(500).json({ error: { code: 'internal_error', message: 'The request could not be completed.' } });
  });
  return app;
}

module.exports = { createApp };
