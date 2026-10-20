#!/usr/bin/env python3
"""Rehearse W5 (0033) only in NEW databases on a loopback PostgreSQL.

Never drops or resets a database. Checks:
- fresh install and replay (migrate() twice) create the W5 objects;
- a database at the pre-0033 lineage with W0 fixture rows upgrades and
  replays, and its catalog then matches the fresh one;
- optional --populated-db (an existing database that already holds W5
  reports): replaying migrate() leaves every report row byte-identical;
- a database carrying the preserved old 0031 marker column is refused before
  any W5 object exists, both by migrate() and by 0033 applied on its own.
The preserved P2 0031 file is not replayed; its marker column
(growth_opportunity_events.delivery_id) is added directly, which is exactly
what the 0032 and 0033 guards detect.
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
prefix = 'w5_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')

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
w5_objects = """SELECT count(*) FROM (
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('growth_reports','growth_report_shares')
UNION ALL SELECT p.proname FROM pg_proc p WHERE p.proname IN ('guard_growth_report','guard_growth_report_share')) x;"""

fresh, upgrade, marked, marked_direct = [prefix + '_' + n for n in ['fresh', 'upgrade', 'marked', 'marked_direct']]
create(fresh)
migrate(fresh, 'fresh')
migrate(fresh, 'fresh-replay')
assert sql(fresh, w5_objects, 'fresh-w5-objects').strip() == b'4'

create(upgrade)
sql(upgrade, lineage('0033'), 'upgrade-seed-pre0033')
assert sql(upgrade, w5_objects, 'upgrade-before-w5').strip() == b'0'
legacy = "SELECT to_jsonb(i)::text FROM interventions i WHERE id='10000000-0000-4000-8000-000000000008';"
legacy_before = sql(upgrade, legacy, 'legacy-before')
migrate(upgrade, 'populated-upgrade')
migrate(upgrade, 'populated-replay')
assert sql(upgrade, legacy, 'legacy-after') == legacy_before, 'legacy intervention changed'
a = sql(fresh, catalog, 'fresh-catalog')
b = sql(upgrade, catalog, 'upgrade-catalog')
assert a == b, 'fresh/populated catalogs differ'

populated = None
if args.populated_db:
    rows = "SELECT count(*)||':'||COALESCE(md5(string_agg(id::text||snapshot_digest||md5(snapshot_text)||published_at::text, ',' ORDER BY id)),'') FROM growth_reports;"
    shares = "SELECT count(*)||':'||COALESCE(md5(string_agg(id::text||public_id||status||COALESCE(revoked_at::text,''), ',' ORDER BY id)),'') FROM growth_report_shares;"
    before = (sql(args.populated_db, rows, 'populated-reports-before'), sql(args.populated_db, shares, 'populated-shares-before'))
    assert int(before[0].split(b':')[0]) > 0, 'populated database holds no reports'
    migrate(args.populated_db, 'populated-db-replay')
    after = (sql(args.populated_db, rows, 'populated-reports-after'), sql(args.populated_db, shares, 'populated-shares-after'))
    assert before == after, 'replay changed published reports or shares'
    populated = {'database': args.populated_db, 'reports': int(before[0].split(b':')[0]), 'shares': int(before[1].split(b':')[0])}

# Old-0031 marker: refused by migrate() (at 0032, before 0033) ...
create(marked)
sql(marked, lineage('0032'), 'marked-seed')
sql(marked, 'ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;', 'marked-old-0031')
migrate(marked, 'marked-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'marked-refusal.log').read_bytes()
assert sql(marked, w5_objects, 'marked-no-w5').strip() == b'0'
# ... and by 0033 itself when 0032 already ran before the marker appeared.
create(marked_direct)
sql(marked_direct, lineage('0033'), 'marked-direct-seed')
sql(marked_direct, 'ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;', 'marked-direct-old-0031')
sql(marked_direct, (repo / 'packages/db/migrations/0033_growth_reports_v1.sql').read_text(), 'marked-direct-0033-refusal', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'marked-direct-0033-refusal.log').read_bytes()
assert sql(marked_direct, w5_objects, 'marked-direct-no-w5').strip() == b'0'

summary = {'freshAndReplay': True, 'populatedUpgradeAndReplay': True, 'legacyInterventionPreserved': True, 'catalogsMatch': True,
           'populatedReportsReplayUnchanged': populated, 'old0031RefusedByMigrateWithoutW5Objects': True, 'old0031RefusedBy0033WithoutW5Objects': True,
           'catalogSha256': hashlib.sha256(a).hexdigest(), 'databasesCreated': [fresh, upgrade, marked, marked_direct], 'existingDatabasesReset': False}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
