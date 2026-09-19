CREATE TABLE host_ingress (
 id BIGSERIAL PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
 device_id TEXT, stream_id TEXT, packet_id BIGINT, is_live INTEGER NOT NULL DEFAULT 0 CHECK(is_live IN (0,1)),
 raw_body TEXT NOT NULL, received_at TIMESTAMPTZ(3) NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','processing','processed','permanent')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ(3), last_error TEXT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(), processed_at TIMESTAMPTZ(3),
 lease_owner UUID, lease_token UUID, lease_until TIMESTAMPTZ(3),
 CHECK ((status='processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
 OR (status<>'processing' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX host_ingress_ready_pg_idx ON host_ingress(status,next_attempt_at,is_live DESC,id);
CREATE INDEX host_ingress_device_stream_packet_pg_idx ON host_ingress(device_id,stream_id,packet_id DESC);
CREATE INDEX host_ingress_device_live_id_pg_idx ON host_ingress(device_id,is_live,id DESC);
CREATE INDEX host_ingress_live_id_pg_idx ON host_ingress(is_live,id DESC);
CREATE INDEX host_ingress_device_id_pg_idx ON host_ingress(device_id,id DESC);
CREATE INDEX host_ingress_lease_pg_idx ON host_ingress(lease_until) WHERE status='processing';
CREATE TABLE host_ingress_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp());
CREATE TABLE calculated_replay_dirty(farm_day TEXT PRIMARY KEY,dirty_from TIMESTAMPTZ(3) NOT NULL,dirty_to TIMESTAMPTZ(3) NOT NULL,sources TEXT NOT NULL DEFAULT '',version BIGINT NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp());
CREATE INDEX calculated_replay_dirty_from_pg_idx ON calculated_replay_dirty(dirty_from,farm_day);

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
