-- Mail identities are retained after retirement; uniqueness prevents address reuse.
CREATE TABLE IF NOT EXISTS companion_mail_accounts (
 owner_id text PRIMARY KEY REFERENCES "user"(id), alias text NOT NULL UNIQUE CHECK(alias ~ '^[a-z][a-z0-9-]{2,29}$'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS companion_mailboxes (
 companion_id uuid PRIMARY KEY REFERENCES companions(id), owner_id text NOT NULL REFERENCES companion_mail_accounts(owner_id), local_name text NOT NULL CHECK(local_name ~ '^[a-z][a-z0-9-]{1,29}$'), address text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,local_name)
);
CREATE TABLE IF NOT EXISTS companion_mail_senders (
 companion_id uuid NOT NULL REFERENCES companion_mailboxes(companion_id), email text NOT NULL, PRIMARY KEY(companion_id,email)
);
CREATE TABLE IF NOT EXISTS companion_mail_threads (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companion_mailboxes(companion_id), reply_token text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(companion_id,id)
);
CREATE TABLE IF NOT EXISTS companion_mail_thread_grants (
 thread_id uuid NOT NULL REFERENCES companion_mail_threads(id), email text NOT NULL, PRIMARY KEY(thread_id,email)
);
CREATE TABLE IF NOT EXISTS companion_mail_messages (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companion_mailboxes(companion_id), thread_id uuid REFERENCES companion_mail_threads(id), direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 state text NOT NULL CHECK(state IN ('received','fetching','ignored','ready','draft','queued','sending','sent','quota_exceeded','failed','ambiguous','cancelled')),
 provider_id text, webhook_id text UNIQUE, message_id text, sender text NOT NULL, recipients jsonb NOT NULL DEFAULT '[]', cc jsonb NOT NULL DEFAULT '[]', bcc jsonb NOT NULL DEFAULT '[]', subject text NOT NULL DEFAULT '', body_text text NOT NULL DEFAULT '', body_html text NOT NULL DEFAULT '', attachments jsonb NOT NULL DEFAULT '[]',
 run_id uuid REFERENCES runs(id), client_id uuid, approved_at timestamptz, send_after timestamptz, attempted_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), error_code text, fetch_attempts integer NOT NULL DEFAULT 0, next_fetch_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(companion_id,client_id), UNIQUE(companion_id,provider_id,direction)
);
CREATE INDEX IF NOT EXISTS companion_mail_work ON companion_mail_messages(state,next_fetch_at,received_at);
CREATE TABLE IF NOT EXISTS companion_mail_quota (
 owner_id text NOT NULL REFERENCES companion_mail_accounts(owner_id), day date NOT NULL, used integer NOT NULL CHECK(used BETWEEN 0 AND 50), PRIMARY KEY(owner_id,day)
);
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_source_check;
ALTER TABLE runs ADD CONSTRAINT runs_source_check CHECK(source IN ('chat','routine','trigger','delegation','email'));
