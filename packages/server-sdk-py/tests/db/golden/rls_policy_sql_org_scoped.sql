-- table: channel_credential
ALTER TABLE channel_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_credential FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_credential_isolation ON channel_credential;
CREATE POLICY channel_credential_isolation ON channel_credential
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: channel_identity
ALTER TABLE channel_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_identity_isolation ON channel_identity;
CREATE POLICY channel_identity_isolation ON channel_identity
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: channel_mapping
ALTER TABLE channel_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_mapping FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_mapping_isolation ON channel_mapping;
CREATE POLICY channel_mapping_isolation ON channel_mapping
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: inbound
ALTER TABLE inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbound_isolation ON inbound;
CREATE POLICY inbound_isolation ON inbound
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: thread
ALTER TABLE thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thread_isolation ON thread;
CREATE POLICY thread_isolation ON thread
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

