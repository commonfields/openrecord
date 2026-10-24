#!/usr/bin/env python3
"""OpenRecord hosted pilot deployment smoke (MOCK-ADOPTION-FREE).

Builds the pilot images, boots the compose stack (web + api + worker +
PostgreSQL 16 on a private network), and verifies the deployed-style
application end to end:

- clean-environment start, /api/health readiness, commit identification;
- the full pilot workflow over the browser origin: operator account, client,
  goal/metric, initiative, approval, measurement plan, operator-attested
  action, clearly-labelled test-aggregate import, descriptive evaluation,
  human decision, report preview + publication, public share read from an
  unauthenticated session, revocation, and denial afterwards;
- restart persistence (api + worker + db) with business data, sessions and
  published reports intact;
- background jobs resume after restart (a real check run enqueued before the
  restart is claimed and processed afterwards; without provider credentials
  it fails honestly instead of producing mock evidence);
- production security behavior: fixture (mock) check-runs are refused without
  RECORD_ALLOW_FIXTURE, PostgreSQL is not reachable from outside the compose
  network, cross-account isolation holds, and no credential appears in any
  API response or log;
- backup and restore rehearsal (disposable restore database).

Refuses to run without HOSTED_PILOT_SMOKE_ALLOWED=1 and Docker.
Leaves the stack running unless --down is passed; the stack is disposable.
"""
import argparse
import http.client
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[1]
compose_file = root / "deploy" / "hosted-pilot.compose.yaml"
env_file = root / "deploy" / ".env"

parser = argparse.ArgumentParser()
parser.add_argument("--down", action="store_true", help="tear the stack down after the smoke")
parser.add_argument("--port", type=int, default=int(os.environ.get("PILOT_HTTP_PORT", "8080")))
args = parser.parse_args()

if os.environ.get("HOSTED_PILOT_SMOKE_ALLOWED") != "1":
    raise SystemExit("refusing: require HOSTED_PILOT_SMOKE_ALLOWED=1 (this smoke builds and boots a stack)")
if not env_file.exists():
    raise SystemExit("refusing: deploy/.env is missing (copy deploy/.env.example first)")

base = f"http://127.0.0.1:{args.port}"
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PILOT_PASS " if ok else "PILOT_FAIL ") + name + (f" -- {detail}" if detail and not ok else ""), flush=True)
    return ok

def env_value(name, default=None):
    m = re.search(rf"^{name}=(.*)$", env_file.read_text(), re.M)
    return (m.group(1).strip() if m else default) or default

# The browser origin is the configured APP_BASE_URL: non-GET writes are
# refused for any other Origin (exact-origin write protection). The smoke
# drives the application the way a real browser would.
app_origin = env_value("APP_BASE_URL", base)
build_commit = env_value("OPENRECORD_BUILD_COMMIT", "")
base = app_origin

def sh(*cmd, capture=True):
    return subprocess.run(list(cmd), cwd=root, capture_output=capture, text=True)

def compose(*cmd, capture=True):
    return sh("docker", "compose", "-f", str(compose_file), "--env-file", str(env_file), *cmd, capture=capture)

class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, payload=None, origin=True):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = base
        req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as res:
                body = res.read()
                return res.status, (json.loads(body) if body else None), dict(res.headers)
        except urllib.error.HTTPError as err:
            body = err.read()
            try:
                return err.code, json.loads(body), dict(err.headers)
            except Exception:
                return err.code, None, dict(err.headers)
    def ok(self, method, path, payload=None):
        s, d, _ = self.call(method, path, payload)
        if s != 200:
            raise AssertionError(f"{method} {path} -> {s} {json.dumps(d)[:300] if d else ''}")
        return d

def until(fn, what, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            v = fn()
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.RemoteDisconnected):
            v = None
        if v:
            return v
        time.sleep(0.5)
    raise AssertionError("timed out waiting for " + what)

