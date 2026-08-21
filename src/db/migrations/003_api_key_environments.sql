-- 003_api_key_environments.sql — per-environment API keys (E4).
--
-- Adds a dev | stage | prod environment dimension to api_keys so one project
-- can carry separate keys per environment (src/apiKeys.js). Existing keys have
-- no environment; they backfill to 'prod' to preserve today's single-key
-- behavior (a live hosted key keeps authenticating exactly as before).
--
-- The staging-first / prod-protected policy lives in the model layer
-- (src/apiKeys.js): a new key defaults to 'stage', and minting/revoking a 'prod'
-- key requires an explicit opt-in. This migration only adds the storage column.
--
-- Idempotent (IF NOT EXISTS on the column add). Applied by src/db/migrate.js.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'prod'
    CHECK (environment IN ('dev', 'stage', 'prod'));

-- Keys are looked up per (project, environment); index the pair so per-env
-- listing/validation stays cheap as key counts grow.
CREATE INDEX IF NOT EXISTS api_keys_project_env_idx ON api_keys(project_id, environment);
