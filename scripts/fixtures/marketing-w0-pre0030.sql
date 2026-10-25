-- Deterministic TEST-only main-schema data, not a copy of business evidence.
INSERT INTO accounts(id,name) VALUES ('10000000-0000-4000-8000-000000000001','TEST upgrade agency');
INSERT INTO users(id,email,password_hash) VALUES ('10000000-0000-4000-8000-000000000002','upgrade@example.test','TEST-only');
INSERT INTO account_users(account_id,user_id) VALUES ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
INSERT INTO businesses(id,account_id,name) VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','TEST upgrade client');
INSERT INTO buyer_questions(id,business_id,prompt) VALUES ('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','TEST immutable upgrade question');
INSERT INTO check_runs(id,business_id,question_id,status,provider) VALUES ('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004','SUCCEEDED','mock');
INSERT INTO raw_evidence(id,digest,content_text,raw_bytes_hex) VALUES ('10000000-0000-4000-8000-000000000006',encode(digest('{"fixture":"upgrade"}','sha256'),'hex'),'{"fixture":"upgrade"}',encode(convert_to('{"fixture":"upgrade"}','UTF8'),'hex'));
INSERT INTO observations(id,business_id,check_run_id,provider,collected_at,answer_text,retrieval_mode,raw_evidence_id,raw_digest,synthetic)
SELECT '10000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000005','mock',now(),'TEST upgrade answer','unknown',id,digest,true FROM raw_evidence WHERE id='10000000-0000-4000-8000-000000000006';

INSERT INTO record_profiles(business_id,website_url,engagement) VALUES('10000000-0000-4000-8000-000000000003','https://upgrade.example.test','FIXTURE');
INSERT INTO interventions(id,business_id,type,target,performed_at,actor,notes) VALUES('10000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000003','OTHER','TEST preserved legacy action','2026-10-01T00:00:00Z','UNKNOWN','TEST no assurance asserted');
