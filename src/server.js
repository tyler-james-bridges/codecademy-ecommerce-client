const { Pool } = require('pg');
const Stripe = require('stripe');
const { databaseUrl, appOrigin, githubConfig } = require('./config');
const { createApp } = require('./app');

function createStripeClient(secretKey, httpClient) {
  return new Stripe(secretKey, {
    // Endive removed explicit payment_method_types; retain this card-only contract.
    apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 1, timeout: 10000,
    ...(httpClient ? { httpClient } : {}),
  });
}

async function start() {
  const port = Number(process.env.PORT || 3002);
  const production = process.env.NODE_ENV === 'production';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const origin = appOrigin(port, production);
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
  if (stripeSecretKey && !stripeSecretKey.startsWith('sk_test_')) throw new Error('Only Stripe test-mode keys are supported.');
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    await pool.query('SELECT 1');
    const app = createApp({ pool, sessionSecret: process.env.SESSION_SECRET, origin, production,
      github: githubConfig(origin, production),
      stripe: stripeSecretKey ? createStripeClient(stripeSecretKey) : null,
      stripeSecretKey, stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '' });
    const server = app.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log(`E-commerce app ready on port ${port}; documentation at /docs.`));
    server.on('error', async () => { console.error('Server could not listen on the configured port.'); await pool.end(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => {
      await app.locals.sessionStore.close();
      await pool.end();
    }));
  } catch (error) { await pool.end(); throw error; }
}
if (require.main === module) start().catch(() => {
  console.error('Startup failed; check private configuration and database setup.');
  process.exitCode = 1;
});
module.exports = { start, createStripeClient };
