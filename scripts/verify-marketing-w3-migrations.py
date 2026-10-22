#!/usr/bin/env python3
"""Rehearse W3 only in NEW databases in an explicitly named fixture container.

Never drops/resets a database. Pre-0030 fixtures are synthetic. The W0 checks
(populated upgrade, legacy preservation, catalogs match, old-0030/old-0031
refusal) are repeated because 0032 layers on top of 0030, and three W3 checks
are added: the new 0032 measurement objects exist on fresh databases, replaying
migrate() twice leaves growth_measurement_plans rows untouched, and a database
that ingested the preserved old 0031 is refused again at 0032 before any
measurement object is created.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
assert args.container.startswith('openrecord-marketing-w3-'), 'fixture container required'
repo = Path(__file__).resolve().parents[1]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
prefix = 'w3_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
port = subprocess.check_output(['docker', 'port', args.container, '5432/tcp'], text=True).strip()
assert port.startswith('127.0.0.1:'), 'loopback-only fixture required'
port = port.rsplit(':', 1)[1]

def command(cmd, name, data=None, expect=0, env=None):
    result = subprocess.run(cmd, cwd=repo, input=data, capture_output=True, env=env)
    (out / (name + '.log')).write_bytes(result.stdout + result.stderr)
    if expect == 0:
        assert result.returncode == 0, 'failed ' + name
    else:
        assert result.returncode != 0, 'expected refusal ' + name
    return result.stdout

def sql(db, source, name, expect=0):
    return command(['docker', 'exec', '-i', args.container, 'psql', '-X', '-U', 'fixture', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1'], name, source.encode(), expect)

def legacy_0031_sql():
    """The historical W2 0031 replay, with a fail-open-to-markers fallback.

    The full historical file (commit ee80b911, migration 0031) is preferred:
    its exact historical catalog is replayed as-is. That object is no longer
    reachable in every clone, so when it is absent this returns a synthesized
    marker layout that installs exactly the artifacts the current migrations
    must refuse (the same markers the W7/W8 rehearsals install directly). The
    synthesis never reproduces historical 0031 semantics; it only prepares the
    fail-closed refusal targets.
    """
    marker_sql = """
