BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_-]{3,32}$'),
  password_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS oauth_identities (
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_user_id TEXT NOT NULL CHECK (provider_user_id ~ '^[0-9]{1,20}$'),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id),
  UNIQUE (provider, user_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expire_idx ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE CHECK (length(sku) BETWEEN 1 AND 40),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS carts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'simulated_paid'
    CHECK (payment_status IN ('simulated_paid', 'simulated_refunded')),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK ((status = 'placed' AND payment_status = 'simulated_paid')
      OR (status = 'cancelled' AND payment_status = 'simulated_refunded')),
  CHECK (deleted_at IS NULL OR status = 'cancelled')
);
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

COMMIT;
