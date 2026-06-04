-- 001_init.sql — initial hosted-bridge schema.
-- Mirrors hosted-bridge-spec.md §5 "Data model (Postgres, first cut)".
--
-- Notes:
--   * Preview *payloads* live in Redis (TTL); this table holds metadata only.
--   * UUID primary keys via pgcrypto's gen_random_uuid(). Enabled below so the
--     migration is self-contained on a fresh database.
--   * Applied atomically by src/db/migrate.js inside one transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- organizations (id, name, created_at, stripe_customer_id, plan, status)
CREATE TABLE IF NOT EXISTS organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  stripe_customer_id  text,
  plan                text NOT NULL DEFAULT 'free',
  status              text NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- users (id, email, name, created_at)
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- memberships (org_id, user_id, role) -- owner | admin | member
CREATE TABLE IF NOT EXISTS memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships(user_id);

-- projects (id, org_id, namespace, name, allowed_origins[], created_at)
CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  namespace        text NOT NULL,
  name             text NOT NULL,
  allowed_origins  text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, namespace)
);

CREATE INDEX IF NOT EXISTS projects_org_id_idx ON projects(org_id);

-- api_keys (id, project_id, type, hash, last4, created_at, revoked_at)
--   type: secret | publishable
CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('secret', 'publishable')),
  hash        text NOT NULL,
  last4       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_project_id_idx ON api_keys(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(hash);

-- token_commits (id, project_id, resolved_json, version, committed_by, created_at)
CREATE TABLE IF NOT EXISTS token_commits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resolved_json  jsonb NOT NULL,
  version        integer NOT NULL,
  committed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS token_commits_project_id_idx ON token_commits(project_id);

-- previews (id, project_id, created_by, expires_at, created_at) -- metadata; payload in Redis
CREATE TABLE IF NOT EXISTS previews (
  id          text PRIMARY KEY,                       -- nanoid(8) minted in server.js
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS previews_project_id_idx ON previews(project_id);
CREATE INDEX IF NOT EXISTS previews_expires_at_idx ON previews(expires_at);

-- audit_log (id, org_id, actor, action, target, created_at)
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor       text,
  action      text NOT NULL,
  target      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_org_id_idx ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);
