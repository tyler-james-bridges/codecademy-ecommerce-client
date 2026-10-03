const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { transaction } = require('./commerce');
const { ApiError } = require('./validation');

const CALLBACK_PATH = '/api/auth/github/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

function createGithubProvider({ clientId, clientSecret, callbackUrl, fetchImpl = fetch }) {
  return {
    authorizationUrl(state, challenge) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl,
        scope: '', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' });
      return url.toString();
    },
    async getIdentity(code, verifier) {
      const response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
          code, redirect_uri: callbackUrl, code_verifier: verifier }),
      });
      if (!response.ok) throw new Error('GitHub token exchange failed.');
      const token = await response.json();
      // This app needs only public identity, not repository or private email access.
      if (typeof token.access_token !== 'string' || !token.access_token || token.scope !== '') {
        throw new Error('GitHub did not return the requested public-identity authorization.');
      }
      const profileResponse = await fetchImpl('https://api.github.com/user', {
        redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`,
          'User-Agent': 'course-ecommerce-client', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!profileResponse.ok) throw new Error('GitHub identity lookup failed.');
      const profile = await profileResponse.json();
      // The access token is neither returned to the browser nor persisted.
      return { id: profile.id, login: profile.login, name: profile.name };
    },
  };
}

function githubEnabled(github) {
  return Boolean(github?.clientId && github?.clientSecret && github?.callbackUrl);
}

async function userForIdentity(pool, profile) {
  if (!profile || !Number.isSafeInteger(profile.id) || profile.id < 1 ||
      typeof profile.login !== 'string' || !profile.login.trim()) throw new Error('Invalid GitHub identity.');
  const subject = String(profile.id);
  return transaction(pool, async client => {
    // Serialize creation for one provider identity without linking by a mutable username.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`github:${subject}`]);
    const { rows } = await client.query(`SELECT u.* FROM oauth_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = 'github' AND i.provider_user_id = $1 FOR UPDATE OF u`, [subject]);
    if (rows[0]) {
      if (rows[0].deleted_at) throw new Error('Account is no longer available.');
      return rows[0];
    }
    const username = `gh_${crypto.randomBytes(12).toString('hex')}`;
    const displayName = Array.from(typeof profile.name === 'string' && profile.name.trim()
      ? profile.name.trim() : profile.login).slice(0, 80).join('');
    // Keep the existing NOT NULL password schema; nobody knows this random password.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const created = await client.query('INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *',
      [username, passwordHash, displayName]);
    await client.query("INSERT INTO oauth_identities (provider, provider_user_id, user_id) VALUES ('github', $1, $2)",
      [subject, created.rows[0].id]);
    return created.rows[0];
  });
}

function mountGithubOAuth(app, { pool, github, signIn }) {
  const enabled = githubEnabled(github);
  const provider = enabled ? github.provider || createGithubProvider(github) : null;
  app.get('/api/auth/github', async (req, res, next) => {
    if (!enabled) return next(new ApiError(503, 'github_unavailable', 'GitHub sign-in is not configured.'));
    try {
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      req.session.githubLoginPending = true;
      await saveSession(req);
      await pool.query('DELETE FROM oauth_states WHERE expires_at <= now() OR session_id = $1', [req.sessionID]);
      await pool.query('INSERT INTO oauth_states (state_hash, session_id, verifier, expires_at) VALUES ($1, $2, $3, $4)',
        [digest(state), req.sessionID, verifier, new Date(Date.now() + STATE_TTL_MS)]);
      res.redirect(provider.authorizationUrl(state, challenge));
    } catch (error) { next(error); }
  });
  app.get(CALLBACK_PATH, async (req, res) => {
    try {
      if (!enabled || typeof req.query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.query.state)) {
        throw new Error('Invalid OAuth state.');
      }
      // DELETE ... RETURNING makes state single-use even for simultaneous callbacks.
      const { rows } = await pool.query(`DELETE FROM oauth_states
        WHERE state_hash = $1 AND session_id = $2 AND expires_at > now() RETURNING verifier`,
      [digest(req.query.state), req.sessionID]);
      if (!rows[0]) throw new Error('Invalid or expired OAuth state.');
      delete req.session.githubLoginPending;
      await saveSession(req);
      if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 2048) {
        throw new Error('GitHub authorization was not completed.');
      }
      const identity = await provider.getIdentity(req.query.code, rows[0].verifier);
      const user = await userForIdentity(pool, identity);
      await signIn(req, user);
      res.redirect('/');
    } catch {
      // Never reflect provider diagnostics, tokens, codes, or a user-supplied redirect.
      res.redirect('/login?error=github_auth_failed');
    }
  });
}

module.exports = { mountGithubOAuth, createGithubProvider, githubEnabled, CALLBACK_PATH };
