# Desk & Dwelling storefront

React + Vite + React Router client for the existing commerce API. Original SVG product illustrations live in `public/images`. No credentials or payment secrets belong in the client.

```sh
npm ci
npm run build
npm test
```

The backend serves `dist` from the same origin at `http://localhost:3002`, including deep links. For separate development, `npm run dev` runs Vite on `127.0.0.1:3015` and proxies `/api` to `127.0.0.1:3002`; the backend must explicitly allow that development Origin. Use the same-origin built app for the course verification.

Routes: catalog (`/` and `/products`), product detail, registration/login, protected bag/checkout, payment return/cancel, and order history/detail. Login returns are limited to local store routes. GitHub uses the backend OAuth flow and returns to the catalog. Disabled integrations display a clear explanation.

Checkout configuration comes from `/api/config`. Stripe starts at `POST /api/checkout/sessions`, confirms at `/api/checkout/sessions/confirm`, and cancels at `/api/checkout/sessions/cancel`. Confirmation sends `sessionId`; cancellation accepts the server’s `order_id` return parameter or a `session_id`. Stripe is test-only: its result is labeled as a verified test payment with no real charge, and payment remains pending until verified. When explicitly enabled by the backend, local simulated orders use `POST /api/orders` and are labeled as simulations with no real charge.

Tests cover safe local auth-return paths and cart replacement/removal with stock and integer-quantity bounds. The backend remains authoritative for stock, ownership, prices, and payment status.
