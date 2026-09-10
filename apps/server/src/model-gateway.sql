ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_provider text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_source text NOT NULL DEFAULT 'agent' CHECK(usage_source IN ('agent','gateway'));
CREATE TABLE IF NOT EXISTS model_gateway_requests (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 companion_id uuid NOT NULL REFERENCES companions(id) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('google','anthropic','openai','openrouter','zai','azure','deepseek')),
 model_id text NOT NULL,
 api text NOT NULL CHECK(api IN ('google-generative-ai','anthropic-messages','openai-responses','openai-completions')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'forwarding' CHECK(status IN ('forwarding','succeeded','failed','interrupted')),
 upstream_status integer,
 error_code text CHECK(error_code ~ '^[a-z0-9_]{1,80}$'),
 usage jsonb CHECK(usage IS NULL OR jsonb_typeof(usage)='object'),
 usage_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK(NOT usage_verified OR (usage IS NOT NULL AND status IN ('succeeded','failed')))
);
-- Existing installations keep every request tombstone and gain the Azure and DeepSeek routes.
ALTER TABLE model_gateway_requests DROP CONSTRAINT IF EXISTS model_gateway_requests_provider_check;
ALTER TABLE model_gateway_requests ADD CONSTRAINT model_gateway_requests_provider_check
 CHECK(provider IN ('google','anthropic','openai','openrouter','zai','azure','deepseek'));
CREATE UNIQUE INDEX IF NOT EXISTS model_gateway_one_active_request ON model_gateway_requests(run_id) WHERE status='forwarding';
CREATE INDEX IF NOT EXISTS model_gateway_billable_requests ON model_gateway_requests(finished_at,id) WHERE usage_verified;
