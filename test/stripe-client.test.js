const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { createStripeClient } = require('../src/server');

test('Stripe requests pin the card-compatible API and preserve a failed attempt on retry', async () => {
  const attempts = [];
  const httpClient = Stripe.createFetchHttpClient(async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.stripe.com');
    assert.equal(new URL(url).pathname, '/v1/checkout/sessions');
    const headers = new Headers(options.headers);
    attempts.push({ version: headers.get('stripe-version'), key: headers.get('idempotency-key'), body: options.body });
    const invalid = attempts.length === 1;
    return new Response(JSON.stringify(invalid
      ? { error: { type: 'invalid_request_error', message: 'Injected pre-execution parameter validation failure.', param: 'payment_method_types' } }
      : { id: 'cs_test_retry_fixture', object: 'checkout.session', status: 'open', livemode: false }), {
      status: invalid ? 400 : 200,
      headers: { 'Content-Type': 'application/json', 'Request-Id': `req_fixture_${attempts.length}` },
    });
  });
  const stripe = createStripeClient('sk_test_course_fixture', httpClient);
  const savedRequest = {
    mode: 'payment', payment_method_types: ['card'],
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 899, product_data: { name: 'Fixture notebook' } } }],
    client_reference_id: '1', metadata: { orderId: '1', paymentAttempt: 'fixture-attempt' },
    success_url: 'https://example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://example.com/checkout/cancel?order_id=1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  const original = structuredClone(savedRequest);
  const options = { idempotencyKey: 'fixture-attempt' };
  await assert.rejects(stripe.checkout.sessions.create(savedRequest, options), error => error.statusCode === 400);
  const recovered = await stripe.checkout.sessions.create(savedRequest, options);
  assert.equal(recovered.id, 'cs_test_retry_fixture');
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.equal(attempt.version, '2026-08-26.dahlia');
    assert.equal(attempt.key, 'fixture-attempt');
    const encoded = new URLSearchParams(attempt.body);
    assert.equal(encoded.get('payment_method_types[0]'), 'card');
    assert.equal(encoded.get('metadata[paymentAttempt]'), 'fixture-attempt');
    assert.equal(encoded.get('expires_at'), String(original.expires_at));
  }
  assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual(savedRequest, original);
});
