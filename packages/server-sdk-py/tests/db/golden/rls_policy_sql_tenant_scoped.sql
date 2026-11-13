-- table: suppression
ALTER TABLE suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppression_isolation ON suppression;
CREATE POLICY suppression_isolation ON suppression
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

