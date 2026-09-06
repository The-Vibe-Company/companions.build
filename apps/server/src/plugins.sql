CREATE TABLE IF NOT EXISTS plugin_accounts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider text NOT NULL,
 label text NOT NULL, server_id text, credential_secret text NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 health_status text NOT NULL DEFAULT 'unchecked', health_code text, health_checked_at timestamptz,
 CHECK (health_status IN ('unchecked','ok','error','requires_agent')),
 CHECK (health_code IS NULL OR health_code IN ('authorization_required','connection_failed','configuration_invalid','agent_check_required'))
);
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unchecked';
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_code text;
ALTER TABLE plugin_accounts ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
ALTER TABLE plugin_accounts DROP CONSTRAINT IF EXISTS plugin_accounts_health_status_check;
ALTER TABLE plugin_accounts ADD CONSTRAINT plugin_accounts_health_status_check CHECK (health_status IN ('unchecked','ok','error','requires_agent'));
ALTER TABLE plugin_accounts DROP CONSTRAINT IF EXISTS plugin_accounts_health_code_check;
ALTER TABLE plugin_accounts ADD CONSTRAINT plugin_accounts_health_code_check CHECK (health_code IS NULL OR health_code IN ('authorization_required','connection_failed','configuration_invalid','agent_check_required'));
CREATE INDEX IF NOT EXISTS plugin_owner ON plugin_accounts(owner_id);
CREATE TABLE IF NOT EXISTS companion_plugins (
 companion_id uuid NOT NULL REFERENCES companions(id), account_id uuid NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
 PRIMARY KEY(companion_id,account_id)
);
CREATE TABLE IF NOT EXISTS plugin_oauth_flows (
 state_hash text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
 flow_secret text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
