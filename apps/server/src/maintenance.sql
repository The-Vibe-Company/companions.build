CREATE TABLE IF NOT EXISTS maintenance_actions (
 id uuid PRIMARY KEY,grant_id uuid NOT NULL REFERENCES companion_maintenance_grants(delivery_id),
 actor_id text NOT NULL REFERENCES "user"(id),companion_id uuid NOT NULL REFERENCES companions(id),
 operation text NOT NULL CHECK(operation IN ('configure','prepare','task')),
 run_id uuid REFERENCES runs(id),created_at timestamptz NOT NULL DEFAULT now()
);