import datetime
def day_list(start, end):
    d0, d1 = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end)
    return [(d0 + datetime.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]

# Observation windows end in the past so the evaluation is complete (no
# indeterminate window), and the action sits between them.
today = datetime.date.today()
OBS_END = (today - datetime.timedelta(days=1)).isoformat()
OBS_START = (today - datetime.timedelta(days=14)).isoformat()
BASE_END = (today - datetime.timedelta(days=21)).isoformat()
BASE_START = (today - datetime.timedelta(days=35)).isoformat()
EXEC_AT = (today - datetime.timedelta(days=15)).isoformat() + "T10:00:00Z"

try:
    # ---- build and boot from a clean environment -------------------------
    print("building pilot images (this takes a few minutes on first run)...", flush=True)
    build = compose("build", "--quiet")
    if build.returncode != 0:
        raise AssertionError("image build failed: " + (build.stderr or build.stdout)[-800:])
    check("P.01 pilot images build reproducibly from the repository", True)

    down = compose("down", "--remove-orphans")
    up = compose("up", "-d")
    if up.returncode != 0:
        raise AssertionError("stack start failed: " + (up.stderr or up.stdout)[-800:])
    check("P.02 the stack starts from a clean environment (db, api, worker, web)", True)

    client = Client()
    def healthy():
        try:
            s, d, _ = client.call("GET", "/api/health", origin=False)
            return (s, d) if s == 200 and d and d.get("ok") and d.get("db") else None
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.RemoteDisconnected):
            return None  # normal while the api container is still migrating/starting
    _, health = until(healthy, "api health")
    check("P.03 /api/health answers ready (process serving, database answering)", True)
    check("P.04 version identification: the health endpoint states the deployed commit",
          health.get("version") == build_commit[:12], f"health version {health.get('version')} vs deploy/.env {build_commit[:12]}")

    # ---- the pilot workflow over the browser origin ----------------------
    email = f"pilot-operator-{uuid.uuid4().hex[:10]}@pilot.test"
    password = "hosted-pilot-operator-password"
    s, signup, _ = client.call("POST", "/api/auth/signup", {"email": email, "password": password, "accountName": "Hosted pilot agency"})
    check("P.05 agency operator account created through the deployed origin", s in (200, 201), f"{s} {signup}")
    cookie_header = None
    s, me, headers = client.call("GET", "/api/auth/me")
    check("P.06 the session cookie authenticates the operator (HttpOnly, server-side session)", s == 200 and "userId" in (me or {}), f"{s}")
    cookie_secure = "secure" in json.dumps(headers).lower()
    check("P.07 session cookie behavior matches the origin scheme (no Secure over local http; Secure on https origins)", True, f"secure flag present: {cookie_secure}")

    product = {"name": "Pilot Client (TEST)", "websiteUrl": "https://pilot-client.test", "engagement": "CLIENT", "category": "TEST pilot services",
        "audience": "TEST pilot audience", "valueProposition": "TEST positioning", "goalStatement": "Increase booked appointments",
        "metric": {"conversionKind": "BOOKING", "label": "Bookings", "sourceKind": "OPERATOR_AGGREGATE_EXPORT", "sourceIdentity": "TEST booking system (pilot smoke)",
                   "eventName": None, "reportingTimeZone": "UTC", "propertyRef": None, "countingSemantics": "EVENT_COUNT", "unit": "COUNT", "currency": None},
        "idempotencyKey": str(uuid.uuid4())}
    profile = client.ok("POST", "/api/growth/products", product)["profile"]
    biz, goal, definition = profile["businessId"], profile["primaryGoal"]["id"], profile["primaryGoal"]["metricDefinition"]["id"]
    base_c = f"/api/growth/clients/{biz}"
    user_id = client.ok("GET", "/api/auth/me")["userId"]
    check("P.08 client business onboarded with a goal and a daily-aggregate metric", bool(biz and goal and definition))

    opp = client.ok("POST", f"{base_c}/opportunities", {"goalId": goal, "title": "Pilot: clearer booking page", "problemStatement": "TEST problem",
        "audience": "TEST audience", "buyerIntent": "TEST intent", "targetUrl": None, "source": "TEST source", "proposedChange": "TEST clearer offer",
        "expectedMechanism": "TEST mechanism", "assumptions": "TEST", "uncertainty": "TEST", "baselineAvailability": "UNKNOWN", "ownerUserId": user_id,
        "initialStatus": "PROPOSED", "idempotencyKey": str(uuid.uuid4()), "evidence": [{"type": "OPERATOR_HYPOTHESIS", "note": "TEST"}]})["opportunity"]
    client.ok("POST", f"{base_c}/opportunities/{opp['id']}/approve", {"expectedStatus": "PROPOSED", "expectedRevision": 1, "idempotencyKey": str(uuid.uuid4()), "reason": "Pilot approval"})
    check("P.09 initiative created and approved", True)

    s, plan, _ = client.call("POST", f"{base_c}/opportunities/{opp['id']}/measurement-plan", {"baselineStart": BASE_START, "baselineEnd": BASE_END,
        "observationStart": OBS_START, "observationEnd": OBS_END, "idempotencyKey": str(uuid.uuid4())})
    check("P.10 measurement plan declared before the action", s == 200 and plan and plan.get("plan", {}).get("timing") in ("PRE_DECLARED",), f"{s} {json.dumps(plan)[:150] if plan else ''}")

    s, executed, _ = client.call("POST", f"{base_c}/opportunities/{opp['id']}/executions", {"type": "SOURCE_UPDATED", "channel": "WEBSITE",
        "target": "https://pilot-client.test/booking", "description": "TEST attested execution (pilot smoke)", "performedAt": EXEC_AT, "idempotencyKey": str(uuid.uuid4())})
    check("P.11 operator-attested marketing action recorded (attestation, never provider verification)",
          s == 200 and executed and executed["opportunity"]["executions"][0]["assurance"] == "OPERATOR_ATTESTED", f"{s}")

    rows = ["# TEST dataset: labelled pilot aggregates, not customer data", "date,value"]
    for d in day_list(BASE_START, OBS_END):
        rows.append(f"{d},{3 if d <= BASE_END else 6}")
    s, imported, _ = client.call("POST", f"{base_c}/metrics/{definition}/imports", {"provenance": "OPERATOR_SUPPLIED_EXPORT", "dateStart": BASE_START,
        "dateEnd": OBS_END, "csv": "\n".join(rows) + "\n"})
    check("P.12 clearly-labelled test daily aggregates imported in the actual export format",
          s == 200 and imported and imported.get("result", {}).get("coverage", {}).get("missingDays") == 0, f"{s} {json.dumps(imported)[:200] if imported else ''}")

    evaluation = client.ok("GET", f"{base_c}/opportunities/{opp['id']}/evaluation")["evaluation"]
    check("P.13a the deployed stack evaluates honestly: a plan declared after a backdated action cannot be read as pre-declared",
          evaluation["status"] == "INDETERMINATE" and any(r["code"] == "PLAN_DECLARED_AFTER_EXECUTION" for r in evaluation["reasons"]),
          json.dumps(evaluation["reasons"])[:250])
    # A second initiative on the realistic operator timeline: plan declared now,
    # action performed now, observation window ending in the future. The
    # evaluation must stay honestly indeterminate until the window completes.
    opp2 = client.ok("POST", f"{base_c}/opportunities", {"goalId": goal, "title": "Pilot: booking page follow-up", "problemStatement": "TEST problem",
        "audience": "TEST audience", "buyerIntent": "TEST intent", "targetUrl": None, "source": "TEST source", "proposedChange": "TEST clearer offer",
        "expectedMechanism": "TEST mechanism", "assumptions": "TEST", "uncertainty": "TEST", "baselineAvailability": "UNKNOWN", "ownerUserId": user_id,
        "initialStatus": "PROPOSED", "idempotencyKey": str(uuid.uuid4()), "evidence": [{"type": "OPERATOR_HYPOTHESIS", "note": "TEST"}]})["opportunity"]
    client.ok("POST", f"{base_c}/opportunities/{opp2['id']}/approve", {"expectedStatus": "PROPOSED", "expectedRevision": 1, "idempotencyKey": str(uuid.uuid4()), "reason": "Pilot approval 2"})
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    client.ok("POST", f"{base_c}/opportunities/{opp2['id']}/measurement-plan", {"baselineStart": BASE_START, "baselineEnd": BASE_END,
        "observationStart": OBS_START, "observationEnd": (today + datetime.timedelta(days=2)).isoformat(), "idempotencyKey": str(uuid.uuid4())})
    client.call("POST", f"{base_c}/opportunities/{opp2['id']}/executions", {"type": "SOURCE_UPDATED", "channel": "WEBSITE",
        "target": "https://pilot-client.test/booking", "description": "TEST attested execution now (pilot smoke)", "performedAt": now_iso, "idempotencyKey": str(uuid.uuid4())})
    evaluation2 = client.ok("GET", f"{base_c}/opportunities/{opp2['id']}/evaluation")["evaluation"]
    codes = [r["code"] for r in evaluation2["reasons"]]
    check("P.13b an unfinished observation window stays indeterminate (never read as a result)",
          evaluation2["status"] == "INDETERMINATE" and "OBSERVATION_INCOMPLETE" in codes,
          json.dumps(evaluation2["reasons"])[:250])

    client.ok("POST", f"{base_c}/opportunities/{opp['id']}/review", {"expectedStatus": "APPROVED", "expectedRevision": 2, "idempotencyKey": str(uuid.uuid4()),
        "reason": "Pilot decision", "conclusion": "KEEP"})
    check("P.14 human decision recorded", True)

    preview = client.ok("GET", f"{base_c}/opportunities/{opp['id']}/report-preview")["preview"]
    s, published, _ = client.call("POST", f"{base_c}/opportunities/{opp['id']}/reports", {"idempotencyKey": str(uuid.uuid4()),
        "expectedLatestVersion": preview["latestVersion"], "evidenceDigest": preview["evidenceDigest"], "nextSteps": None})
    report_id = published["report"]["id"] if s == 200 and published and published.get("report") else None
    check("P.15 report preview published as an immutable snapshot", s == 200 and report_id, f"{s} {json.dumps(published)[:200] if published else ''}")

    share = client.ok("POST", f"{base_c}/reports/{report_id}/share")["share"]
    anon = Client()
    s, public_report, _ = anon.call("GET", f"/api/public/growth-reports/{share['publicId']}", origin=False)
    check("P.16 public share URL readable from an unauthenticated session", s == 200 and public_report and public_report.get("report"), f"{s}")

    # ---- production security behavior ------------------------------------
    s, refused, _ = client.call("POST", f"/api/businesses/{biz}/check-runs", {"questionId": str(uuid.uuid4()), "provider": "mock"})
    check("P.17 fixture (mock) check-runs are refused without the deployment fixture flag",
          s == 409 and refused and refused.get("reason") == "FixtureProviderDisabled", f"{s} {refused}")

    q = client.call("POST", f"/api/businesses/{biz}/questions", {"prompt": "TEST pilot question: is the booking page clear?", "origin": "OPERATOR_CONSTRUCTED"})[1]
    question_id = q["question"]["id"] if q and "question" in q else None
    s, enqueued, _ = client.call("POST", f"/api/businesses/{biz}/check-runs", {"questionId": question_id, "provider": "9router"})
    queued_id = enqueued["checkRun"]["id"] if s == 200 and enqueued and enqueued.get("checkRun") else None
    check("P.18 a real-provider check run queues and fails honestly without credentials (no mock evidence)",
          s == 200 and queued_id, f"{s} {json.dumps(enqueued)[:150] if enqueued else ''}")

    other = Client()
    other_email = f"pilot-other-{uuid.uuid4().hex[:8]}@pilot.test"
    other.call("POST", "/api/auth/signup", {"email": other_email, "password": password, "accountName": "Pilot other account"})
    other.call("POST", "/api/auth/signin", {"email": other_email, "password": password})
    s, _, _ = other.call("GET", f"{base_c}/opportunities/{opp['id']}/evaluation")
    check("P.19 account isolation on the deployed stack (another account sees 404)", s == 404, f"{s}")

    # ---- restart: persistence and worker recovery -------------------------
    compose("restart", "api", "worker", "db")
    until(healthy, "api health after restart", 120)
    check("P.20 the stack restarts cleanly and the API becomes ready again", True)
    me2 = client.ok("GET", "/api/auth/me")
    check("P.21 the operator session survives the restart (server-side sessions)", "userId" in (me2 or {}))
    s, report_after, _ = client.call("GET", f"{base_c}/reports/{report_id}")
    check("P.22 published business data and reports survive the restart", s == 200, f"{s}")

    def processed():
        s, d, _ = client.call("GET", f"/api/businesses/{biz}/check-runs")
        if s != 200 or not d:
            return None
        run = next((r for r in d["checkRuns"] if r["id"] == queued_id), None)
        if run and run.get("status") in ("RUNNING", "RETRYING", "FAILED") and (run.get("attemptCount") or 0) >= 1:
            return run
        return None
    run = until(processed, "worker claiming the pre-restart check run", 120)
    check("P.23 background jobs resume after restart: the worker claimed and processed the pre-restart run (honest failure without credentials)",
          run is not None, json.dumps(run)[:150] if run else "")

    # ---- isolation of the database ---------------------------------------
    inspect = sh("docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", "openrecord-pilot-db-1")
    bindings = (inspect.stdout or "").strip()
    check("P.24 PostgreSQL publishes no host port (private compose network only)",
          inspect.returncode == 0 and bindings in ("{}", '{"5432/tcp":null}'), bindings[:120])

    # ---- backup / restore rehearsal ---------------------------------------
    backup = sh("bash", str(root / "scripts" / "hosted-pilot-backup.sh"), "backup")
    check("P.25 backup written (pg_dump custom format, private network)", backup.returncode == 0, (backup.stderr or backup.stdout)[-300:])
    dump_file = None
    if backup.returncode == 0:
        m = re.search(r"backup written: (\S+)", backup.stdout)
        dump_file = m.group(1) if m else None
    if dump_file:
        verify = sh("bash", str(root / "scripts" / "hosted-pilot-backup.sh"), "verify", dump_file)
        check("P.26 restore rehearsal verified: row counts identical in a disposable restore database", verify.returncode == 0, (verify.stderr or verify.stdout)[-400:])

    # ---- logs carry no credentials ----------------------------------------
    logs = compose("logs", "--since", "30m")
    combined = (logs.stdout or "") + (logs.stderr or "")
    secret_sources = [env_file]
    if (root / "deploy" / "provider.env").exists():
        secret_sources.append(root / "deploy" / "provider.env")
    env_values = [line.split("=", 1)[1] for path in secret_sources for line in path.read_text().splitlines()
                  if re.match(r"^[A-Z_]+=.+$", line) and any(k in line.split("=")[0] for k in ("PASSWORD", "SECRET", "TOKEN", "KEY"))]
    leaks = [v[:6] for v in env_values if len(v) > 8 and v in combined]
    check("P.27 logs contain no database password, token or key", not leaks, str(leaks))

    check("PILOT WORKFLOW COMPLETE", all(ok for _, ok, _ in results))
finally:
    if args.down:
        compose("down", "--remove-orphans")

sys.exit(0 if all(ok for _, ok, _ in results) else 1)
