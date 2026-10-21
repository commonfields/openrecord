#!/usr/bin/env python3
"""Rehearse W8 (0035, authenticated GA4 measurement) only in NEW databases on a loopback PostgreSQL.

Never drops or resets a database. Checks:
- fresh install and replay (migrate() twice) create the W8 objects, and after a
  FULL replay the W3 provenance check still admits AUTHENTICATED_PROVIDER_API
  (0032 is replayed first on every run and must not narrow it) and the deferred
  observation requirement is still installed;
- a database at the pre-0035 lineage (W0-W7 with fixture rows) upgrades and
  replays, and its catalog then matches the fresh one;
- an authenticated import without its observation is refused in the upgraded
  database, and a plaintext credential is refused;
- optional --populated-db (an existing database that already holds W3 imports,
  W5 reports and W7/W8 rows): replaying migrate() leaves every import, row,
  report snapshot, execution receipt and GA4 observation byte-identical;
- a database carrying the preserved old 0031 markers is refused by 0035 before
  any W8 object exists; 0035 also refuses to run before 0034.
The preserved P2 0031 file is never replayed; its marker is added directly.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse, urlunparse

parser = argparse.ArgumentParser()
parser.add_argument('--admin-url', required=True, help='loopback postgres URL of a role allowed to CREATE DATABASE')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--populated-db', help='existing database holding W3/W5/W7/W8 rows; only read and replayed, never reset')
args = parser.parse_args()
admin = urlparse(args.admin_url)
assert admin.hostname in ('localhost', '127.0.0.1'), 'loopback-only database required'
repo = Path(__file__).resolve().parents[1]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
prefix = 'w8_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')

def url_for(db):
    return urlunparse(admin._replace(path='/' + db))

def command(cmd, name, data=None, expect=0, env=None):
    result = subprocess.run(cmd, cwd=repo, input=data, capture_output=True, env=env)
    (out / (name + '.log')).write_bytes(result.stdout + result.stderr)
    if expect == 0:
        assert result.returncode == 0, 'failed ' + name
    else:
        assert result.returncode != 0, 'expected refusal ' + name
    return result.stdout

def sql(db, source, name, expect=0):
    return command(['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', url_for(db)], name, source.encode(), expect)

def create(db):
    sql(admin.path.lstrip('/') or 'postgres', f'CREATE DATABASE "{db}";', 'create-' + db)

def migrate(db, name, expect=0):
    env = {k: v for k, v in os.environ.items() if k in ['HOME', 'TMPDIR', 'PATH', 'USER', 'LANG']}
    env['DATABASE_URL'] = url_for(db)
    command(['pnpm', '--filter', '@openrecord/db', 'migrate'], name, env=env, expect=expect)

files = sorted((repo / 'packages/db/migrations').glob('*.sql'))
assert [p.name for p in files if p.name.startswith('0031')] == [], 'the preserved old 0031 must not be in the migration lineage'
w8_file = repo / 'packages/db/migrations/0035_growth_ga4_measurement_v1.sql'
assert w8_file in files
seed = (repo / 'scripts/fixtures/marketing-w0-pre0030.sql').read_text()

def lineage(below):
    """Files below `below`, with the synthetic pre-0030 fixture rows seeded before 0030."""
    return '\n'.join(['CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;',
                      '\n'.join(p.read_text() for p in files if p.name < '0030'), seed,
                      '\n'.join(p.read_text() for p in files if '0030' <= p.name < below)])
catalog = """SELECT kind,name,definition FROM (
SELECT 'constraint' kind,conrelid::regclass::text||':'||conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace='public'::regnamespace
UNION ALL SELECT 'trigger',tgrelid::regclass::text||':'||tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
UNION ALL SELECT 'view',viewname,definition FROM pg_views WHERE schemaname='public'
UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public') x ORDER BY kind,name;"""
w8_tables = ['growth_ga4_connections', 'growth_ga4_connection_events', 'growth_ga4_credentials', 'growth_ga4_oauth_states', 'growth_ga4_bindings',
             'growth_ga4_sync_jobs', 'growth_ga4_sync_runs', 'growth_ga4_observations']
w8_objects = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (" + ','.join(f"'{t}'" for t in w8_tables) + ");"
# What must hold after any replay.
contract = """SELECT pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='growth_metric_imports_provenance_check')) LIKE '%AUTHENTICATED_PROVIDER_API%'
  AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='growth_metric_imports_provenance_check')) LIKE '%OPERATOR_SUPPLIED_EXPORT%'
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_metric_import_requires_observation' AND tgdeferrable AND tginitdeferred)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_metric_import_guard')
  AND (SELECT prosrc FROM pg_proc WHERE proname='growth_execution_verified') LIKE '%PR_MERGE_CONFIRMED%';"""

fresh, upgrade, marked, tables_direct, early = [prefix + '_' + n for n in ['fresh', 'upgrade', 'marked', 'tables_direct', 'early']]
create(fresh)
migrate(fresh, 'fresh')
migrate(fresh, 'fresh-replay')
assert sql(fresh, w8_objects, 'fresh-w8-objects').strip() == str(len(w8_tables)).encode()
assert sql(fresh, contract, 'fresh-contract').strip() == b't', 'W8 contract weakened after replay'

create(upgrade)
sql(upgrade, lineage('0035'), 'upgrade-seed-pre0035')
assert sql(upgrade, w8_objects, 'upgrade-before-w8').strip() == b'0'
legacy = "SELECT to_jsonb(i)::text FROM interventions i WHERE id='10000000-0000-4000-8000-000000000008';"
legacy_before = sql(upgrade, legacy, 'legacy-before')
migrate(upgrade, 'populated-upgrade')
migrate(upgrade, 'populated-replay')
assert sql(upgrade, legacy, 'legacy-after') == legacy_before, 'legacy intervention changed'
assert sql(upgrade, contract, 'upgrade-contract').strip() == b't'
a = sql(fresh, catalog, 'fresh-catalog')
b = sql(upgrade, catalog, 'upgrade-catalog')
assert a == b, 'fresh/populated catalogs differ'
# A bare provider label is refused at commit; a plaintext credential is refused outright.
forged = """BEGIN;
INSERT INTO accounts(id,name) VALUES('20000000-0000-4000-8000-000000000001','w8 rehearsal');
INSERT INTO users(id,email,password_hash) VALUES('20000000-0000-4000-8000-000000000002','w8-rehearsal@example.test','x');
INSERT INTO account_users(account_id,user_id) VALUES('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
INSERT INTO businesses(id,account_id,name) VALUES('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','w8 rehearsal');
INSERT INTO record_profiles(business_id,website_url) VALUES('20000000-0000-4000-8000-000000000003','https://w8.test');
INSERT INTO growth_metric_definitions(id,business_id,version,conversion_kind,label,source_kind,source_identity,event_name,counting_semantics,unit,reporting_time_zone,property_ref,created_by_user_id)
  VALUES('20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003',1,'LEAD','Leads','GA4_AGGREGATE_EXPORT','w8','generate_lead','EVENT_COUNT','COUNT','UTC','1','20000000-0000-4000-8000-000000000002');
INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
  VALUES('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000004','GA4_AGGREGATE_EXPORT','AUTHENTICATED_PROVIDER_API','1','2026-09-01','2026-09-01','UTC','x',repeat('a',64),0,'20000000-0000-4000-8000-000000000002');
COMMIT;"""
sql(upgrade, forged, 'forged-provider-import-refused', expect=1)
assert b'without a ga4 observation' in (out / 'forged-provider-import-refused.log').read_bytes()
plaintext = """INSERT INTO growth_ga4_credentials(connection_id,account_id,refresh_ciphertext) VALUES(gen_random_uuid(),gen_random_uuid(),'1//plaintext');"""
sql(upgrade, plaintext, 'plaintext-credential-refused', expect=1)
assert b'check constraint' in (out / 'plaintext-credential-refused.log').read_bytes()

populated = None
if args.populated_db:
    q = ("SELECT (SELECT count(*) FROM growth_metric_imports)||':'||(SELECT count(*) FROM growth_reports)||':'||(SELECT count(*) FROM growth_ga4_observations)||':'||"
         "(SELECT count(*) FROM interventions WHERE verification_kind='GROWTH_DELIVERY')||':'||"
         "md5(COALESCE((SELECT string_agg(id::text||provenance||raw_digest||md5(raw_text)||imported_at::text,',' ORDER BY id) FROM growth_metric_imports),'')||"
         "COALESCE((SELECT string_agg(import_id::text||day::text||value::text,',' ORDER BY import_id,day) FROM growth_metric_rows),'')||"
         "COALESCE((SELECT string_agg(id::text||snapshot_digest||md5(snapshot_text)||evidence_digest,',' ORDER BY id) FROM growth_reports),'')||"
         "COALESCE((SELECT string_agg(import_id::text||response_digest||collected_at::text,',' ORDER BY import_id) FROM growth_ga4_observations),'')||"
         "COALESCE((SELECT string_agg(id::text||verification_id::text||performed_at::text,',' ORDER BY id) FROM interventions WHERE verification_kind='GROWTH_DELIVERY'),''));")
    before = sql(args.populated_db, q, 'populated-before')
    counts = [int(x) for x in before.split(b':')[:4]]
    assert counts[0] > 0 and counts[1] > 0, 'populated database holds no imports or reports'
    migrate(args.populated_db, 'populated-db-replay')
    after = sql(args.populated_db, q, 'populated-after')
    assert before == after, 'replay changed imports, reports, receipts or observations'
    assert sql(args.populated_db, contract, 'populated-contract').strip() == b't'
    populated = {'database': args.populated_db, 'imports': counts[0], 'reports': counts[1], 'ga4Observations': counts[2], 'executionReceipts': counts[3]}

# Old-0031 marker column, applied after 0034: 0035 refuses before creating anything ...
create(marked)
sql(marked, lineage('0035'), 'marked-seed')
sql(marked, 'ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;', 'marked-old-0031')
sql(marked, w8_file.read_text(), 'marked-0035-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'marked-0035-refusal.log').read_bytes()
assert sql(marked, w8_objects, 'marked-no-w8').strip() == b'0'
# ... as for the old delivery tables on their own ...
create(tables_direct)
sql(tables_direct, lineage('0035'), 'tables-direct-seed')
sql(tables_direct, 'CREATE TABLE growth_deliveries(id UUID PRIMARY KEY);', 'tables-direct-old-0031')
sql(tables_direct, w8_file.read_text(), 'tables-direct-0035-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'tables-direct-0035-refusal.log').read_bytes()
assert sql(tables_direct, w8_objects, 'tables-direct-no-w8').strip() == b'0'
# ... and 0035 never runs ahead of 0034.
create(early)
sql(early, lineage('0034'), 'early-seed')
sql(early, w8_file.read_text(), 'early-0035-refusal', expect=1)
assert b'run 0034 before 0035' in (out / 'early-0035-refusal.log').read_bytes()
assert sql(early, w8_objects, 'early-no-w8').strip() == b'0'

summary = {'freshAndReplay': True, 'populatedUpgradeAndReplay': True, 'legacyInterventionPreserved': True, 'catalogsMatch': True, 'provenanceContractIntactAfterReplay': True,
           'forgedProviderImportRefused': True, 'plaintextCredentialRefused': True, 'populatedReplayUnchanged': populated,
           'old0031ColumnRefusedBy0035WithoutW8Objects': True, 'old0031TablesRefusedBy0035': True, 'refusedBefore0034': True,
           'catalogSha256': hashlib.sha256(a).hexdigest(), 'databasesCreated': [fresh, upgrade, marked, tables_direct, early], 'existingDatabasesReset': False}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
