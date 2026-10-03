BEGIN;

-- Replace only the original course order lifecycle checks, preserving total,
-- note, soft-deletion and foreign-key constraints. Re-running is safe.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'placed', 'cancelled'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('simulated_paid', 'simulated_refunded', 'stripe_pending', 'stripe_paid', 'stripe_cancelled'));
ALTER TABLE orders ADD CONSTRAINT orders_check CHECK (
  (status = 'pending' AND payment_status = 'stripe_pending') OR
  (status = 'placed' AND payment_status IN ('simulated_paid', 'stripe_paid')) OR
  (status = 'cancelled' AND payment_status IN ('simulated_refunded', 'stripe_cancelled'))
);

CREATE TABLE IF NOT EXISTS checkout_payments (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  cart_id INTEGER REFERENCES carts(id) ON DELETE SET NULL,
  attempt_key UUID NOT NULL UNIQUE,
  session_id TEXT UNIQUE,
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'captured', 'released')),
  create_params JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reservation_state <> 'reserved' OR cart_id IS NOT NULL)
);
ALTER TABLE checkout_payments ADD COLUMN IF NOT EXISTS rejected_attempt_key UUID;
CREATE UNIQUE INDEX IF NOT EXISTS checkout_payments_one_reservation_per_cart
  ON checkout_payments(cart_id) WHERE reservation_state = 'reserved';
COMMIT;
