-- table: pebble
ALTER TABLE pebble ENABLE ROW LEVEL SECURITY;
ALTER TABLE pebble FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pebble_isolation ON pebble;
CREATE POLICY pebble_isolation ON pebble
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

