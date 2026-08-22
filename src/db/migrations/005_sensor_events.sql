-- 005_sensor_events.sql — E2 sensor-spine event stream (hosted-bridge-modes
-- exploration plan §E2 = data-moat-strategy-brief.md W1, "the one pre-publish
-- piece"). Companion contract:
-- experiments/sorb-bridge-modes/contracts/{sensor-spine.md,sensor-events.schema.json}.
--
-- ⚠️ ASSUMED SHAPE: this table is meant to be owned/created by the sorb-cloud
-- agent's migration 010 (per the E2 task brief). That migration does not exist
-- in sorb-cloud yet at the time this was written, so this juice-side migration
-- provisions the EXACT shape juice's src/sensor.js writes to, so hosted mode
-- has something real to run against. If/when the cloud agent's migration 010
-- lands with a different column set, reconcile the two (rename this file's
-- migration id out of the way, e.g. to a no-op, rather than leaving two
-- competing CREATE TABLE IF NOT EXISTS definitions).
--
-- A separate stream from audit_log (001_core.sql) and evidence_events
-- (004_evidence_feed.sql) — see sensor-spine.md "Relationship to audit_log".
-- This is corpus training data (what happened to a token proposal), not an
-- admin/security trail and not the E5 conformance-evidence feed.
--
-- Idempotent (IF NOT EXISTS). Applied by src/db/migrate.js in lexical order.

-- chain_id threads proposal -> verify_result -> accept_reject -> (future)
-- runtime_outcome for ONE token-change cycle. Minted at POST /preview time
-- (src/sensor.js mintChainId) and stored alongside the preview so later
-- verify/accept-reject writes can look it up by preview id.
ALTER TABLE previews ADD COLUMN IF NOT EXISTS chain_id uuid;

-- sensor_events — the durable sensor-spine event stream (one row per event).
-- Mirrors the Envelope + per-type payload in sensor-events.schema.json:
--   envelope fields are real columns; type-specific fields live in `payload`
--   (jsonb), same pattern as evidence_events.payload.
-- RECONCILED to sorb-cloud's canonical migration 010_sensor_events.sql
-- (cloud owns the schema; its src/lib/sensorEvents.ts + tests are built to this
-- exact shape). Both files use CREATE TABLE IF NOT EXISTS with an IDENTICAL
-- column set so they are order-independent on the shared Postgres — whichever
-- of cloud's migrate.ts / juice's migrate.js runs first, the table is the same.
-- (runtime_outcome is RESERVED — sensor.js never writes it. consent MUST be
-- true past the hot path: sensor.js's isConsented() gate runs BEFORE this
-- insert. Never raw DOM/screenshots in payload — see sensor-spine.md.)
CREATE TABLE IF NOT EXISTS sensor_events (
  schema_version  integer NOT NULL DEFAULT 1,
  event_id        uuid PRIMARY KEY,
  chain_id        uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('A', 'B', 'C')),
  consent         boolean NOT NULL,
  ts              timestamptz NOT NULL,
  actor_role      text NOT NULL
                    CHECK (actor_role IN ('owner', 'admin', 'editor', 'viewer', 'system')),
  type            text NOT NULL
                    CHECK (type IN ('proposal', 'verify_result', 'accept_reject', 'runtime_outcome', 'conformance_snapshot_ref')),
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensor_events_chain_id_idx   ON sensor_events(chain_id);
CREATE INDEX IF NOT EXISTS sensor_events_org_id_ts_idx  ON sensor_events(org_id, ts);
