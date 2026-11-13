-- table: acorn_aspen
ALTER TABLE acorn_aspen ENABLE ROW LEVEL SECURITY;
ALTER TABLE acorn_aspen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acorn_aspen_isolation ON acorn_aspen;
DROP POLICY IF EXISTS acorn_aspen_select ON acorn_aspen;
DROP POLICY IF EXISTS acorn_aspen_insert ON acorn_aspen;
DROP POLICY IF EXISTS acorn_aspen_update ON acorn_aspen;
DROP POLICY IF EXISTS acorn_aspen_delete ON acorn_aspen;
CREATE POLICY acorn_aspen_select ON acorn_aspen
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_aspen_insert ON acorn_aspen
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_aspen_update ON acorn_aspen
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_aspen_delete ON acorn_aspen
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: acorn_brook
ALTER TABLE acorn_brook ENABLE ROW LEVEL SECURITY;
ALTER TABLE acorn_brook FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acorn_brook_isolation ON acorn_brook;
DROP POLICY IF EXISTS acorn_brook_select ON acorn_brook;
DROP POLICY IF EXISTS acorn_brook_insert ON acorn_brook;
DROP POLICY IF EXISTS acorn_brook_update ON acorn_brook;
DROP POLICY IF EXISTS acorn_brook_delete ON acorn_brook;
CREATE POLICY acorn_brook_select ON acorn_brook
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_brook_insert ON acorn_brook
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_brook_update ON acorn_brook
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY acorn_brook_delete ON acorn_brook
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: anchor_badge
ALTER TABLE anchor_badge ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_badge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anchor_badge_isolation ON anchor_badge;
DROP POLICY IF EXISTS anchor_badge_select ON anchor_badge;
DROP POLICY IF EXISTS anchor_badge_insert ON anchor_badge;
DROP POLICY IF EXISTS anchor_badge_update ON anchor_badge;
DROP POLICY IF EXISTS anchor_badge_delete ON anchor_badge;
CREATE POLICY anchor_badge_select ON anchor_badge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY anchor_badge_insert ON anchor_badge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY anchor_badge_update ON anchor_badge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY anchor_badge_delete ON anchor_badge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: apple
ALTER TABLE apple ENABLE ROW LEVEL SECURITY;
ALTER TABLE apple FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apple_isolation ON apple;
DROP POLICY IF EXISTS apple_select ON apple;
DROP POLICY IF EXISTS apple_insert ON apple;
DROP POLICY IF EXISTS apple_update ON apple;
DROP POLICY IF EXISTS apple_delete ON apple;
CREATE POLICY apple_select ON apple
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY apple_insert ON apple
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY apple_update ON apple
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY apple_delete ON apple
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: barley
ALTER TABLE barley ENABLE ROW LEVEL SECURITY;
ALTER TABLE barley FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS barley_isolation ON barley;
DROP POLICY IF EXISTS barley_select ON barley;
DROP POLICY IF EXISTS barley_insert ON barley;
DROP POLICY IF EXISTS barley_update ON barley;
DROP POLICY IF EXISTS barley_delete ON barley;
CREATE POLICY barley_select ON barley
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY barley_insert ON barley
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY barley_update ON barley
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY barley_delete ON barley
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: basil
ALTER TABLE basil ENABLE ROW LEVEL SECURITY;
ALTER TABLE basil FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basil_isolation ON basil;
DROP POLICY IF EXISTS basil_select ON basil;
DROP POLICY IF EXISTS basil_insert ON basil;
DROP POLICY IF EXISTS basil_update ON basil;
DROP POLICY IF EXISTS basil_delete ON basil;
CREATE POLICY basil_select ON basil
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY basil_insert ON basil
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY basil_update ON basil
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY basil_delete ON basil
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: beacon
ALTER TABLE beacon ENABLE ROW LEVEL SECURITY;
ALTER TABLE beacon FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS beacon_isolation ON beacon;
DROP POLICY IF EXISTS beacon_select ON beacon;
DROP POLICY IF EXISTS beacon_insert ON beacon;
DROP POLICY IF EXISTS beacon_update ON beacon;
DROP POLICY IF EXISTS beacon_delete ON beacon;
CREATE POLICY beacon_select ON beacon
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_insert ON beacon
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_update ON beacon
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_delete ON beacon
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: beacon_poppy_meadow
ALTER TABLE beacon_poppy_meadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE beacon_poppy_meadow FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS beacon_poppy_meadow_isolation ON beacon_poppy_meadow;
DROP POLICY IF EXISTS beacon_poppy_meadow_select ON beacon_poppy_meadow;
DROP POLICY IF EXISTS beacon_poppy_meadow_insert ON beacon_poppy_meadow;
DROP POLICY IF EXISTS beacon_poppy_meadow_update ON beacon_poppy_meadow;
DROP POLICY IF EXISTS beacon_poppy_meadow_delete ON beacon_poppy_meadow;
CREATE POLICY beacon_poppy_meadow_select ON beacon_poppy_meadow
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_poppy_meadow_insert ON beacon_poppy_meadow
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_poppy_meadow_update ON beacon_poppy_meadow
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_poppy_meadow_delete ON beacon_poppy_meadow
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: beacon_ridge
ALTER TABLE beacon_ridge ENABLE ROW LEVEL SECURITY;
ALTER TABLE beacon_ridge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS beacon_ridge_isolation ON beacon_ridge;
DROP POLICY IF EXISTS beacon_ridge_select ON beacon_ridge;
DROP POLICY IF EXISTS beacon_ridge_insert ON beacon_ridge;
DROP POLICY IF EXISTS beacon_ridge_update ON beacon_ridge;
DROP POLICY IF EXISTS beacon_ridge_delete ON beacon_ridge;
CREATE POLICY beacon_ridge_select ON beacon_ridge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_ridge_insert ON beacon_ridge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_ridge_update ON beacon_ridge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY beacon_ridge_delete ON beacon_ridge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: cedar
ALTER TABLE cedar ENABLE ROW LEVEL SECURITY;
ALTER TABLE cedar FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cedar_isolation ON cedar;
DROP POLICY IF EXISTS cedar_select ON cedar;
DROP POLICY IF EXISTS cedar_insert ON cedar;
DROP POLICY IF EXISTS cedar_update ON cedar;
DROP POLICY IF EXISTS cedar_delete ON cedar;
CREATE POLICY cedar_select ON cedar
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cedar_insert ON cedar
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cedar_update ON cedar
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cedar_delete ON cedar
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: clover
ALTER TABLE clover ENABLE ROW LEVEL SECURITY;
ALTER TABLE clover FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clover_isolation ON clover;
DROP POLICY IF EXISTS clover_select ON clover;
DROP POLICY IF EXISTS clover_insert ON clover;
DROP POLICY IF EXISTS clover_update ON clover;
DROP POLICY IF EXISTS clover_delete ON clover;
CREATE POLICY clover_select ON clover
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY clover_insert ON clover
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY clover_update ON clover
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY clover_delete ON clover
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: cobalt
ALTER TABLE cobalt ENABLE ROW LEVEL SECURITY;
ALTER TABLE cobalt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cobalt_isolation ON cobalt;
DROP POLICY IF EXISTS cobalt_select ON cobalt;
DROP POLICY IF EXISTS cobalt_insert ON cobalt;
DROP POLICY IF EXISTS cobalt_update ON cobalt;
DROP POLICY IF EXISTS cobalt_delete ON cobalt;
CREATE POLICY cobalt_select ON cobalt
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_insert ON cobalt
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_update ON cobalt
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_delete ON cobalt
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: cobalt_fennel_onyx
ALTER TABLE cobalt_fennel_onyx ENABLE ROW LEVEL SECURITY;
ALTER TABLE cobalt_fennel_onyx FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cobalt_fennel_onyx_isolation ON cobalt_fennel_onyx;
DROP POLICY IF EXISTS cobalt_fennel_onyx_select ON cobalt_fennel_onyx;
DROP POLICY IF EXISTS cobalt_fennel_onyx_insert ON cobalt_fennel_onyx;
DROP POLICY IF EXISTS cobalt_fennel_onyx_update ON cobalt_fennel_onyx;
DROP POLICY IF EXISTS cobalt_fennel_onyx_delete ON cobalt_fennel_onyx;
CREATE POLICY cobalt_fennel_onyx_select ON cobalt_fennel_onyx
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_fennel_onyx_insert ON cobalt_fennel_onyx
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_fennel_onyx_update ON cobalt_fennel_onyx
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cobalt_fennel_onyx_delete ON cobalt_fennel_onyx
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: coral
ALTER TABLE coral ENABLE ROW LEVEL SECURITY;
ALTER TABLE coral FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coral_isolation ON coral;
DROP POLICY IF EXISTS coral_select ON coral;
DROP POLICY IF EXISTS coral_insert ON coral;
DROP POLICY IF EXISTS coral_update ON coral;
DROP POLICY IF EXISTS coral_delete ON coral;
CREATE POLICY coral_select ON coral
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_insert ON coral
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_update ON coral
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_delete ON coral
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: coral_badge
ALTER TABLE coral_badge ENABLE ROW LEVEL SECURITY;
ALTER TABLE coral_badge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coral_badge_isolation ON coral_badge;
DROP POLICY IF EXISTS coral_badge_select ON coral_badge;
DROP POLICY IF EXISTS coral_badge_insert ON coral_badge;
DROP POLICY IF EXISTS coral_badge_update ON coral_badge;
DROP POLICY IF EXISTS coral_badge_delete ON coral_badge;
CREATE POLICY coral_badge_select ON coral_badge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_badge_insert ON coral_badge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_badge_update ON coral_badge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY coral_badge_delete ON coral_badge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: cotton
ALTER TABLE cotton ENABLE ROW LEVEL SECURITY;
ALTER TABLE cotton FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cotton_isolation ON cotton;
DROP POLICY IF EXISTS cotton_select ON cotton;
DROP POLICY IF EXISTS cotton_insert ON cotton;
DROP POLICY IF EXISTS cotton_update ON cotton;
DROP POLICY IF EXISTS cotton_delete ON cotton;
CREATE POLICY cotton_select ON cotton
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cotton_insert ON cotton
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cotton_update ON cotton
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY cotton_delete ON cotton
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: dahlia
ALTER TABLE dahlia ENABLE ROW LEVEL SECURITY;
ALTER TABLE dahlia FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dahlia_isolation ON dahlia;
DROP POLICY IF EXISTS dahlia_select ON dahlia;
DROP POLICY IF EXISTS dahlia_insert ON dahlia;
DROP POLICY IF EXISTS dahlia_update ON dahlia;
DROP POLICY IF EXISTS dahlia_delete ON dahlia;
CREATE POLICY dahlia_select ON dahlia
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dahlia_insert ON dahlia
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dahlia_update ON dahlia
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dahlia_delete ON dahlia
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: delta_maple
ALTER TABLE delta_maple ENABLE ROW LEVEL SECURITY;
ALTER TABLE delta_maple FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delta_maple_isolation ON delta_maple;
DROP POLICY IF EXISTS delta_maple_select ON delta_maple;
DROP POLICY IF EXISTS delta_maple_insert ON delta_maple;
DROP POLICY IF EXISTS delta_maple_update ON delta_maple;
DROP POLICY IF EXISTS delta_maple_delete ON delta_maple;
CREATE POLICY delta_maple_select ON delta_maple
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delta_maple_insert ON delta_maple
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delta_maple_update ON delta_maple
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delta_maple_delete ON delta_maple
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: dune_cinder
ALTER TABLE dune_cinder ENABLE ROW LEVEL SECURITY;
ALTER TABLE dune_cinder FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dune_cinder_isolation ON dune_cinder;
DROP POLICY IF EXISTS dune_cinder_select ON dune_cinder;
DROP POLICY IF EXISTS dune_cinder_insert ON dune_cinder;
DROP POLICY IF EXISTS dune_cinder_update ON dune_cinder;
DROP POLICY IF EXISTS dune_cinder_delete ON dune_cinder;
CREATE POLICY dune_cinder_select ON dune_cinder
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dune_cinder_insert ON dune_cinder
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dune_cinder_update ON dune_cinder
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY dune_cinder_delete ON dune_cinder
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: flint
ALTER TABLE flint ENABLE ROW LEVEL SECURITY;
ALTER TABLE flint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flint_isolation ON flint;
DROP POLICY IF EXISTS flint_select ON flint;
DROP POLICY IF EXISTS flint_insert ON flint;
DROP POLICY IF EXISTS flint_update ON flint;
DROP POLICY IF EXISTS flint_delete ON flint;
CREATE POLICY flint_select ON flint
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_insert ON flint
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_update ON flint
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_delete ON flint
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: flint_birch
ALTER TABLE flint_birch ENABLE ROW LEVEL SECURITY;
ALTER TABLE flint_birch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flint_birch_isolation ON flint_birch;
DROP POLICY IF EXISTS flint_birch_select ON flint_birch;
DROP POLICY IF EXISTS flint_birch_insert ON flint_birch;
DROP POLICY IF EXISTS flint_birch_update ON flint_birch;
DROP POLICY IF EXISTS flint_birch_delete ON flint_birch;
CREATE POLICY flint_birch_select ON flint_birch
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_birch_insert ON flint_birch
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_birch_update ON flint_birch
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_birch_delete ON flint_birch
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: flint_pepper
ALTER TABLE flint_pepper ENABLE ROW LEVEL SECURITY;
ALTER TABLE flint_pepper FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flint_pepper_isolation ON flint_pepper;
DROP POLICY IF EXISTS flint_pepper_select ON flint_pepper;
DROP POLICY IF EXISTS flint_pepper_insert ON flint_pepper;
DROP POLICY IF EXISTS flint_pepper_update ON flint_pepper;
DROP POLICY IF EXISTS flint_pepper_delete ON flint_pepper;
CREATE POLICY flint_pepper_select ON flint_pepper
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_pepper_insert ON flint_pepper
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_pepper_update ON flint_pepper
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY flint_pepper_delete ON flint_pepper
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: garnet
ALTER TABLE garnet ENABLE ROW LEVEL SECURITY;
ALTER TABLE garnet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS garnet_isolation ON garnet;
DROP POLICY IF EXISTS garnet_select ON garnet;
DROP POLICY IF EXISTS garnet_insert ON garnet;
DROP POLICY IF EXISTS garnet_update ON garnet;
DROP POLICY IF EXISTS garnet_delete ON garnet;
CREATE POLICY garnet_select ON garnet
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY garnet_insert ON garnet
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY garnet_update ON garnet
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY garnet_delete ON garnet
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: ginger_olive
ALTER TABLE ginger_olive ENABLE ROW LEVEL SECURITY;
ALTER TABLE ginger_olive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ginger_olive_isolation ON ginger_olive;
DROP POLICY IF EXISTS ginger_olive_select ON ginger_olive;
DROP POLICY IF EXISTS ginger_olive_insert ON ginger_olive;
DROP POLICY IF EXISTS ginger_olive_update ON ginger_olive;
DROP POLICY IF EXISTS ginger_olive_delete ON ginger_olive;
CREATE POLICY ginger_olive_select ON ginger_olive
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_olive_insert ON ginger_olive
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_olive_update ON ginger_olive
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_olive_delete ON ginger_olive
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: ginger_sage
ALTER TABLE ginger_sage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ginger_sage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ginger_sage_isolation ON ginger_sage;
DROP POLICY IF EXISTS ginger_sage_select ON ginger_sage;
DROP POLICY IF EXISTS ginger_sage_insert ON ginger_sage;
DROP POLICY IF EXISTS ginger_sage_update ON ginger_sage;
DROP POLICY IF EXISTS ginger_sage_delete ON ginger_sage;
CREATE POLICY ginger_sage_select ON ginger_sage
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_sage_insert ON ginger_sage
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_sage_update ON ginger_sage
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY ginger_sage_delete ON ginger_sage
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: gull
ALTER TABLE gull ENABLE ROW LEVEL SECURITY;
ALTER TABLE gull FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gull_isolation ON gull;
DROP POLICY IF EXISTS gull_select ON gull;
DROP POLICY IF EXISTS gull_insert ON gull;
DROP POLICY IF EXISTS gull_update ON gull;
DROP POLICY IF EXISTS gull_delete ON gull;
CREATE POLICY gull_select ON gull
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY gull_insert ON gull
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY gull_update ON gull
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY gull_delete ON gull
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: harbor
ALTER TABLE harbor ENABLE ROW LEVEL SECURITY;
ALTER TABLE harbor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS harbor_isolation ON harbor;
DROP POLICY IF EXISTS harbor_select ON harbor;
DROP POLICY IF EXISTS harbor_insert ON harbor;
DROP POLICY IF EXISTS harbor_update ON harbor;
DROP POLICY IF EXISTS harbor_delete ON harbor;
CREATE POLICY harbor_select ON harbor
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_insert ON harbor
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_update ON harbor
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_delete ON harbor
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: harbor_crane
ALTER TABLE harbor_crane ENABLE ROW LEVEL SECURITY;
ALTER TABLE harbor_crane FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS harbor_crane_isolation ON harbor_crane;
DROP POLICY IF EXISTS harbor_crane_select ON harbor_crane;
DROP POLICY IF EXISTS harbor_crane_insert ON harbor_crane;
DROP POLICY IF EXISTS harbor_crane_update ON harbor_crane;
DROP POLICY IF EXISTS harbor_crane_delete ON harbor_crane;
CREATE POLICY harbor_crane_select ON harbor_crane
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_crane_insert ON harbor_crane
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_crane_update ON harbor_crane
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY harbor_crane_delete ON harbor_crane
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: heron_juniper
ALTER TABLE heron_juniper ENABLE ROW LEVEL SECURITY;
ALTER TABLE heron_juniper FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS heron_juniper_isolation ON heron_juniper;
DROP POLICY IF EXISTS heron_juniper_select ON heron_juniper;
DROP POLICY IF EXISTS heron_juniper_insert ON heron_juniper;
DROP POLICY IF EXISTS heron_juniper_update ON heron_juniper;
DROP POLICY IF EXISTS heron_juniper_delete ON heron_juniper;
CREATE POLICY heron_juniper_select ON heron_juniper
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_insert ON heron_juniper
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_update ON heron_juniper
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_delete ON heron_juniper
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: heron_juniper_otter
ALTER TABLE heron_juniper_otter ENABLE ROW LEVEL SECURITY;
ALTER TABLE heron_juniper_otter FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS heron_juniper_otter_isolation ON heron_juniper_otter;
DROP POLICY IF EXISTS heron_juniper_otter_select ON heron_juniper_otter;
DROP POLICY IF EXISTS heron_juniper_otter_insert ON heron_juniper_otter;
DROP POLICY IF EXISTS heron_juniper_otter_update ON heron_juniper_otter;
DROP POLICY IF EXISTS heron_juniper_otter_delete ON heron_juniper_otter;
CREATE POLICY heron_juniper_otter_select ON heron_juniper_otter
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_otter_insert ON heron_juniper_otter
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_otter_update ON heron_juniper_otter
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY heron_juniper_otter_delete ON heron_juniper_otter
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: iris
ALTER TABLE iris ENABLE ROW LEVEL SECURITY;
ALTER TABLE iris FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iris_isolation ON iris;
DROP POLICY IF EXISTS iris_select ON iris;
DROP POLICY IF EXISTS iris_insert ON iris;
DROP POLICY IF EXISTS iris_update ON iris;
DROP POLICY IF EXISTS iris_delete ON iris;
CREATE POLICY iris_select ON iris
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY iris_insert ON iris
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY iris_update ON iris
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY iris_delete ON iris
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: jasper
ALTER TABLE jasper ENABLE ROW LEVEL SECURITY;
ALTER TABLE jasper FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jasper_isolation ON jasper;
DROP POLICY IF EXISTS jasper_select ON jasper;
DROP POLICY IF EXISTS jasper_insert ON jasper;
DROP POLICY IF EXISTS jasper_update ON jasper;
DROP POLICY IF EXISTS jasper_delete ON jasper;
CREATE POLICY jasper_select ON jasper
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_insert ON jasper
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_update ON jasper
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_delete ON jasper
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: jasper_comet
ALTER TABLE jasper_comet ENABLE ROW LEVEL SECURITY;
ALTER TABLE jasper_comet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jasper_comet_isolation ON jasper_comet;
DROP POLICY IF EXISTS jasper_comet_select ON jasper_comet;
DROP POLICY IF EXISTS jasper_comet_insert ON jasper_comet;
DROP POLICY IF EXISTS jasper_comet_update ON jasper_comet;
DROP POLICY IF EXISTS jasper_comet_delete ON jasper_comet;
CREATE POLICY jasper_comet_select ON jasper_comet
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_comet_insert ON jasper_comet
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_comet_update ON jasper_comet
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY jasper_comet_delete ON jasper_comet
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: kelp_badge
ALTER TABLE kelp_badge ENABLE ROW LEVEL SECURITY;
ALTER TABLE kelp_badge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kelp_badge_isolation ON kelp_badge;
DROP POLICY IF EXISTS kelp_badge_select ON kelp_badge;
DROP POLICY IF EXISTS kelp_badge_insert ON kelp_badge;
DROP POLICY IF EXISTS kelp_badge_update ON kelp_badge;
DROP POLICY IF EXISTS kelp_badge_delete ON kelp_badge;
CREATE POLICY kelp_badge_select ON kelp_badge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY kelp_badge_insert ON kelp_badge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY kelp_badge_update ON kelp_badge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY kelp_badge_delete ON kelp_badge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: lagoon_opal
ALTER TABLE lagoon_opal ENABLE ROW LEVEL SECURITY;
ALTER TABLE lagoon_opal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lagoon_opal_isolation ON lagoon_opal;
DROP POLICY IF EXISTS lagoon_opal_select ON lagoon_opal;
DROP POLICY IF EXISTS lagoon_opal_insert ON lagoon_opal;
DROP POLICY IF EXISTS lagoon_opal_update ON lagoon_opal;
DROP POLICY IF EXISTS lagoon_opal_delete ON lagoon_opal;
CREATE POLICY lagoon_opal_select ON lagoon_opal
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lagoon_opal_insert ON lagoon_opal
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lagoon_opal_update ON lagoon_opal
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lagoon_opal_delete ON lagoon_opal
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: lemon_larch
ALTER TABLE lemon_larch ENABLE ROW LEVEL SECURITY;
ALTER TABLE lemon_larch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lemon_larch_isolation ON lemon_larch;
DROP POLICY IF EXISTS lemon_larch_select ON lemon_larch;
DROP POLICY IF EXISTS lemon_larch_insert ON lemon_larch;
DROP POLICY IF EXISTS lemon_larch_update ON lemon_larch;
DROP POLICY IF EXISTS lemon_larch_delete ON lemon_larch;
CREATE POLICY lemon_larch_select ON lemon_larch
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lemon_larch_insert ON lemon_larch
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lemon_larch_update ON lemon_larch
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lemon_larch_delete ON lemon_larch
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: linden_ivory
ALTER TABLE linden_ivory ENABLE ROW LEVEL SECURITY;
ALTER TABLE linden_ivory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS linden_ivory_isolation ON linden_ivory;
DROP POLICY IF EXISTS linden_ivory_select ON linden_ivory;
DROP POLICY IF EXISTS linden_ivory_insert ON linden_ivory;
DROP POLICY IF EXISTS linden_ivory_update ON linden_ivory;
DROP POLICY IF EXISTS linden_ivory_delete ON linden_ivory;
CREATE POLICY linden_ivory_select ON linden_ivory
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_ivory_insert ON linden_ivory
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_ivory_update ON linden_ivory
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_ivory_delete ON linden_ivory
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: linden_moss
ALTER TABLE linden_moss ENABLE ROW LEVEL SECURITY;
ALTER TABLE linden_moss FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS linden_moss_isolation ON linden_moss;
DROP POLICY IF EXISTS linden_moss_select ON linden_moss;
DROP POLICY IF EXISTS linden_moss_insert ON linden_moss;
DROP POLICY IF EXISTS linden_moss_update ON linden_moss;
DROP POLICY IF EXISTS linden_moss_delete ON linden_moss;
CREATE POLICY linden_moss_select ON linden_moss
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_moss_insert ON linden_moss
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_moss_update ON linden_moss
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY linden_moss_delete ON linden_moss
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: mesa_lotus
ALTER TABLE mesa_lotus ENABLE ROW LEVEL SECURITY;
ALTER TABLE mesa_lotus FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mesa_lotus_isolation ON mesa_lotus;
DROP POLICY IF EXISTS mesa_lotus_select ON mesa_lotus;
DROP POLICY IF EXISTS mesa_lotus_insert ON mesa_lotus;
DROP POLICY IF EXISTS mesa_lotus_update ON mesa_lotus;
DROP POLICY IF EXISTS mesa_lotus_delete ON mesa_lotus;
CREATE POLICY mesa_lotus_select ON mesa_lotus
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY mesa_lotus_insert ON mesa_lotus
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY mesa_lotus_update ON mesa_lotus
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY mesa_lotus_delete ON mesa_lotus
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: nutmeg_marble
ALTER TABLE nutmeg_marble ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutmeg_marble FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nutmeg_marble_isolation ON nutmeg_marble;
DROP POLICY IF EXISTS nutmeg_marble_select ON nutmeg_marble;
DROP POLICY IF EXISTS nutmeg_marble_insert ON nutmeg_marble;
DROP POLICY IF EXISTS nutmeg_marble_update ON nutmeg_marble;
DROP POLICY IF EXISTS nutmeg_marble_delete ON nutmeg_marble;
CREATE POLICY nutmeg_marble_select ON nutmeg_marble
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY nutmeg_marble_insert ON nutmeg_marble
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY nutmeg_marble_update ON nutmeg_marble
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY nutmeg_marble_delete ON nutmeg_marble
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: oak_amber_raven
ALTER TABLE oak_amber_raven ENABLE ROW LEVEL SECURITY;
ALTER TABLE oak_amber_raven FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oak_amber_raven_isolation ON oak_amber_raven;
DROP POLICY IF EXISTS oak_amber_raven_select ON oak_amber_raven;
DROP POLICY IF EXISTS oak_amber_raven_insert ON oak_amber_raven;
DROP POLICY IF EXISTS oak_amber_raven_update ON oak_amber_raven;
DROP POLICY IF EXISTS oak_amber_raven_delete ON oak_amber_raven;
CREATE POLICY oak_amber_raven_select ON oak_amber_raven
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_amber_raven_insert ON oak_amber_raven
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_amber_raven_update ON oak_amber_raven
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_amber_raven_delete ON oak_amber_raven
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: oak_canyon
ALTER TABLE oak_canyon ENABLE ROW LEVEL SECURITY;
ALTER TABLE oak_canyon FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oak_canyon_isolation ON oak_canyon;
DROP POLICY IF EXISTS oak_canyon_select ON oak_canyon;
DROP POLICY IF EXISTS oak_canyon_insert ON oak_canyon;
DROP POLICY IF EXISTS oak_canyon_update ON oak_canyon;
DROP POLICY IF EXISTS oak_canyon_delete ON oak_canyon;
CREATE POLICY oak_canyon_select ON oak_canyon
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_canyon_insert ON oak_canyon
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_canyon_update ON oak_canyon
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY oak_canyon_delete ON oak_canyon
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: olive
ALTER TABLE olive ENABLE ROW LEVEL SECURITY;
ALTER TABLE olive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS olive_isolation ON olive;
DROP POLICY IF EXISTS olive_select ON olive;
DROP POLICY IF EXISTS olive_insert ON olive;
DROP POLICY IF EXISTS olive_update ON olive;
DROP POLICY IF EXISTS olive_delete ON olive;
CREATE POLICY olive_select ON olive
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_insert ON olive
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_update ON olive
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_delete ON olive
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: olive_aspen
ALTER TABLE olive_aspen ENABLE ROW LEVEL SECURITY;
ALTER TABLE olive_aspen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS olive_aspen_isolation ON olive_aspen;
DROP POLICY IF EXISTS olive_aspen_select ON olive_aspen;
DROP POLICY IF EXISTS olive_aspen_insert ON olive_aspen;
DROP POLICY IF EXISTS olive_aspen_update ON olive_aspen;
DROP POLICY IF EXISTS olive_aspen_delete ON olive_aspen;
CREATE POLICY olive_aspen_select ON olive_aspen
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_aspen_insert ON olive_aspen
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_aspen_update ON olive_aspen
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_aspen_delete ON olive_aspen
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: olive_crocus_ember
ALTER TABLE olive_crocus_ember ENABLE ROW LEVEL SECURITY;
ALTER TABLE olive_crocus_ember FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS olive_crocus_ember_isolation ON olive_crocus_ember;
DROP POLICY IF EXISTS olive_crocus_ember_select ON olive_crocus_ember;
DROP POLICY IF EXISTS olive_crocus_ember_insert ON olive_crocus_ember;
DROP POLICY IF EXISTS olive_crocus_ember_update ON olive_crocus_ember;
DROP POLICY IF EXISTS olive_crocus_ember_delete ON olive_crocus_ember;
CREATE POLICY olive_crocus_ember_select ON olive_crocus_ember
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_crocus_ember_insert ON olive_crocus_ember
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_crocus_ember_update ON olive_crocus_ember
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_crocus_ember_delete ON olive_crocus_ember
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: olive_reed
ALTER TABLE olive_reed ENABLE ROW LEVEL SECURITY;
ALTER TABLE olive_reed FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS olive_reed_isolation ON olive_reed;
DROP POLICY IF EXISTS olive_reed_select ON olive_reed;
DROP POLICY IF EXISTS olive_reed_insert ON olive_reed;
DROP POLICY IF EXISTS olive_reed_update ON olive_reed;
DROP POLICY IF EXISTS olive_reed_delete ON olive_reed;
CREATE POLICY olive_reed_select ON olive_reed
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_reed_insert ON olive_reed
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_reed_update ON olive_reed
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY olive_reed_delete ON olive_reed
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: pebble_hazel
ALTER TABLE pebble_hazel ENABLE ROW LEVEL SECURITY;
ALTER TABLE pebble_hazel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pebble_hazel_isolation ON pebble_hazel;
DROP POLICY IF EXISTS pebble_hazel_select ON pebble_hazel;
DROP POLICY IF EXISTS pebble_hazel_insert ON pebble_hazel;
DROP POLICY IF EXISTS pebble_hazel_update ON pebble_hazel;
DROP POLICY IF EXISTS pebble_hazel_delete ON pebble_hazel;
CREATE POLICY pebble_hazel_select ON pebble_hazel
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pebble_hazel_insert ON pebble_hazel
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pebble_hazel_update ON pebble_hazel
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pebble_hazel_delete ON pebble_hazel
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: pine_badge
ALTER TABLE pine_badge ENABLE ROW LEVEL SECURITY;
ALTER TABLE pine_badge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pine_badge_isolation ON pine_badge;
DROP POLICY IF EXISTS pine_badge_select ON pine_badge;
DROP POLICY IF EXISTS pine_badge_insert ON pine_badge;
DROP POLICY IF EXISTS pine_badge_update ON pine_badge;
DROP POLICY IF EXISTS pine_badge_delete ON pine_badge;
CREATE POLICY pine_badge_select ON pine_badge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pine_badge_insert ON pine_badge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pine_badge_update ON pine_badge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pine_badge_delete ON pine_badge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: plum
ALTER TABLE plum ENABLE ROW LEVEL SECURITY;
ALTER TABLE plum FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plum_isolation ON plum;
DROP POLICY IF EXISTS plum_select ON plum;
DROP POLICY IF EXISTS plum_insert ON plum;
DROP POLICY IF EXISTS plum_update ON plum;
DROP POLICY IF EXISTS plum_delete ON plum;
CREATE POLICY plum_select ON plum
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY plum_insert ON plum
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY plum_update ON plum
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY plum_delete ON plum
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: quince
ALTER TABLE quince ENABLE ROW LEVEL SECURITY;
ALTER TABLE quince FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quince_isolation ON quince;
DROP POLICY IF EXISTS quince_select ON quince;
DROP POLICY IF EXISTS quince_insert ON quince;
DROP POLICY IF EXISTS quince_update ON quince;
DROP POLICY IF EXISTS quince_delete ON quince;
CREATE POLICY quince_select ON quince
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_insert ON quince
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_update ON quince
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_delete ON quince
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: quince_alder
ALTER TABLE quince_alder ENABLE ROW LEVEL SECURITY;
ALTER TABLE quince_alder FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quince_alder_isolation ON quince_alder;
DROP POLICY IF EXISTS quince_alder_select ON quince_alder;
DROP POLICY IF EXISTS quince_alder_insert ON quince_alder;
DROP POLICY IF EXISTS quince_alder_update ON quince_alder;
DROP POLICY IF EXISTS quince_alder_delete ON quince_alder;
CREATE POLICY quince_alder_select ON quince_alder
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_alder_insert ON quince_alder
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_alder_update ON quince_alder
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY quince_alder_delete ON quince_alder
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: thyme_clover
ALTER TABLE thyme_clover ENABLE ROW LEVEL SECURITY;
ALTER TABLE thyme_clover FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thyme_clover_isolation ON thyme_clover;
DROP POLICY IF EXISTS thyme_clover_select ON thyme_clover;
DROP POLICY IF EXISTS thyme_clover_insert ON thyme_clover;
DROP POLICY IF EXISTS thyme_clover_update ON thyme_clover;
DROP POLICY IF EXISTS thyme_clover_delete ON thyme_clover;
CREATE POLICY thyme_clover_select ON thyme_clover
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY thyme_clover_insert ON thyme_clover
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY thyme_clover_update ON thyme_clover
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY thyme_clover_delete ON thyme_clover
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

