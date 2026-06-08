-- 002_verifications.sql — verify-event telemetry for the hosted bridge.
--
-- Tracks every POST /verify call in hosted mode so the beta can measure
-- the moat-proof retention question: "do real teams verify regularly?"
-- Proxy metric: weekly active verify events per project.
--
-- Idempotent (IF NOT EXISTS). Applied by src/db/migrate.js in order.

-- verify_events (id, project_id, story_id, bound_fields, called_at)
CREATE TABLE IF NOT EXISTS verify_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id      text,
  bound_fields  int,
  called_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verify_events_project_id_idx ON verify_events(project_id);
CREATE INDEX IF NOT EXISTS verify_events_called_at_idx  ON verify_events(called_at);
