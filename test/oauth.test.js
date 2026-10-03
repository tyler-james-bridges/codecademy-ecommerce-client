const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Pool } = require('pg');
const request = require('supertest');
const { databaseUrl } = require('../src/config');
const { createApp } = require('../src/app');
const { createGithubProvider } = require('../src/oauth');

let pool, app, dist, calls, failProvider;
const stores = [];
const secret = 'isolated-oauth-session-secret-at-least-32-characters';
const github = { clientId: 'test-client-id', clientSecret: 'test-client-secret',
  callbackUrl: 'http://localhost:3002/api/auth/github/callback' };
const provider = {
  authorizationUrl: (...args) => createGithubProvider(github).authorizationUrl(...args),
  async getIdentity(code, verifier) {
    calls.push({ code, verifier });
    if (failProvider) throw new Error('Provider diagnostics must never be reflected.');
    return { id: 24680, login: 'same_name', name: 'Fictional GitHub User' };
  },
};
function makeApp(options = {}) {
  const result = createApp({ pool, sessionSecret: secret, clientDist: dist, ...options });
  stores.push(result.locals.sessionStore);
  return result;
}

before(async () => {
  pool = new Pool({ connectionString: databaseUrl(true) });
  await pool.query(await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
  dist = await fs.mkdtemp(path.join(os.tmpdir(), 'ecommerce-oauth-spa-'));
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Isolated SPA</title>');
  app = makeApp({ github: { ...github, provider } });
});
beforeEach(async () => {
  await pool.query('TRUNCATE order_items, orders, cart_items, carts, products, users, sessions, oauth_states RESTART IDENTITY CASCADE');
  calls = []; failProvider = false;
});
after(async () => {
  for (const store of stores) await store.close();
  if (pool) await pool.end();
  if (dist) await fs.rm(dist, { recursive: true, force: true });
});
async function begin(agent) {
  const response = await agent.get('/api/auth/github').expect(302);
  const url = new URL(response.headers.location);
  return { state: url.searchParams.get('state'), url, response };
}
const finish = (agent, state, extra = {}) => agent.get('/api/auth/github/callback').query({ code: 'fictional-code', state, ...extra });

// Tests contact only the local app and dedicated PostgreSQL test database.
test('configuration, SPA routing and disabled integrations are explicit', async () => {
  const disabled = makeApp();
  assert.deepEqual((await request(disabled).get('/api/config').expect(200)).body,
    { githubLoginEnabled: false, stripeCheckoutEnabled: false, simulatedCheckoutEnabled: true });
  await request(disabled).get('/api/auth/github').expect(503);
  await request(disabled).get('/api/unknown').expect(404).expect('Content-Type', /json/);
  await request(disabled).get('/products/1').expect(200).expect(/Isolated SPA/);
  await request(disabled).get('/missing.js').expect(404);
  const production = makeApp({ production: true, origin: 'https://shop.example.invalid' });
  assert.equal((await request(production).get('/api/config')).body.simulatedCheckoutEnabled, false);
  assert.equal(production.get('trust proxy'), 1);
  const agent = request.agent(production);
  const registered = await agent.post('/api/auth/register').set('X-Forwarded-Proto', 'https').send({
    username: 'prod_fixture', password: 'Fictional-Password-123', displayName: 'Fixture' }).expect(201);
  assert.match(registered.headers['set-cookie'][0], /Secure/);
  const cookie = registered.headers['set-cookie'][0].split(';')[0];
  await request(production).post('/api/orders').set('Cookie', cookie).set('X-Forwarded-Proto', 'https').send({ cartId: 1 }).expect(403);
  await request(production).post('/api/carts/1/checkout').set('Cookie', cookie).set('X-Forwarded-Proto', 'https').send({}).expect(403);
});

test('authorization uses public identity, fixed redirect, expiring random state and S256 PKCE', async () => {
  const agent = request.agent(app);
  const started = await begin(agent);
  assert.equal(started.url.origin + started.url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(started.url.searchParams.get('scope'), '');
  assert.equal(started.url.searchParams.get('redirect_uri'), github.callbackUrl);
  assert.equal(started.url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(started.state, /^[A-Za-z0-9_-]{43}$/);
  const row = (await pool.query('SELECT * FROM oauth_states')).rows[0];
  assert.equal(row.state_hash, crypto.createHash('sha256').update(started.state).digest('hex'));
  assert.notEqual(row.state_hash, started.state);
  assert.equal(started.url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(row.verifier).digest('base64url'));
  const remaining = new Date(row.expires_at).getTime() - Date.now();
  assert.ok(remaining > 9 * 60 * 1000 && remaining <= 10 * 60 * 1000);
  const second = await begin(agent);
  assert.notEqual(second.state, started.state);
  assert.equal((await pool.query('SELECT * FROM oauth_states')).rowCount, 1);
});

test('successful OAuth rotates session, never auto-links by username, and reuses provider identity', async () => {
  await pool.query("INSERT INTO users (username,password_hash,display_name) VALUES ('same_name','unusable-test-hash','Existing Local User')");
  const agent = request.agent(app);
  const started = await begin(agent);
  const oldCookie = started.response.headers['set-cookie'][0].split(';')[0];
  const response = await finish(agent, started.state, { returnTo: 'https://untrusted.example.invalid' }).expect(302);
  assert.equal(response.headers.location, '/');
  assert.notEqual(response.headers['set-cookie'][0].split(';')[0], oldCookie);
  const user = (await agent.get('/api/auth/me').expect(200)).body.user;
  assert.notEqual(user.username, 'same_name');
  assert.equal(user.authProvider, 'github');
  await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  assert.equal((await pool.query('SELECT * FROM users')).rowCount, 2);
  const stored = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0];
  assert.match(stored.password_hash, /^\$2[aby]\$/);
  const other = request.agent(app);
  await finish(other, (await begin(other)).state).expect(302);
  assert.equal((await other.get('/api/auth/me')).body.user.id, user.id);
  assert.equal((await pool.query('SELECT * FROM oauth_identities')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM users')).rowCount, 2);
  assert.equal((await pool.query('SELECT * FROM oauth_states')).rowCount, 0);
});

test('wrong, cross-session and expired state never calls the provider', async () => {
  const agent = request.agent(app);
  const { state } = await begin(agent);
  for (const value of ['bad', 'x'.repeat(43)]) {
    assert.equal((await finish(agent, value)).headers.location, '/login?error=github_auth_failed');
  }
  await finish(request.agent(app), state).expect(302).expect('Location', '/login?error=github_auth_failed');
  await pool.query("UPDATE oauth_states SET expires_at=now()-interval '1 second'");
  await finish(agent, state).expect(302).expect('Location', '/login?error=github_auth_failed');
  assert.equal(calls.length, 0);
});

test('state is single-use across simultaneous callbacks and provider failures', async () => {
  const agent = request.agent(app);
  const { state } = await begin(agent);
  const results = await Promise.all([finish(agent, state), finish(agent, state)]);
  assert.deepEqual(results.map(result => result.headers.location).sort(), ['/', '/login?error=github_auth_failed'].sort());
  assert.equal(calls.length, 1);
  const failing = request.agent(app);
  const attempt = await begin(failing);
  failProvider = true;
  const response = await finish(failing, attempt.state);
  assert.equal(response.headers.location, '/login?error=github_auth_failed');
  assert.equal(response.text.includes('Provider diagnostics'), false);
  await finish(failing, attempt.state).expect(302);
  assert.equal(calls.length, 2);
  await failing.get('/api/auth/me').expect(401);
});

test('provider denial consumes state and a deleted identity cannot recreate its account', async () => {
  const denied = request.agent(app);
  const attempt = await begin(denied);
  await finish(denied, attempt.state, { error: 'access_denied' }).expect(302).expect('Location', '/login?error=github_auth_failed');
  await finish(denied, attempt.state).expect(302);
  assert.equal(calls.length, 0);
  const agent = request.agent(app);
  await finish(agent, (await begin(agent)).state).expect(302);
  await pool.query('UPDATE users SET deleted_at=now()');
  const again = request.agent(app);
  await finish(again, (await begin(again)).state).expect(302).expect('Location', '/login?error=github_auth_failed');
  await again.get('/api/auth/me').expect(401);
  assert.equal((await pool.query('SELECT * FROM users')).rowCount, 1);
});

test('official provider request wiring keeps secrets server-side and uses no external requests in tests', async () => {
  const requests = [];
  const injected = createGithubProvider({ ...github, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(requests.length === 1
      ? { access_token: 'test-token-only', scope: '' }
      : { id: 123, login: 'fictional', name: 'Fictional User', private_data: 'discard' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(await injected.getIdentity('test-code', 'test-verifier'), { id: 123, login: 'fictional', name: 'Fictional User' });
  assert.equal(requests[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(requests[0].options.body.get('code_verifier'), 'test-verifier');
  assert.equal(requests[0].options.body.get('client_secret'), github.clientSecret);
  assert.equal(requests[1].url, 'https://api.github.com/user');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-token-only');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[1].options.redirect, 'error');
});
