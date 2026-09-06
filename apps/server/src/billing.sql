CREATE TABLE IF NOT EXISTS billing_accounts (
  owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  subscription_status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_event_created bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subscription_status IS NULL OR subscription_status IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'))
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  object_id text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  companion_id uuid REFERENCES companions(id) ON DELETE SET NULL,
  operation_id text NOT NULL,
  category text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  stripe_delivery_status text NOT NULL DEFAULT 'pending' CHECK (stripe_delivery_status IN ('pending','sent','skipped')),
  stripe_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, operation_id),
  CHECK (length(operation_id) BETWEEN 1 AND 200),
  CHECK (length(category) BETWEEN 1 AND 80),
  CHECK (length(unit) BETWEEN 1 AND 40)
);
CREATE INDEX IF NOT EXISTS usage_ledger_owner_time_idx ON usage_ledger(owner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_pending_idx ON usage_ledger(stripe_delivery_status, created_at) WHERE stripe_delivery_status='pending';
