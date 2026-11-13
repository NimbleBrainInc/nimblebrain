-- table: account_assessment
ALTER TABLE account_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_assessment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_assessment_isolation ON account_assessment;
DROP POLICY IF EXISTS account_assessment_select ON account_assessment;
DROP POLICY IF EXISTS account_assessment_insert ON account_assessment;
DROP POLICY IF EXISTS account_assessment_update ON account_assessment;
DROP POLICY IF EXISTS account_assessment_delete ON account_assessment;
CREATE POLICY account_assessment_select ON account_assessment
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_assessment_insert ON account_assessment
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_assessment_update ON account_assessment
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_assessment_delete ON account_assessment
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: account_config
ALTER TABLE account_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_config_isolation ON account_config;
DROP POLICY IF EXISTS account_config_select ON account_config;
DROP POLICY IF EXISTS account_config_insert ON account_config;
DROP POLICY IF EXISTS account_config_update ON account_config;
DROP POLICY IF EXISTS account_config_delete ON account_config;
CREATE POLICY account_config_select ON account_config
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_config_insert ON account_config
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_config_update ON account_config
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY account_config_delete ON account_config
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: artifact_audit
ALTER TABLE artifact_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS artifact_audit_isolation ON artifact_audit;
DROP POLICY IF EXISTS artifact_audit_select ON artifact_audit;
DROP POLICY IF EXISTS artifact_audit_insert ON artifact_audit;
DROP POLICY IF EXISTS artifact_audit_update ON artifact_audit;
DROP POLICY IF EXISTS artifact_audit_delete ON artifact_audit;
CREATE POLICY artifact_audit_select ON artifact_audit
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifact_audit_insert ON artifact_audit
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifact_audit_update ON artifact_audit
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifact_audit_delete ON artifact_audit
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: artifacts
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS artifacts_isolation ON artifacts;
DROP POLICY IF EXISTS artifacts_select ON artifacts;
DROP POLICY IF EXISTS artifacts_insert ON artifacts;
DROP POLICY IF EXISTS artifacts_update ON artifacts;
DROP POLICY IF EXISTS artifacts_delete ON artifacts;
CREATE POLICY artifacts_select ON artifacts
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifacts_insert ON artifacts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifacts_update ON artifacts
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY artifacts_delete ON artifacts
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: batch
ALTER TABLE batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batch_isolation ON batch;
DROP POLICY IF EXISTS batch_select ON batch;
DROP POLICY IF EXISTS batch_insert ON batch;
DROP POLICY IF EXISTS batch_update ON batch;
DROP POLICY IF EXISTS batch_delete ON batch;
CREATE POLICY batch_select ON batch
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY batch_insert ON batch
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY batch_update ON batch
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY batch_delete ON batch
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: board
ALTER TABLE board ENABLE ROW LEVEL SECURITY;
ALTER TABLE board FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS board_isolation ON board;
DROP POLICY IF EXISTS board_select ON board;
DROP POLICY IF EXISTS board_insert ON board;
DROP POLICY IF EXISTS board_update ON board;
DROP POLICY IF EXISTS board_delete ON board;
CREATE POLICY board_select ON board
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY board_insert ON board
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY board_update ON board
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY board_delete ON board
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: campaign
ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_isolation ON campaign;
DROP POLICY IF EXISTS campaign_select ON campaign;
DROP POLICY IF EXISTS campaign_insert ON campaign;
DROP POLICY IF EXISTS campaign_update ON campaign;
DROP POLICY IF EXISTS campaign_delete ON campaign;
CREATE POLICY campaign_select ON campaign
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_insert ON campaign
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_update ON campaign
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_delete ON campaign
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: campaign_template_revision
ALTER TABLE campaign_template_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_revision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_template_revision_isolation ON campaign_template_revision;
DROP POLICY IF EXISTS campaign_template_revision_select ON campaign_template_revision;
DROP POLICY IF EXISTS campaign_template_revision_insert ON campaign_template_revision;
DROP POLICY IF EXISTS campaign_template_revision_update ON campaign_template_revision;
DROP POLICY IF EXISTS campaign_template_revision_delete ON campaign_template_revision;
CREATE POLICY campaign_template_revision_select ON campaign_template_revision
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_template_revision_insert ON campaign_template_revision
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_template_revision_update ON campaign_template_revision
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_template_revision_delete ON campaign_template_revision
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: campaign_version
ALTER TABLE campaign_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_version_isolation ON campaign_version;
DROP POLICY IF EXISTS campaign_version_select ON campaign_version;
DROP POLICY IF EXISTS campaign_version_insert ON campaign_version;
DROP POLICY IF EXISTS campaign_version_update ON campaign_version;
DROP POLICY IF EXISTS campaign_version_delete ON campaign_version;
CREATE POLICY campaign_version_select ON campaign_version
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_version_insert ON campaign_version
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_version_update ON campaign_version
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY campaign_version_delete ON campaign_version
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: contact
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_isolation ON contact;
DROP POLICY IF EXISTS contact_select ON contact;
DROP POLICY IF EXISTS contact_insert ON contact;
DROP POLICY IF EXISTS contact_update ON contact;
DROP POLICY IF EXISTS contact_delete ON contact;
CREATE POLICY contact_select ON contact
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY contact_insert ON contact
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY contact_update ON contact
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY contact_delete ON contact
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: delivery
ALTER TABLE delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_isolation ON delivery;
DROP POLICY IF EXISTS delivery_select ON delivery;
DROP POLICY IF EXISTS delivery_insert ON delivery;
DROP POLICY IF EXISTS delivery_update ON delivery;
DROP POLICY IF EXISTS delivery_delete ON delivery;
CREATE POLICY delivery_select ON delivery
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delivery_insert ON delivery
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delivery_update ON delivery
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY delivery_delete ON delivery
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: domain
ALTER TABLE domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domain_isolation ON domain;
DROP POLICY IF EXISTS domain_select ON domain;
DROP POLICY IF EXISTS domain_insert ON domain;
DROP POLICY IF EXISTS domain_update ON domain;
DROP POLICY IF EXISTS domain_delete ON domain;
CREATE POLICY domain_select ON domain
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_insert ON domain
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_update ON domain
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_delete ON domain
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: domain_health_snapshot
ALTER TABLE domain_health_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_health_snapshot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domain_health_snapshot_isolation ON domain_health_snapshot;
DROP POLICY IF EXISTS domain_health_snapshot_select ON domain_health_snapshot;
DROP POLICY IF EXISTS domain_health_snapshot_insert ON domain_health_snapshot;
DROP POLICY IF EXISTS domain_health_snapshot_update ON domain_health_snapshot;
DROP POLICY IF EXISTS domain_health_snapshot_delete ON domain_health_snapshot;
CREATE POLICY domain_health_snapshot_select ON domain_health_snapshot
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_health_snapshot_insert ON domain_health_snapshot
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_health_snapshot_update ON domain_health_snapshot
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY domain_health_snapshot_delete ON domain_health_snapshot
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: endpoint
ALTER TABLE endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS endpoint_isolation ON endpoint;
DROP POLICY IF EXISTS endpoint_select ON endpoint;
DROP POLICY IF EXISTS endpoint_insert ON endpoint;
DROP POLICY IF EXISTS endpoint_update ON endpoint;
DROP POLICY IF EXISTS endpoint_delete ON endpoint;
CREATE POLICY endpoint_select ON endpoint
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_insert ON endpoint
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_update ON endpoint
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_delete ON endpoint
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: endpoint_audit
ALTER TABLE endpoint_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoint_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS endpoint_audit_isolation ON endpoint_audit;
DROP POLICY IF EXISTS endpoint_audit_select ON endpoint_audit;
DROP POLICY IF EXISTS endpoint_audit_insert ON endpoint_audit;
DROP POLICY IF EXISTS endpoint_audit_update ON endpoint_audit;
DROP POLICY IF EXISTS endpoint_audit_delete ON endpoint_audit;
CREATE POLICY endpoint_audit_select ON endpoint_audit
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_audit_insert ON endpoint_audit
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_audit_update ON endpoint_audit
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY endpoint_audit_delete ON endpoint_audit
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: enrollment
ALTER TABLE enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrollment_isolation ON enrollment;
DROP POLICY IF EXISTS enrollment_select ON enrollment;
DROP POLICY IF EXISTS enrollment_insert ON enrollment;
DROP POLICY IF EXISTS enrollment_update ON enrollment;
DROP POLICY IF EXISTS enrollment_delete ON enrollment;
CREATE POLICY enrollment_select ON enrollment
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY enrollment_insert ON enrollment
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY enrollment_update ON enrollment
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY enrollment_delete ON enrollment
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: exclusion
ALTER TABLE exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE exclusion FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exclusion_isolation ON exclusion;
DROP POLICY IF EXISTS exclusion_select ON exclusion;
DROP POLICY IF EXISTS exclusion_insert ON exclusion;
DROP POLICY IF EXISTS exclusion_update ON exclusion;
DROP POLICY IF EXISTS exclusion_delete ON exclusion;
CREATE POLICY exclusion_select ON exclusion
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY exclusion_insert ON exclusion
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY exclusion_update ON exclusion
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY exclusion_delete ON exclusion
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: external_ref
ALTER TABLE external_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_ref FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_ref_isolation ON external_ref;
DROP POLICY IF EXISTS external_ref_select ON external_ref;
DROP POLICY IF EXISTS external_ref_insert ON external_ref;
DROP POLICY IF EXISTS external_ref_update ON external_ref;
DROP POLICY IF EXISTS external_ref_delete ON external_ref;
CREATE POLICY external_ref_select ON external_ref
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY external_ref_insert ON external_ref
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY external_ref_update ON external_ref
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY external_ref_delete ON external_ref
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: field_def
ALTER TABLE field_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_def FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_def_isolation ON field_def;
DROP POLICY IF EXISTS field_def_select ON field_def;
DROP POLICY IF EXISTS field_def_insert ON field_def;
DROP POLICY IF EXISTS field_def_update ON field_def;
DROP POLICY IF EXISTS field_def_delete ON field_def;
CREATE POLICY field_def_select ON field_def
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY field_def_insert ON field_def
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY field_def_update ON field_def
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY field_def_delete ON field_def
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: inbox
ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_isolation ON inbox;
DROP POLICY IF EXISTS inbox_select ON inbox;
DROP POLICY IF EXISTS inbox_insert ON inbox;
DROP POLICY IF EXISTS inbox_update ON inbox;
DROP POLICY IF EXISTS inbox_delete ON inbox;
CREATE POLICY inbox_select ON inbox
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_insert ON inbox
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_update ON inbox
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_delete ON inbox
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: inbox_change
ALTER TABLE inbox_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_change FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_change_isolation ON inbox_change;
DROP POLICY IF EXISTS inbox_change_select ON inbox_change;
DROP POLICY IF EXISTS inbox_change_insert ON inbox_change;
DROP POLICY IF EXISTS inbox_change_update ON inbox_change;
DROP POLICY IF EXISTS inbox_change_delete ON inbox_change;
CREATE POLICY inbox_change_select ON inbox_change
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_change_insert ON inbox_change
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_change_update ON inbox_change
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_change_delete ON inbox_change
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: inbox_tag
ALTER TABLE inbox_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_tag_isolation ON inbox_tag;
DROP POLICY IF EXISTS inbox_tag_select ON inbox_tag;
DROP POLICY IF EXISTS inbox_tag_insert ON inbox_tag;
DROP POLICY IF EXISTS inbox_tag_update ON inbox_tag;
DROP POLICY IF EXISTS inbox_tag_delete ON inbox_tag;
CREATE POLICY inbox_tag_select ON inbox_tag
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_tag_insert ON inbox_tag
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_tag_update ON inbox_tag
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY inbox_tag_delete ON inbox_tag
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: interaction
ALTER TABLE interaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_isolation ON interaction;
DROP POLICY IF EXISTS interaction_select ON interaction;
DROP POLICY IF EXISTS interaction_insert ON interaction;
DROP POLICY IF EXISTS interaction_update ON interaction;
DROP POLICY IF EXISTS interaction_delete ON interaction;
CREATE POLICY interaction_select ON interaction
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY interaction_insert ON interaction
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY interaction_update ON interaction
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY interaction_delete ON interaction
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: lead_signal
ALTER TABLE lead_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_signal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_signal_isolation ON lead_signal;
DROP POLICY IF EXISTS lead_signal_select ON lead_signal;
DROP POLICY IF EXISTS lead_signal_insert ON lead_signal;
DROP POLICY IF EXISTS lead_signal_update ON lead_signal;
DROP POLICY IF EXISTS lead_signal_delete ON lead_signal;
CREATE POLICY lead_signal_select ON lead_signal
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_signal_insert ON lead_signal
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_signal_update ON lead_signal
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_signal_delete ON lead_signal
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: lead_view
ALTER TABLE lead_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_view FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_view_isolation ON lead_view;
DROP POLICY IF EXISTS lead_view_select ON lead_view;
DROP POLICY IF EXISTS lead_view_insert ON lead_view;
DROP POLICY IF EXISTS lead_view_update ON lead_view;
DROP POLICY IF EXISTS lead_view_delete ON lead_view;
CREATE POLICY lead_view_select ON lead_view
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_view_insert ON lead_view
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_view_update ON lead_view
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY lead_view_delete ON lead_view
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: memory
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_isolation ON memory;
DROP POLICY IF EXISTS memory_select ON memory;
DROP POLICY IF EXISTS memory_insert ON memory;
DROP POLICY IF EXISTS memory_update ON memory;
DROP POLICY IF EXISTS memory_delete ON memory;
CREATE POLICY memory_select ON memory
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY memory_insert ON memory
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY memory_update ON memory
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY memory_delete ON memory
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: message
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_isolation ON message;
DROP POLICY IF EXISTS message_select ON message;
DROP POLICY IF EXISTS message_insert ON message;
DROP POLICY IF EXISTS message_update ON message;
DROP POLICY IF EXISTS message_delete ON message;
CREATE POLICY message_select ON message
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_insert ON message
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_update ON message
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_delete ON message
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: message_event
ALTER TABLE message_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_event_isolation ON message_event;
DROP POLICY IF EXISTS message_event_select ON message_event;
DROP POLICY IF EXISTS message_event_insert ON message_event;
DROP POLICY IF EXISTS message_event_update ON message_event;
DROP POLICY IF EXISTS message_event_delete ON message_event;
CREATE POLICY message_event_select ON message_event
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_event_insert ON message_event
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_event_update ON message_event
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY message_event_delete ON message_event
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: notification_outbox
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_outbox_isolation ON notification_outbox;
DROP POLICY IF EXISTS notification_outbox_select ON notification_outbox;
DROP POLICY IF EXISTS notification_outbox_insert ON notification_outbox;
DROP POLICY IF EXISTS notification_outbox_update ON notification_outbox;
DROP POLICY IF EXISTS notification_outbox_delete ON notification_outbox;
CREATE POLICY notification_outbox_select ON notification_outbox
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_insert ON notification_outbox
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_update ON notification_outbox
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_delete ON notification_outbox
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: notification_outbox_state
ALTER TABLE notification_outbox_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_outbox_state_isolation ON notification_outbox_state;
DROP POLICY IF EXISTS notification_outbox_state_select ON notification_outbox_state;
DROP POLICY IF EXISTS notification_outbox_state_insert ON notification_outbox_state;
DROP POLICY IF EXISTS notification_outbox_state_update ON notification_outbox_state;
DROP POLICY IF EXISTS notification_outbox_state_delete ON notification_outbox_state;
CREATE POLICY notification_outbox_state_select ON notification_outbox_state
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_state_insert ON notification_outbox_state
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_state_update ON notification_outbox_state
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY notification_outbox_state_delete ON notification_outbox_state
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: opportunity
ALTER TABLE opportunity ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opportunity_isolation ON opportunity;
DROP POLICY IF EXISTS opportunity_select ON opportunity;
DROP POLICY IF EXISTS opportunity_insert ON opportunity;
DROP POLICY IF EXISTS opportunity_update ON opportunity;
DROP POLICY IF EXISTS opportunity_delete ON opportunity;
CREATE POLICY opportunity_select ON opportunity
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY opportunity_insert ON opportunity
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY opportunity_update ON opportunity
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY opportunity_delete ON opportunity
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: organization
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_isolation ON organization;
DROP POLICY IF EXISTS organization_select ON organization;
DROP POLICY IF EXISTS organization_insert ON organization;
DROP POLICY IF EXISTS organization_update ON organization;
DROP POLICY IF EXISTS organization_delete ON organization;
CREATE POLICY organization_select ON organization
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_insert ON organization
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_update ON organization
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_delete ON organization
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: organization_edge
ALTER TABLE organization_edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_edge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_edge_isolation ON organization_edge;
DROP POLICY IF EXISTS organization_edge_select ON organization_edge;
DROP POLICY IF EXISTS organization_edge_insert ON organization_edge;
DROP POLICY IF EXISTS organization_edge_update ON organization_edge;
DROP POLICY IF EXISTS organization_edge_delete ON organization_edge;
CREATE POLICY organization_edge_select ON organization_edge
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_edge_insert ON organization_edge
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_edge_update ON organization_edge
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY organization_edge_delete ON organization_edge
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: people_audit
ALTER TABLE people_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS people_audit_isolation ON people_audit;
DROP POLICY IF EXISTS people_audit_select ON people_audit;
DROP POLICY IF EXISTS people_audit_insert ON people_audit;
DROP POLICY IF EXISTS people_audit_update ON people_audit;
DROP POLICY IF EXISTS people_audit_delete ON people_audit;
CREATE POLICY people_audit_select ON people_audit
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY people_audit_insert ON people_audit
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY people_audit_update ON people_audit
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY people_audit_delete ON people_audit
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: pipeline_stage
ALTER TABLE pipeline_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_stage_isolation ON pipeline_stage;
DROP POLICY IF EXISTS pipeline_stage_select ON pipeline_stage;
DROP POLICY IF EXISTS pipeline_stage_insert ON pipeline_stage;
DROP POLICY IF EXISTS pipeline_stage_update ON pipeline_stage;
DROP POLICY IF EXISTS pipeline_stage_delete ON pipeline_stage;
CREATE POLICY pipeline_stage_select ON pipeline_stage
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pipeline_stage_insert ON pipeline_stage
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pipeline_stage_update ON pipeline_stage
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY pipeline_stage_delete ON pipeline_stage
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: proof_point
ALTER TABLE proof_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_point FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS proof_point_isolation ON proof_point;
DROP POLICY IF EXISTS proof_point_select ON proof_point;
DROP POLICY IF EXISTS proof_point_insert ON proof_point;
DROP POLICY IF EXISTS proof_point_update ON proof_point;
DROP POLICY IF EXISTS proof_point_delete ON proof_point;
CREATE POLICY proof_point_select ON proof_point
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY proof_point_insert ON proof_point
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY proof_point_update ON proof_point
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY proof_point_delete ON proof_point
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: provider_order
ALTER TABLE provider_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_order_isolation ON provider_order;
DROP POLICY IF EXISTS provider_order_select ON provider_order;
DROP POLICY IF EXISTS provider_order_insert ON provider_order;
DROP POLICY IF EXISTS provider_order_update ON provider_order;
DROP POLICY IF EXISTS provider_order_delete ON provider_order;
CREATE POLICY provider_order_select ON provider_order
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_order_insert ON provider_order
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_order_update ON provider_order
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_order_delete ON provider_order
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: provider_scope
ALTER TABLE provider_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_scope FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_scope_isolation ON provider_scope;
DROP POLICY IF EXISTS provider_scope_select ON provider_scope;
DROP POLICY IF EXISTS provider_scope_insert ON provider_scope;
DROP POLICY IF EXISTS provider_scope_update ON provider_scope;
DROP POLICY IF EXISTS provider_scope_delete ON provider_scope;
CREATE POLICY provider_scope_select ON provider_scope
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_scope_insert ON provider_scope
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_scope_update ON provider_scope
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY provider_scope_delete ON provider_scope
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: saved_query
ALTER TABLE saved_query ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_query FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_query_isolation ON saved_query;
DROP POLICY IF EXISTS saved_query_select ON saved_query;
DROP POLICY IF EXISTS saved_query_insert ON saved_query;
DROP POLICY IF EXISTS saved_query_update ON saved_query;
DROP POLICY IF EXISTS saved_query_delete ON saved_query;
CREATE POLICY saved_query_select ON saved_query
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY saved_query_insert ON saved_query
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY saved_query_update ON saved_query
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY saved_query_delete ON saved_query
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: send_request
ALTER TABLE send_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_request FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS send_request_isolation ON send_request;
DROP POLICY IF EXISTS send_request_select ON send_request;
DROP POLICY IF EXISTS send_request_insert ON send_request;
DROP POLICY IF EXISTS send_request_update ON send_request;
DROP POLICY IF EXISTS send_request_delete ON send_request;
CREATE POLICY send_request_select ON send_request
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY send_request_insert ON send_request
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY send_request_update ON send_request
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY send_request_delete ON send_request
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: sender_app_trust
ALTER TABLE sender_app_trust ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_app_trust FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sender_app_trust_isolation ON sender_app_trust;
DROP POLICY IF EXISTS sender_app_trust_select ON sender_app_trust;
DROP POLICY IF EXISTS sender_app_trust_insert ON sender_app_trust;
DROP POLICY IF EXISTS sender_app_trust_update ON sender_app_trust;
DROP POLICY IF EXISTS sender_app_trust_delete ON sender_app_trust;
CREATE POLICY sender_app_trust_select ON sender_app_trust
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_app_trust_insert ON sender_app_trust
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_app_trust_update ON sender_app_trust
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_app_trust_delete ON sender_app_trust
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: sender_connection
ALTER TABLE sender_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_connection FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sender_connection_isolation ON sender_connection;
DROP POLICY IF EXISTS sender_connection_select ON sender_connection;
DROP POLICY IF EXISTS sender_connection_insert ON sender_connection;
DROP POLICY IF EXISTS sender_connection_update ON sender_connection;
DROP POLICY IF EXISTS sender_connection_delete ON sender_connection;
CREATE POLICY sender_connection_select ON sender_connection
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_connection_insert ON sender_connection
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_connection_update ON sender_connection
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY sender_connection_delete ON sender_connection
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: signal
ALTER TABLE signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signal_isolation ON signal;
DROP POLICY IF EXISTS signal_select ON signal;
DROP POLICY IF EXISTS signal_insert ON signal;
DROP POLICY IF EXISTS signal_update ON signal;
DROP POLICY IF EXISTS signal_delete ON signal;
CREATE POLICY signal_select ON signal
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_insert ON signal
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_update ON signal
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_delete ON signal
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: signal_assessment
ALTER TABLE signal_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_assessment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signal_assessment_isolation ON signal_assessment;
DROP POLICY IF EXISTS signal_assessment_select ON signal_assessment;
DROP POLICY IF EXISTS signal_assessment_insert ON signal_assessment;
DROP POLICY IF EXISTS signal_assessment_update ON signal_assessment;
DROP POLICY IF EXISTS signal_assessment_delete ON signal_assessment;
CREATE POLICY signal_assessment_select ON signal_assessment
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_assessment_insert ON signal_assessment
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_assessment_update ON signal_assessment
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_assessment_delete ON signal_assessment
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: signal_evidence_for
ALTER TABLE signal_evidence_for ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_evidence_for FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signal_evidence_for_isolation ON signal_evidence_for;
DROP POLICY IF EXISTS signal_evidence_for_select ON signal_evidence_for;
DROP POLICY IF EXISTS signal_evidence_for_insert ON signal_evidence_for;
DROP POLICY IF EXISTS signal_evidence_for_update ON signal_evidence_for;
DROP POLICY IF EXISTS signal_evidence_for_delete ON signal_evidence_for;
CREATE POLICY signal_evidence_for_select ON signal_evidence_for
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_evidence_for_insert ON signal_evidence_for
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_evidence_for_update ON signal_evidence_for
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_evidence_for_delete ON signal_evidence_for
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: signal_type
ALTER TABLE signal_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_type FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signal_type_isolation ON signal_type;
DROP POLICY IF EXISTS signal_type_select ON signal_type;
DROP POLICY IF EXISTS signal_type_insert ON signal_type;
DROP POLICY IF EXISTS signal_type_update ON signal_type;
DROP POLICY IF EXISTS signal_type_delete ON signal_type;
CREATE POLICY signal_type_select ON signal_type
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_type_insert ON signal_type
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_type_update ON signal_type
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY signal_type_delete ON signal_type
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: suppression_mirror
ALTER TABLE suppression_mirror ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_mirror FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppression_mirror_isolation ON suppression_mirror;
DROP POLICY IF EXISTS suppression_mirror_select ON suppression_mirror;
DROP POLICY IF EXISTS suppression_mirror_insert ON suppression_mirror;
DROP POLICY IF EXISTS suppression_mirror_update ON suppression_mirror;
DROP POLICY IF EXISTS suppression_mirror_delete ON suppression_mirror;
CREATE POLICY suppression_mirror_select ON suppression_mirror
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY suppression_mirror_insert ON suppression_mirror
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY suppression_mirror_update ON suppression_mirror
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY suppression_mirror_delete ON suppression_mirror
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: task_audit
ALTER TABLE task_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_audit_isolation ON task_audit;
DROP POLICY IF EXISTS task_audit_select ON task_audit;
DROP POLICY IF EXISTS task_audit_insert ON task_audit;
DROP POLICY IF EXISTS task_audit_update ON task_audit;
DROP POLICY IF EXISTS task_audit_delete ON task_audit;
CREATE POLICY task_audit_select ON task_audit
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY task_audit_insert ON task_audit
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY task_audit_update ON task_audit
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY task_audit_delete ON task_audit
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: tasks
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_isolation ON tasks;
DROP POLICY IF EXISTS tasks_select ON tasks;
DROP POLICY IF EXISTS tasks_insert ON tasks;
DROP POLICY IF EXISTS tasks_update ON tasks;
DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_select ON tasks
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY tasks_insert ON tasks
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY tasks_update ON tasks
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY tasks_delete ON tasks
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: todo
ALTER TABLE todo ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS todo_isolation ON todo;
DROP POLICY IF EXISTS todo_select ON todo;
DROP POLICY IF EXISTS todo_insert ON todo;
DROP POLICY IF EXISTS todo_update ON todo;
DROP POLICY IF EXISTS todo_delete ON todo;
CREATE POLICY todo_select ON todo
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_insert ON todo
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_update ON todo
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_delete ON todo
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: todo_activity
ALTER TABLE todo_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS todo_activity_isolation ON todo_activity;
DROP POLICY IF EXISTS todo_activity_select ON todo_activity;
DROP POLICY IF EXISTS todo_activity_insert ON todo_activity;
DROP POLICY IF EXISTS todo_activity_update ON todo_activity;
DROP POLICY IF EXISTS todo_activity_delete ON todo_activity;
CREATE POLICY todo_activity_select ON todo_activity
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_activity_insert ON todo_activity
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_activity_update ON todo_activity
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY todo_activity_delete ON todo_activity
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

-- table: webhook_delivery
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_delivery_isolation ON webhook_delivery;
DROP POLICY IF EXISTS webhook_delivery_select ON webhook_delivery;
DROP POLICY IF EXISTS webhook_delivery_insert ON webhook_delivery;
DROP POLICY IF EXISTS webhook_delivery_update ON webhook_delivery;
DROP POLICY IF EXISTS webhook_delivery_delete ON webhook_delivery;
CREATE POLICY webhook_delivery_select ON webhook_delivery
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = ANY (string_to_array(current_setting('app.allowed_workspaces', true), ',')) OR current_setting('app.role', true) = 'system'));
CREATE POLICY webhook_delivery_insert ON webhook_delivery
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY webhook_delivery_update ON webhook_delivery
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));
CREATE POLICY webhook_delivery_delete ON webhook_delivery
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true) AND (workspace_id = current_setting('app.workspace_id', true) OR current_setting('app.role', true) = 'system'));

