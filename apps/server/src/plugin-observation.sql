ALTER TABLE runs ADD COLUMN IF NOT EXISTS plugin_calls jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS plugin_call_version bigint CHECK (plugin_call_version >= 0);
