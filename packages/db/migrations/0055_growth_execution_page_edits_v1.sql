-- Connected changes beyond noindex: a page's title, meta description or
-- canonical address, schema.org JSON-LD, or one image's alt text. Each is a
-- deterministic edit of one HTML file, prepared for review and published only
-- through the authorized pull request, exactly like the noindex change.
-- action_value holds what the edit writes, so the live check can confirm it.
-- 0034 declares the old one-kind check inside CREATE TABLE IF NOT EXISTS, so a
-- replay of 0034 never narrows this again.
ALTER TABLE growth_execution_operations DROP CONSTRAINT IF EXISTS growth_execution_operations_action_kind_check;
ALTER TABLE growth_execution_operations ADD CONSTRAINT growth_execution_operations_action_kind_check
  CHECK (action_kind IN ('REMOVE_NOINDEX_META','SET_TITLE','SET_META_DESCRIPTION','SET_CANONICAL','ADD_JSON_LD','SET_IMAGE_ALT'));
ALTER TABLE growth_execution_operations ADD COLUMN IF NOT EXISTS action_value JSONB;
ALTER TABLE growth_execution_operations DROP CONSTRAINT IF EXISTS growth_execution_operations_action_value_check;
ALTER TABLE growth_execution_operations ADD CONSTRAINT growth_execution_operations_action_value_check
  CHECK ((action_kind = 'REMOVE_NOINDEX_META' AND action_value IS NULL)
    OR (action_kind <> 'REMOVE_NOINDEX_META' AND jsonb_typeof(action_value) = 'object' AND octet_length(action_value::text) <= 20000));

CREATE OR REPLACE VIEW growth_execution_documents AS SELECT o.id, o.business_id, o.opportunity_id, o.created_at,
  jsonb_build_object('id',o.id,'businessId',o.business_id,'opportunityId',o.opportunity_id,'targetId',o.target_id,'owner',t.owner,'repository',t.repository,
    'baseBranch',o.base_branch,'actionKind',o.action_kind,'actionValue',o.action_value,'filePath',o.file_path,'liveUrl',o.live_url,'siteFindingId',o.site_finding_id,
    'baseCommitSha',o.base_commit_sha,'baseBlobSha',o.base_blob_sha,'beforeSha256',o.before_sha256,'afterSha256',o.after_sha256,'patchSha256',o.patch_sha256,
    'diff',o.diff,'rationale',o.rationale,'proposedBy',o.proposed_by,'createdByUserId',o.created_by_user_id,'createdAt',o.created_at,
    'state',last_event.state,'revision',last_event.revision,
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'state',e.state,'revision',e.revision,'actor',e.actor,'userId',e.user_id,
      'reason',e.reason,'detail',e.detail,'createdAt',e.created_at) ORDER BY e.revision) FROM growth_execution_events e WHERE e.operation_id=o.id),'[]'::jsonb),
    'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'kind',v.kind,'detail',v.detail,'observedAt',v.observed_at) ORDER BY v.observed_at,v.id)
      FROM growth_execution_evidence v WHERE v.operation_id=o.id),'[]'::jsonb),
    'liveChecks',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'result',c.result,'url',c.url,'httpStatus',c.http_status,'detail',c.detail,
      'bodyDigest',c.body_digest,'checkedAt',c.checked_at) ORDER BY c.checked_at DESC,c.id) FROM growth_execution_live_checks c WHERE c.operation_id=o.id),'[]'::jsonb),
    'receipt',(SELECT jsonb_build_object('interventionId',i.id,'claim',i.verification_claim,'mergedAt',i.performed_at,'mergeCommitSha',m.detail->>'mergeCommitSha','pullRequestUrl',i.target)
      FROM interventions i JOIN growth_initiative_actions a ON a.intervention_id=i.id AND a.business_id=i.business_id
      JOIN growth_execution_evidence m ON m.operation_id=o.id AND m.kind='PR_MERGE_CONFIRMED'
      WHERE i.verification_kind='GROWTH_DELIVERY' AND i.verification_id=o.id AND a.opportunity_id=o.opportunity_id LIMIT 1)) AS document
  FROM growth_execution_operations o JOIN growth_execution_targets t ON t.id=o.target_id AND t.business_id=o.business_id
  JOIN LATERAL (SELECT * FROM growth_execution_events e WHERE e.operation_id=o.id ORDER BY revision DESC LIMIT 1) last_event ON true;
