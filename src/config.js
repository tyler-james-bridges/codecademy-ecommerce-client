const path = require('node:path');
// Explicit process configuration (including node --env-file) avoids a second file read.
if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}

function databaseUrl(test = false) {
  const value = process.env[test ? 'TEST_DATABASE_URL' : 'DATABASE_URL'];
  if (!value) throw new Error('Database connection configuration is missing.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL connection is required.');
  const database = decodeURIComponent(url.pathname.slice(1));
  // Production accepts the dedicated database URL injected by the hosting platform.
  // Destructive tests always retain the exact named test-database guard.
  if (test || process.env.NODE_ENV !== 'production') {
    if (database !== (test ? 'ecommerce_course_test' : 'ecommerce_course')) {
      throw new Error('Refusing to use a database outside this ecommerce project.');
    }
  }
  return value;
}

function appOrigin(port, production) {
  if (production && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required in production.');
  const url = new URL(process.env.APP_ORIGIN || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || (production && url.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be the application origin (HTTPS in production).');
  }
  return url.origin;
}

function githubConfig(origin, production) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const callback = new URL(process.env.GITHUB_CALLBACK_URL || '/api/auth/github/callback', origin);
  if (callback.pathname !== '/api/auth/github/callback' || callback.search || callback.hash ||
      callback.username || callback.password || !['http:', 'https:'].includes(callback.protocol) ||
      (production && callback.origin !== origin) ||
      (!production && callback.origin !== origin && !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname))) {
    throw new Error('GitHub callback must use this app origin, or a local development backend.');
  }
  return { clientId, clientSecret, callbackUrl: callback.toString() };
}
module.exports = { databaseUrl, appOrigin, githubConfig };
