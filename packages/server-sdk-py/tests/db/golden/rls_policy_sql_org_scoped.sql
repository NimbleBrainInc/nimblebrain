-- table: bramble_chalk
ALTER TABLE bramble_chalk ENABLE ROW LEVEL SECURITY;
ALTER TABLE bramble_chalk FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bramble_chalk_isolation ON bramble_chalk;
CREATE POLICY bramble_chalk_isolation ON bramble_chalk
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: bramble_fern
ALTER TABLE bramble_fern ENABLE ROW LEVEL SECURITY;
ALTER TABLE bramble_fern FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bramble_fern_isolation ON bramble_fern;
CREATE POLICY bramble_fern_isolation ON bramble_fern
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: bramble_granite
ALTER TABLE bramble_granite ENABLE ROW LEVEL SECURITY;
ALTER TABLE bramble_granite FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bramble_granite_isolation ON bramble_granite;
CREATE POLICY bramble_granite_isolation ON bramble_granite
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: finch
ALTER TABLE finch ENABLE ROW LEVEL SECURITY;
ALTER TABLE finch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finch_isolation ON finch;
CREATE POLICY finch_isolation ON finch
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- table: quartz
ALTER TABLE quartz ENABLE ROW LEVEL SECURITY;
ALTER TABLE quartz FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quartz_isolation ON quartz;
CREATE POLICY quartz_isolation ON quartz
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

