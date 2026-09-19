-- Stage 2 prototype: apply ONLY to an isolated farm_test_* database.
-- Promote to a Prisma migration after HOST/replay integration and importer validation.
CREATE TABLE rtk_ingress (
  id BIGSERIAL PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  raw_body TEXT NOT NULL,
  received_at TIMESTAMPTZ(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retry','processing','processed','permanent')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ(3),
  last_error TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ(3),
  lease_owner UUID,
  lease_token UUID,
  lease_until TIMESTAMPTZ(3),
  CONSTRAINT rtk_ingress_lease_state CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX rtk_ingress_ready_pg_idx ON rtk_ingress(id, next_attempt_at) WHERE status IN ('pending','retry');
CREATE INDEX rtk_ingress_expired_pg_idx ON rtk_ingress(lease_until, id) WHERE status = 'processing';
CREATE INDEX rtk_ingress_processed_pg_idx ON rtk_ingress(processed_at) WHERE status = 'processed';
