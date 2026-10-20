#!/usr/bin/env python3
"""Rehearse W7 (0034, connected execution) only in NEW databases on a loopback PostgreSQL.

Never drops or resets a database. Checks:
- fresh install and replay (migrate() twice) create the W7 objects;
- a database at the pre-0034 lineage (W0-W5 with fixture rows) upgrades and
  replays, and its catalog then matches the fresh one;
- after a FULL replay the verification contract is intact: growth_execution_verified
  still checks merge evidence, and the initiative guard still holds a final
  decision while execution is unresolved (0030 re-creates the originals on
  every replay and 0034 must win);
- optional --populated-db (an existing database that already holds W7
  operations): replaying migrate() leaves every operation, event, evidence row,
  live check and receipt byte-identical;
- a database carrying the preserved old 0031 marker (the delivery_id column or
  the old delivery tables) is refused before any W7 object exists, by migrate()
  and by 0034 applied on its own.
The preserved P2 0031 file is not replayed; its marker is added directly.
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
parser.add_argument('--populated-db', help='existing database holding W5 reports; only read and replayed, never reset')
args = parser.parse_args()
admin = urlparse(args.admin_url)
assert admin.hostname in ('localhost', '127.0.0.1'), 'loopback-only database required'
repo = Path(__file__).resolve().parents[1]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
prefix = 'w7_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')

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
assert any(p.name.startswith('0034') for p in files)
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
w7_objects = """SELECT count(*) FROM (
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
 ('growth_execution_targets','growth_execution_operations','growth_execution_events','growth_execution_evidence','growth_execution_live_checks','growth_execution_jobs')
UNION ALL SELECT p.proname FROM pg_proc p WHERE p.proname IN ('guard_growth_execution_event','guard_growth_execution_evidence','guard_growth_execution_operation','growth_execution_state')) x;"""
# The guards that carry the claim, by what they must contain after any replay.
contract = """SELECT (SELECT prosrc FROM pg_proc WHERE proname='growth_execution_verified') LIKE '%PR_MERGE_CONFIRMED%'
  AND (SELECT prosrc FROM pg_proc WHERE proname='growth_execution_verified') LIKE '%approvedPatchSha256%'
  AND (SELECT prosrc FROM pg_proc WHERE proname='guard_growth_event') LIKE '%execution unresolved%'
  AND (SELECT count(*) FROM pg_proc WHERE proname='growth_execution_verified')=1;"""

fresh, upgrade, marked, marked_direct, tables_direct = [prefix + '_' + n for n in ['fresh', 'upgrade', 'marked', 'marked_direct', 'tables_direct']]
create(fresh)
migrate(fresh, 'fresh')
migrate(fresh, 'fresh-replay')
assert sql(fresh, w7_objects, 'fresh-w7-objects').strip() == b'10'
assert sql(fresh, contract, 'fresh-contract').strip() == b't', 'verification contract weakened after replay'

create(upgrade)
sql(upgrade, lineage('0034'), 'upgrade-seed-pre0034')
assert sql(upgrade, w7_objects, 'upgrade-before-w7').strip() == b'0'
legacy = "SELECT to_jsonb(i)::text FROM interventions i WHERE id='10000000-0000-4000-8000-000000000008';"
legacy_before = sql(upgrade, legacy, 'legacy-before')
migrate(upgrade, 'populated-upgrade')
migrate(upgrade, 'populated-replay')
assert sql(upgrade, legacy, 'legacy-after') == legacy_before, 'legacy intervention changed'
assert sql(upgrade, contract, 'upgrade-contract').strip() == b't', 'verification contract weakened after upgrade'
a = sql(fresh, catalog, 'fresh-catalog')
b = sql(upgrade, catalog, 'upgrade-catalog')
assert a == b, 'fresh/populated catalogs differ'
# No SYSTEM_VERIFIED row can be created by hand in a freshly upgraded database.
forged = "INSERT INTO interventions(business_id,type,target,performed_at,actor,channel,assurance,verification_kind,verification_id,verification_claim) SELECT business_id,'SOURCE_UPDATED','x',now(),'SYSTEM','WEBSITE','SYSTEM_VERIFIED','GROWTH_DELIVERY',gen_random_uuid(),'PR_MERGED' FROM interventions LIMIT 1;"
sql(upgrade, forged, 'forged-receipt-refused', expect=1)
assert b'execution system claim unverified' in (out / 'forged-receipt-refused.log').read_bytes()

populated = None
if args.populated_db:
    q = ("SELECT (SELECT count(*) FROM growth_execution_operations)||':'||(SELECT count(*) FROM growth_execution_events)||':'||(SELECT count(*) FROM growth_execution_evidence)||':'||"
         "(SELECT count(*) FROM growth_execution_live_checks)||':'||(SELECT count(*) FROM interventions WHERE verification_kind='GROWTH_DELIVERY')||':'||"
         "COALESCE(md5((SELECT string_agg(id::text||patch_sha256||md5(after_content)||md5(diff)||created_at::text,',' ORDER BY id) FROM growth_execution_operations)||"
         "(SELECT string_agg(id::text||state||revision::text||md5(detail::text)||created_at::text,',' ORDER BY id) FROM growth_execution_events)||"
         "(SELECT string_agg(id::text||kind||md5(detail::text)||observed_at::text,',' ORDER BY id) FROM growth_execution_evidence)||"
         "COALESCE((SELECT string_agg(id::text||result||checked_at::text,',' ORDER BY id) FROM growth_execution_live_checks),'')||"
         "COALESCE((SELECT string_agg(id::text||verification_id::text||performed_at::text,',' ORDER BY id) FROM interventions WHERE verification_kind='GROWTH_DELIVERY'),'')),'');")
    before = sql(args.populated_db, q, 'populated-execution-before')
    assert int(before.split(b':')[0]) > 0, 'populated database holds no execution operations'
    migrate(args.populated_db, 'populated-db-replay')
    after = sql(args.populated_db, q, 'populated-execution-after')
    assert before == after, 'replay changed execution records'
    assert sql(args.populated_db, contract, 'populated-contract').strip() == b't'
    populated = {'database': args.populated_db, 'operations': int(before.split(b':')[0]), 'receipts': int(before.split(b':')[4])}

# Old-0031 marker: refused by migrate() (already at 0032, before any W7 object) ...
create(marked)
sql(marked, lineage('0032'), 'marked-seed')
sql(marked, 'ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;', 'marked-old-0031')
migrate(marked, 'marked-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'marked-refusal.log').read_bytes()
assert sql(marked, w7_objects, 'marked-no-w7').strip() == b'0'
# ... by 0034 itself when the marker appears after 0033 ran ...
create(marked_direct)
sql(marked_direct, lineage('0034'), 'marked-direct-seed')
sql(marked_direct, 'ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;', 'marked-direct-old-0031')
sql(marked_direct, (repo / 'packages/db/migrations/0034_growth_connected_execution_v1.sql').read_text(), 'marked-direct-0034-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'marked-direct-0034-refusal.log').read_bytes()
assert sql(marked_direct, w7_objects, 'marked-direct-no-w7').strip() == b'0'
# ... and by the old delivery tables on their own.
create(tables_direct)
sql(tables_direct, lineage('0034'), 'tables-direct-seed')
sql(tables_direct, 'CREATE TABLE growth_deliveries(id UUID PRIMARY KEY);', 'tables-direct-old-0031')
sql(tables_direct, (repo / 'packages/db/migrations/0034_growth_connected_execution_v1.sql').read_text(), 'tables-direct-0034-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'tables-direct-0034-refusal.log').read_bytes()
assert sql(tables_direct, w7_objects, 'tables-direct-no-w7').strip() == b'0'

summary = {'freshAndReplay': True, 'populatedUpgradeAndReplay': True, 'legacyInterventionPreserved': True, 'catalogsMatch': True, 'verificationContractIntactAfterReplay': True,
           'forgedReceiptRefused': True, 'populatedExecutionReplayUnchanged': populated, 'old0031RefusedByMigrateWithoutW7Objects': True, 'old0031RefusedBy0034WithoutW7Objects': True,
           'old0031TablesRefusedBy0034': True, 'catalogSha256': hashlib.sha256(a).hexdigest(), 'databasesCreated': [fresh, upgrade, marked, marked_direct, tables_direct], 'existingDatabasesReset': False}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
