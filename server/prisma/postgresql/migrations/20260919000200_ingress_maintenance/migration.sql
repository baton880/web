-- Keep completed inbox history out of the hot claim path. Queue rows change
-- status several times; vacuum must not wait for 20% of the entire history.
CREATE INDEX host_ingress_active_id_pg_idx ON host_ingress(id) WHERE status IN ('pending','retry','processing');
ALTER TABLE host_ingress SET (autovacuum_vacuum_scale_factor=0.01, autovacuum_vacuum_threshold=500, autovacuum_analyze_scale_factor=0.01);
ALTER TABLE rtk_ingress SET (autovacuum_vacuum_scale_factor=0.01, autovacuum_vacuum_threshold=500, autovacuum_analyze_scale_factor=0.01);
