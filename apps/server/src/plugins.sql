CREATE TABLE IF NOT EXISTS plugin_accounts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider text NOT NULL,
 label text NOT NULL, server_id text, credential_secret text NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugin_owner ON plugin_accounts(owner_id);
CREATE TABLE IF NOT EXISTS companion_plugins (
 companion_id uuid NOT NULL REFERENCES companions(id), account_id uuid NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
 PRIMARY KEY(companion_id,account_id)
);
CREATE TABLE IF NOT EXISTS plugin_oauth_flows (
 state_hash text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
 flow_secret text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
