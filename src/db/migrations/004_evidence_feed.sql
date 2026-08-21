-- 004_evidence_feed.sql — Sorb-for-Enterprise E5 continuous conformance-EVIDENCE
-- feed substrate. DARK BY DEFAULT.
--
-- These tables are the durable data path for the E5 stream. They compose three
-- already-present substrates into one descriptive evidence stream:
--   1. POST /verify/app     — the running-app token check result (published),
--   2. verify_events        — per-/verify telemetry (002_verifications.sql),
--   3. captureError (Sentry)— operational signals captured on the hosted path.
--
-- ⚠️ HELD SURFACE. The customer-facing feed exposure is gated OFF by default
-- (config.enterpriseFeedEnabled ← SORB_ENTERPRISE_FEED). With the flag unset,
-- NOTHING is written to these tables, no feed endpoint answers, and no row in
-- feed_subscriptions is ever delivered to. This migration only provisions the
-- storage; it changes no runtime behavior on its own.
--
-- THREE HARD GATES — ALL must clear before the flag is set on any deployed env
-- (sorb-enterprise-program.md §4 → E5):
--   [ ] Tech E&O + Cyber insurance BOUND ($1–2M limits)
--   [ ] GA Terms of Service reviewed by a real contracts attorney
--   [ ] SOC 2 in-flight or complete
--
-- Every stored `kind`/`payload` is a MEASUREMENT-register descriptor (what was
-- checked / captured), never an outcome claim (claims-codex.md).
--
-- Idempotent (IF NOT EXISTS). Applied by src/db/migrate.js in lexical order.

-- evidence_events — the durable conformance-EVIDENCE stream (one row per event).
CREATE TABLE IF NOT EXISTS evidence_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment  text NOT NULL DEFAULT 'prod'
                 CHECK (environment IN ('dev', 'stage', 'prod')),
  -- Measurement-register event kind: 'app-check' | 'declared-vs-resolved' | 'signal'.
  kind         text NOT NULL,
  story_id     text,
  -- Descriptive measurement payload (checked/matched counts, the 'at' tag for a
  -- signal, etc.). Never an outcome verdict.
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_events_project_env_idx
  ON evidence_events(project_id, environment);
CREATE INDEX IF NOT EXISTS evidence_events_recorded_at_idx
  ON evidence_events(recorded_at);

-- feed_subscriptions — the (DORMANT) subscription registry. `active` defaults to
-- false and NO delivery transport is wired to `endpoint` in code: even a row
-- with active=true is never delivered to while the feed flag is off, and the
-- delivery path has no external destination wired regardless (plumbing only).
CREATE TABLE IF NOT EXISTS feed_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment  text NOT NULL DEFAULT 'prod'
                 CHECK (environment IN ('dev', 'stage', 'prod')),
  endpoint     text,
  active       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feed_subscriptions_project_idx
  ON feed_subscriptions(project_id);
