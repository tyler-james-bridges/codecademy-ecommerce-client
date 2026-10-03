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
- Pending Stripe orders reserve stock for their one-hour provider session. Cancellation expires the provider session before releasing the reservation. An uncertain provider response keeps the reservation; retry the same cart instead of assuming payment failed. Unresolved sessions need trusted provider reconciliation. Paid Stripe orders cannot use the simulated cancellation/refund path; a Stripe refund integration is not included.

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

All 36 backend test groups passed against the dedicated PostgreSQL test database. The client production build and two cart/redirect tests passed. Browser verification passed registration, protected-page redirection, product search/details, a two-item cart surviving reload, a $17.98 simulated order, order history, logout and returning-user login. Provider tests inject controlled GitHub/Stripe responses; payment tests also exercise Stripe’s real webhook signature verifier. A focused SDK regression also verifies the pinned outgoing API-version header and preserves the request body and idempotency key when retrying after a validation error. These checks do **not** establish a completed external provider round trip.

The following remain pending real credentials, authorization and external verification:

- **GitHub:** register/authorize an OAuth app and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and the exact callback URL. The implementation requests public identity only and never links accounts by matching a username/email. The client explains when GitHub sign-in is not configured.
- **Stripe sandbox:** supply a test secret key and webhook secret. Configure `checkout.session.completed` and `checkout.session.expired` at `/api/payments/webhook`, then verify hosted Checkout, return confirmation, cancellation and signed webhooks against Stripe. No live charges are supported.
- **Render:** review `render.yaml`, choose the repository/account, set the actual HTTPS `APP_ORIGIN` and private environment values, then authorize deployment. The deployment setup seeds only the public catalog, not an administrator. Production disables simulated checkout. No hosted deployment has been completed or verified.
