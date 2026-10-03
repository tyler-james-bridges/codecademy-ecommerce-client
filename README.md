# Desk & Dwelling — full-stack e-commerce

A React/Vite storefront backed by Express, PostgreSQL and cookie sessions. It includes a five-product catalog with original SVG illustrations, product details, registration/login, a saved cart, checkout, and order history/details. The API also provides owner/admin account, product, cart and order management.

## Run locally

Use Node **22.12+** or Node 24 LTS (tested with 24.21.0), plus PostgreSQL. This course workspace uses PostgreSQL 17 at `127.0.0.1:55432`, with separate `ecommerce_course` and `ecommerce_course_test` databases. Both already exist; do not recreate or reset them for ordinary startup.

For a fresh checkout, copy `.env.example` to a private `.env` (`chmod 600 .env`) and set the two database URLs and a random session secret of at least 32 characters. Create the two databases if needed. Preserve any existing private configuration.

```sh
npm ci --ignore-scripts
npm --prefix client ci
npm run db:deploy
npm run build:client
npm start
```

Open **http://localhost:3002**. The server serves the built client and API from the same origin, including client deep links. Local writes must match `APP_ORIGIN=http://localhost:3002`; use that hostname consistently. `npm run dev` watches backend files. For separate Vite development and its origin requirement, see [client/README.md](client/README.md).

`db:deploy` applies the schemas and adds the fictional catalog without replacing existing stock or creating an administrator. The optional `seed` command requires private administrator credentials and creates/updates that administrator; repeating it resets their password and revokes their sessions. The test suite prepares its own dedicated test database.

The active runtime copy is under `/private/tmp/codex-ecommerce-source-a4cddb` to avoid cloud-synced file delays. Its private `.client.env` can be loaded explicitly with `node --env-file=.client.env src/server.js`. Credentials are excluded from deliverable source. Reinstall dependencies if temporary runtime links are no longer available.

## Shopping and payment behavior

- Accounts use PostgreSQL-backed sessions. Registration signs in, login rotates the session, and logout clears it. Protected pages return through a validated local login destination.
- Cart quantities are 1–99; prices and totals use integer cents. The server checks ownership, current stock and current prices. Cart updates replace all lines.
- Without configured Stripe credentials, **development-only simulated checkout** is explicit in the UI. No card is collected and no money is charged. Its database transaction either saves the order, adjusts stock and clears the cart together, or rolls everything back.
- Configured Stripe uses **test-mode hosted Checkout only**, USD/card payments and a $0.50 minimum. Requests explicitly use API version `2026-08-26.dahlia`; the [Endive breaking change](https://docs.stripe.com/changelog#2026-09-30.endive) removed the explicit payment-method parameter used by this card-only integration. It never accepts a live key or live-mode event. The result is labeled “Stripe test payment verified · no real charge.” Orders stay pending until trusted provider verification.
- Pending Stripe orders reserve stock for their one-hour provider session. Cancellation expires the provider session before releasing the reservation. An uncertain provider response keeps the reservation; retry the same cart instead of assuming payment failed. A cached HTTP 400 rejection specifically identifying the removed `payment_method_types` parameter permits one renewed attempt, with its original key retained for audit; concurrent retries share the replacement key and fresh expiry. Other errors retain the original request and key. Unresolved sessions need trusted provider reconciliation. Paid Stripe orders cannot use the simulated cancellation/refund path; a Stripe refund integration is not included.

Shipping, tax calculation, password recovery and production operations are outside this course implementation.

## API reference

[Swagger UI](http://localhost:3002/docs/), [OpenAPI JSON](http://localhost:3002/openapi.json), and [database health](http://localhost:3002/health) remain available. Bodies are JSON; errors use `{error: {code, message}}`. Resource responses use `{user}`, `{product}`, `{cart}`, or `{order}`; collections use plural names.

| Area | Main routes |
| --- | --- |
| Configuration and authentication | `GET /api/config`; `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me` |
| GitHub sign-in | `GET /api/auth/github`; callback `/api/auth/github/callback` |
| Catalog and cart | `/api/products`, `/api/products/:id`, `/api/carts`, `/api/carts/:id` |
| Local simulated checkout | `POST /api/orders` with `{cartId, note, simulatePayment: "success"}`; `/api/carts/:id/checkout` alias |
| Stripe test checkout | `POST /api/checkout/sessions`; `/api/checkout/sessions/confirm`; `/api/checkout/sessions/cancel` |
| Stripe webhook | `POST /api/payments/webhook` — signature-verified raw body |
| Orders and accounts | `/api/orders`, `/api/orders/:id`, `/api/users`, `/api/users/:id` |

Missing authentication returns 401; forbidden administrator actions return 403; other users’ protected resources return 404. Conflicts return 409, invalid input 400, oversized bodies 413, and unsupported request media 415. Refer to the API specification for detailed CRUD contracts.

## Verification and external setup

```sh
npm test                    # API, OAuth and payment tests; dedicated real PostgreSQL database
npm run test:oauth          # Focused OAuth tests
npm run test:payments       # Focused payment tests
npm --prefix client test   # Cart bounds and safe auth-return logic
npm run build:client       # Production client build
```

The original 36 backend test groups passed against the dedicated PostgreSQL test database, along with the client production build and two cart/redirect tests. The latest payment recovery change passed 19 focused payment/SDK cases, including concurrent recovery, one-time renewal, unchanged retries after uncertain errors, and the pinned Stripe API header. The full suite was not rerun for that server-only change. Local browser checks also covered registration, protected routes, product search/details, cart persistence, simulated checkout, order history, logout and returning-user login.

The deployed course demo is [Desk & Dwelling](https://codecademy-storefront-tjb.onrender.com). Render deployment `82d5636` and the following external flows were verified on October 3, 2026:

- **GitHub:** public-identity consent, sign-in, session persistence after reload, sign-out, and repeat sign-in. The app does not link accounts by matching usernames or email addresses.
- **Stripe sandbox:** order 1 opened hosted Checkout; returning without payment canceled the order and retained the $8.99 notebook in the bag. Re-entering checkout created order 2; a test-card payment placed it, displayed “Stripe test payment verified · no real charge,” and emptied the bag.
- **Signed webhooks:** Stripe recorded HTTP 200 responses for `checkout.session.expired` at 13:34:58 UTC and `checkout.session.completed` at 13:35:28 UTC. These were sandbox events; no live payment was made.
- **Hosted API:** database health, the five-product catalog, secure session cookies, registration/login, authenticated reload, and logout/session revocation were verified. Production disables simulated checkout.

## Deployed configuration

The current Render service uses a dedicated `ecommerce_course` database on the existing shared PostgreSQL instance, reached through an external connection with `sslmode=verify-full`. `render.yaml` is an alternative fresh-install blueprint that provisions its own database; it is not a record of the deployed infrastructure.

Build: `npm ci && npm --prefix client ci --include=dev && npm --prefix client run build`. Start: `npm run db:deploy && npm start`. Health check: `/health`. Runtime: Node 24.21.0, `NODE_ENV=production`, and `APP_ORIGIN=https://codecademy-storefront-tjb.onrender.com`.

Private settings are `DATABASE_URL`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`. The GitHub callback is `/api/auth/github/callback` on the deployed origin; the Stripe webhook is `/api/payments/webhook`. Keep credentials in private environment settings. The deployment migration preserves existing stock and adds only the fictional catalog when missing; it does not create an administrator. Stripe remains test-only, and refunds are not implemented.
