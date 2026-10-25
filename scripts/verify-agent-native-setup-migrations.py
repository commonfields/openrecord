#!/usr/bin/env python3
"""Rehearse 0036 (business_setups) in NEW scratch databases on a loopback PostgreSQL.

Never drops or modifies a database it did not create. Checks:
- fresh install: migrate() twice creates business_setups, its guard trigger and
  its unique (account, website host) index; the second run changes nothing;
- populated upgrade (--dump): a restored copy of a real database at an older
  lineage upgrades, every pre-existing table keeps its row count, and a second
  replay leaves every table's content byte-identical;
- the guard refuses a setup that names another account's business.
"""
import argparse
import datetime
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse, urlunparse

parser = argparse.ArgumentParser()
parser.add_argument('--admin-url', required=True, help='loopback postgres URL of a role allowed to CREATE DATABASE')
parser.add_argument('--dump', type=Path, help='pg_dump -Fc file of a populated database to rehearse an upgrade on a copy')
parser.add_argument('--restore-cmd', default='pg_restore', help='pg_restore command, e.g. "docker exec -i <container> pg_restore -U openrecord"')
args = parser.parse_args()
admin = urlparse(args.admin_url)
assert admin.hostname in ('localhost', '127.0.0.1'), 'loopback-only database required'
repo = Path(__file__).resolve().parents[1]
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')


def url_for(db: str) -> str:
    return urlunparse(admin._replace(path=f'/{db}'))


def psql(db: str, sql: str) -> str:
    return subprocess.run(['psql', url_for(db), '-v', 'ON_ERROR_STOP=1', '-Atc', sql], check=True, capture_output=True, text=True).stdout.strip()


def create(db: str) -> None:
    psql(admin.path.lstrip('/') or 'postgres', f'CREATE DATABASE "{db}"')


def migrate(db: str) -> None:
    subprocess.run(['pnpm', '-s', 'db:migrate'], cwd=repo, check=True, capture_output=True, env={**os.environ, 'DATABASE_URL': url_for(db)})


def tables(db: str) -> list[str]:
    return psql(db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1").splitlines()


def counts(db: str) -> dict[str, int]:
    return {t: int(psql(db, f'SELECT count(*) FROM "{t}"')) for t in tables(db)}


def content(db: str) -> dict[str, str]:
    return {t: psql(db, f'SELECT md5(coalesce(string_agg(x::text, \'|\' ORDER BY x::text), \'\')) FROM "{t}" x') for t in tables(db)}


def assert_setup_objects(db: str) -> None:
    assert psql(db, "SELECT to_regclass('public.business_setups') IS NOT NULL") == 't', 'business_setups missing'
    assert psql(db, "SELECT count(*) FROM pg_trigger WHERE tgname='business_setups_guard'") == '1', 'guard trigger missing'
    assert psql(db, "SELECT count(*) FROM pg_indexes WHERE tablename='business_setups' AND indexdef LIKE '%(account_id, website_host)%'") == '1', 'host uniqueness missing'


results = []

fresh = f'agent_native_fresh_{stamp}'
create(fresh)
migrate(fresh)
assert_setup_objects(fresh)
before = content(fresh)
migrate(fresh)
assert content(fresh) == before, 'second migrate changed a fresh database'
a1 = psql(fresh, "INSERT INTO accounts(name) VALUES('VERIFY a') RETURNING id").splitlines()[0]
a2 = psql(fresh, "INSERT INTO accounts(name) VALUES('VERIFY b') RETURNING id").splitlines()[0]
u = psql(fresh, "INSERT INTO users(email,password_hash) VALUES('verify@example.test','x') RETURNING id").splitlines()[0]
b2 = psql(fresh, f"INSERT INTO businesses(account_id,name) VALUES('{a2}','VERIFY foreign') RETURNING id").splitlines()[0]
refused = subprocess.run(['psql', url_for(fresh), '-v', 'ON_ERROR_STOP=1', '-Atc',
  f"INSERT INTO business_setups(account_id,business_id,website_url,website_host,started_by_user_id) VALUES('{a1}','{b2}','https://v.test/','v.test','{u}')"],
  capture_output=True, text=True)
assert refused.returncode != 0 and 'not in account' in refused.stderr, 'guard accepted a foreign business'
results.append(f'fresh install and replay: OK ({fresh})')
results.append('guard refuses a foreign business: OK')

if args.dump:
    populated = f'agent_native_populated_{stamp}'
    create(populated)
    with open(args.dump, 'rb') as dump:
        restore = subprocess.run([*args.restore_cmd.split(), '--no-owner', '-d', populated], stdin=dump, capture_output=True)
    assert restore.returncode == 0, restore.stderr.decode()[-2000:]
    pre = counts(populated)
    migrate(populated)
    assert_setup_objects(populated)
    post = counts(populated)
    changed = {t: (pre[t], post[t]) for t in pre if post.get(t) != pre[t]}
    assert not changed, f'row counts changed on upgrade: {changed}'
    assert post['business_setups'] == 0, 'upgrade created setups'
    snapshot = content(populated)
    migrate(populated)
    assert content(populated) == snapshot, 'replay changed a populated database'
    results.append(f'populated upgrade: OK ({len(pre)} pre-existing tables, {sum(pre.values())} rows unchanged; {populated})')

print('\n'.join(results))
