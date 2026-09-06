ALTER TABLE companions ADD COLUMN IF NOT EXISTS avatar jsonb NOT NULL DEFAULT '{"shape":0,"color":0,"face":0}';
ALTER TABLE companions ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES companions(id);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS temporary boolean NOT NULL DEFAULT false;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS prepare_requested boolean NOT NULL DEFAULT false;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS desktop_taken boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS control_commands (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companions(id), run_id uuid NOT NULL REFERENCES runs(id),
 operation text NOT NULL, status text NOT NULL DEFAULT 'claimed', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS task_questions (
 id uuid PRIMARY KEY, companion_id uuid NOT NULL REFERENCES companions(id), run_id uuid NOT NULL REFERENCES runs(id),
 question text NOT NULL, options jsonb NOT NULL DEFAULT '[]', answer text,
 created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);

ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS result_secret text;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS preview_text text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage jsonb;