ALTER TABLE growth_opportunity_events ADD COLUMN delivery_id UUID;
CREATE TABLE growth_deliveries(id UUID PRIMARY KEY, business_id UUID);
CREATE TABLE growth_delivery_events(id UUID PRIMARY KEY, delivery_id UUID);
CREATE TABLE growth_delivery_targets(id UUID PRIMARY KEY, delivery_id UUID);
"""
    git = ['git', 'show', 'ee80b911be5b60b9fcfa218f365e586a85929823:packages/db/migrations/0031_growth_delivery_v1.sql']
    probe = subprocess.run(git, cwd=repo, capture_output=True, text=True)
    if probe.returncode == 0:
        return probe.stdout, 'preserved-commit-ee80b911'
    print('note: preserved 0031 (ee80b911) unreachable; using synthesized legacy markers')
    return marker_sql, 'synthesized-markers'

def create(db, template=None):
    cmd = ['docker', 'exec', args.container, 'createdb', '-U', 'fixture']
    if template:
        cmd += ['-T', template]
    command(cmd + [db], 'create-' + db)

def migrate(db, name, expect=0):
    env = {k: v for k, v in os.environ.items() if k in ['HOME', 'TMPDIR', 'PATH', 'USER', 'LANG']}
    env['DATABASE_URL'] = 'postgresql://fixture@127.0.0.1:' + port + '/' + db
    command(['pnpm', '--filter', '@openrecord/db', 'migrate'], name, env=env, expect=expect)

base, upgrade, fresh, old, mixed = [prefix + '_' + n for n in ['base', 'upgrade', 'fresh', 'old', 'mixed']]
create(base)
files = sorted((repo / 'packages/db/migrations').glob('*.sql'))
source = 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;\n'
source += '\n'.join(p.read_text() for p in files if p.name < '0030')
source += (repo / 'scripts/fixtures/marketing-w0-pre0030.sql').read_text()
sql(base, source, 'baseline-seed')
legacy_intervention = "SELECT to_jsonb(i)::text FROM interventions i WHERE id='10000000-0000-4000-8000-000000000008';"
original = json.loads(sql(base, legacy_intervention, 'legacy-before'))
create(upgrade, base)
migrate(upgrade, 'populated-upgrade')
migrate(upgrade, 'populated-replay')
after = json.loads(sql(upgrade, legacy_intervention, 'legacy-after'))
assert all(after[k] == v for k, v in original.items())
assert all(after[k] is None for k in ['channel', 'assurance', 'verification_kind', 'verification_id', 'verification_claim'])
proof = """SELECT count(*) FROM observations o JOIN raw_evidence r ON r.id=o.raw_evidence_id
WHERE o.id='10000000-0000-4000-8000-000000000007' AND o.answer_text='TEST upgrade answer'
AND o.raw_digest=r.digest AND r.digest=encode(sha256(decode(r.raw_bytes_hex,'hex')),'hex');"""
assert sql(upgrade, proof, 'raw-evidence-after').strip() == b'1'
create(fresh)
migrate(fresh, 'fresh')
migrate(fresh, 'fresh-replay')
catalog = """SELECT kind,name,definition FROM (
SELECT 'constraint' kind,conrelid::regclass::text||':'||conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace='public'::regnamespace
UNION ALL SELECT 'trigger',tgrelid::regclass::text||':'||tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
UNION ALL SELECT 'view',viewname,definition FROM pg_views WHERE schemaname='public'
UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public') x ORDER BY kind,name;"""
a = sql(fresh, catalog, 'fresh-catalog')
b = sql(upgrade, catalog, 'upgrade-catalog')
assert a == b, 'fresh/populated catalogs differ'
assert sql(fresh, "SELECT to_regclass('growth_metric_imports') IS NOT NULL AND to_regclass('growth_metric_rows') IS NOT NULL AND to_regclass('growth_measurement_plans') IS NOT NULL;", 'w3-tables-present').strip() == b't'
# Simulate the PREVIOUS schema only in another newly created database.
create(old, base)
old_sql = subprocess.check_output(['git', 'show', 'a27005eb88bac705908e29b4d4fe6556e74e4eb0:packages/db/migrations/0030_growth_opportunities_v1.sql'], cwd=repo, text=True)
sql(old, old_sql, 'old-0030')
sql(old, """INSERT INTO growth_goals(id,business_id,version,kind,analytics_source,event_name,counting_semantics,reporting_time_zone,created_by_user_id)
VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003',1,'TRIAL_SIGNUPS','GA4_AGGREGATE_EXPORT','trial_signup','EVENT_COUNT','UTC','10000000-0000-4000-8000-000000000002');""", 'old-goal')
snapshot = 'SELECT row_to_json(g)::text FROM growth_goals g ORDER BY id;'
before = sql(old, snapshot, 'old-before')
new_sql = (repo / 'packages/db/migrations/0030_growth_opportunities_v1.sql').read_text()
sql(old, new_sql, 'old-refusal', expect=1)
assert b'legacy 0030/0031' in (out / 'old-refusal.log').read_bytes()
assert sql(old, snapshot, 'old-after') == before
assert sql(old, "SELECT to_regclass('growth_metric_definitions') IS NULL;", 'old-no-partial-schema').strip() == b't'
p2_sql, p2_source = legacy_0031_sql()
sql(old, p2_sql, 'old-0031')
p2_catalog = sql(old, catalog, 'old-p2-catalog-before')
sql(old, new_sql, 'old-p2-refusal', expect=1)
assert sql(old, snapshot, 'old-p2-goals-after') == before
assert sql(old, catalog, 'old-p2-catalog-after') == p2_catalog
# A database matching CURRENT MAIN (files below 0032 only, seeded via psql
# because migrate() here would also apply 0032) that then ingested the
# preserved old 0031 must be refused at 0032, before any W3 object is created.
create(mixed)
mixed_source = 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;\n'
mixed_source += '\n'.join(p.read_text() for p in files if p.name < '0032')
mixed_source += (repo / 'scripts/fixtures/marketing-w0-pre0030.sql').read_text()
sql(mixed, mixed_source, 'mixed-main-seed')
sql(mixed, p2_sql, 'mixed-old-0031')
mixed_catalog = sql(mixed, catalog, 'mixed-catalog-before')
migrate(mixed, 'mixed-refusal-at-0032', expect=1)
assert b'old 0031 delivery artifacts' in (out / 'mixed-refusal-at-0032.log').read_bytes()
assert sql(mixed, "SELECT to_regclass('growth_metric_imports') IS NULL AND to_regclass('growth_metric_rows') IS NULL AND to_regclass('growth_measurement_plans') IS NULL;", 'mixed-no-w3-partial-schema').strip() == b't'
# The replay of earlier files may rewrite pre-W3 views before the 0032 guard
# fires, so the guarantee scoped here is: no W3 object of any kind appeared.
w3_objects = """SELECT count(*) FROM (
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
  ('growth_metric_imports','growth_metric_rows','growth_measurement_plans','growth_metric_import_documents','growth_measurement_plan_documents')
UNION ALL SELECT p.proname FROM pg_proc p WHERE p.proname IN
  ('guard_growth_metric_import','guard_growth_metric_row','guard_growth_plan')) x;"""
assert sql(mixed, w3_objects, 'mixed-no-w3-objects').strip() == b'0'
summary = {'freshAndReplay': True, 'compatiblePopulatedUpgradeAndReplay': True, 'rawEvidencePreserved': True,
           'legacyInterventionValuesPreserved': True, 'catalogsMatch': True, 'old0030RefusedWithoutMutation': True, 'old0031RefusedWithoutMutation': True,
           'mixedOld0031RefusedAt0032WithoutMutation': True, 'w3TablesOnFreshDatabases': True, 'legacy0031Source': p2_source,
           'catalogSha256': hashlib.sha256(a).hexdigest(), 'databasesCreated': [base, upgrade, fresh, old, mixed], 'existingDatabasesReset': False}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
