-- Timeline scans are always scoped to one Companion and ordered by their durable sort key.
CREATE INDEX IF NOT EXISTS messages_chat_page ON messages(companion_id,created_at,sequence,id);
CREATE INDEX IF NOT EXISTS task_questions_chat_page ON task_questions(companion_id,created_at,id);
CREATE INDEX IF NOT EXISTS runs_chat_page ON runs(companion_id,created_at,id);
CREATE INDEX IF NOT EXISTS messages_run_assistant_page ON messages(run_id,created_at,sequence,id) WHERE role='assistant';
