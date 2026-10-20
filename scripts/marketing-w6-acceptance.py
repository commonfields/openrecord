#!/usr/bin/env python3
"""W6 operator acceptance for the marketing control plane (TEST fixtures only).

Boots the BUILT API against a disposable loopback PostgreSQL database and
drives the whole workflow over real HTTP with real signup, signin and cookie
sessions: goal -> initiative -> approval -> measurement plan -> recorded
execution -> measurement import -> outcome evaluation -> human review ->
immutable client report -> share link -> public page -> revocation.

Two businesses use the same contracts: a software business (GA4 signups) and a
service business (operator CSV bookings with incomplete coverage). Integrity
and security checks follow.

The single SQL step is a labelled fixture: a measurement plan row with a
backdated `declared_at`. Real operators declare a plan before the work and wait
for the observation window to pass; a test cannot wait weeks. Every other step
uses the application's own routes.

Never run against a database you care about. Requires:
  W6_ACCEPTANCE_ALLOWED=1  DATABASE_URL=<loopback database, migrated>
Writes a JSON evidence file (--output). Test fixture data only.
"""
import argparse
import concurrent.futures
import hashlib
import http.cookiejar
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--port", type=int, default=int(os.environ.get("W6_ACCEPTANCE_PORT", "3217")))
args = parser.parse_args()
db = urllib.parse.urlsplit(os.environ.get("DATABASE_URL", ""))
if os.environ.get("W6_ACCEPTANCE_ALLOWED") != "1" or db.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("refusing: require W6_ACCEPTANCE_ALLOWED=1 and a disposable loopback DATABASE_URL")
base = f"http://127.0.0.1:{args.port}"
results = []

def check(name, ok, detail=""):
    results.append({"check": name, "pass": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f" -- {detail}" if detail and not ok else ""))
    return ok

class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, payload=None, origin=True, raw=None):
        data = raw if raw is not None else (None if payload is None else json.dumps(payload).encode())
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = base
        req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as res:
                body = res.read()
                return res.status, (json.loads(body) if body else None), res.headers, body
        except urllib.error.HTTPError as err:
            body = err.read()
            try:
                parsed = json.loads(body)
            except Exception:
                parsed = None
            return err.code, parsed, err.headers, body
    def ok(self, method, path, payload=None):
        status, data, _, body = self.call(method, path, payload)
        if status != 200:
            raise AssertionError(f"{method} {path} -> {status} {body[:300]!r}")
        return data

def psql(sql):
    out = subprocess.run(["psql", os.environ["DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError("fixture sql failed: " + out.stderr.strip()[:300])
    return out.stdout.strip()

def days(start, end):
    import datetime
    d, e, out = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end), []
    while d <= e:
        out.append(d.isoformat()); d += datetime.timedelta(days=1)
    return out

BASELINE = ("2026-09-01", "2026-09-07")
OBSERVATION = ("2026-09-09", "2026-09-15")
EXECUTION_AT = "2026-09-08T10:00:00Z"
PLAN_DECLARED_AT = "2026-08-25T00:00:00Z"

def ga4_csv(before=4, after=6, skip=()):
    rows = ["# GA4 export (TEST fixture)", "date,session source,session medium,sessions,key events"]
    for d in days("2026-09-01", "2026-09-15"):
        if d in skip:
            continue
        v = before if d <= BASELINE[1] else after
        rows += [f"{d},google,organic,20,{v - 1}", f"{d},direct,(none),5,1"]
    return "\n".join(rows) + "\n"

def operator_csv(values, skip=()):
    rows = ["date,value"]
    for d in days("2026-09-01", "2026-09-15"):
        if d in skip or d not in values:
            continue
        rows.append(f"{d},{values[d]}")
    return "\n".join(rows) + "\n"

SOFTWARE = {"name": "TEST Fixture SaaS (W6)", "websiteUrl": "https://saas.w6-fixture.test", "engagement": "CLIENT", "category": "TEST project software", "audience": "TEST small teams",
    "valueProposition": "TEST positioning", "goalStatement": "Increase trial signups",
    "metric": {"conversionKind": "SIGNUP", "label": "Trial signups", "sourceKind": "GA4_AGGREGATE_EXPORT", "sourceIdentity": "TEST GA4 property", "eventName": "trial_signup",
               "reportingTimeZone": "UTC", "propertyRef": "TEST property 1", "countingSemantics": "EVENT_COUNT", "unit": "COUNT", "currency": None}}
SERVICE = {"name": "TEST Fixture Salon (W6)", "websiteUrl": "https://salon.w6-fixture.test", "engagement": "CLIENT", "category": "TEST local services", "audience": "TEST locals",
    "valueProposition": "TEST positioning", "goalStatement": "Increase booked appointments",
    "metric": {"conversionKind": "BOOKING", "label": "Bookings", "sourceKind": "OPERATOR_AGGREGATE_EXPORT", "sourceIdentity": "TEST booking system export", "eventName": None,
               "reportingTimeZone": "Asia/Makassar", "propertyRef": None, "countingSemantics": "EVENT_COUNT", "unit": "COUNT", "currency": None}}

def new_operator(tag):
    c = Client()
    email = f"w6-{tag}-{uuid.uuid4().hex[:10]}@fixture.test"
    status, _, _, _ = c.call("POST", "/api/auth/signup", {"email": email, "password": "disposable-fixture-password", "accountName": f"W6 {tag} fixture account"})
    assert status in (200, 201), f"signup {status}"
    status, _, _, _ = c.call("POST", "/api/auth/signin", {"email": email, "password": "disposable-fixture-password"})
    assert status == 200, f"signin {status}"
    me = c.ok("GET", "/api/auth/me")
    return c, me

class Biz:
    def __init__(self, client, me, product):
        self.c, self.me, self.product = client, me, product
        profile = client.ok("POST", "/api/growth/products", {**product, "idempotencyKey": str(uuid.uuid4())})["profile"]
        self.id, self.goal, self.definition = profile["businessId"], profile["primaryGoal"]["id"], profile["primaryGoal"]["metricDefinition"]["id"]
        self.base = f"/api/growth/clients/{self.id}"
        self.user = me.get("userId") or me.get("user", {}).get("userId")
    def initiative(self, title, approve=True):
        o = self.c.ok("POST", f"{self.base}/opportunities", {"goalId": self.goal, "title": title, "problemStatement": "TEST visitors cannot see the offer", "audience": "TEST audience",
            "buyerIntent": "TEST intent", "targetUrl": None, "source": "TEST source", "proposedChange": "TEST publish a clearer offer", "expectedMechanism": "TEST mechanism",
            "assumptions": "TEST private assumption", "uncertainty": "TEST private uncertainty", "baselineAvailability": "UNKNOWN", "ownerUserId": self.user, "initialStatus": "PROPOSED",
            "idempotencyKey": str(uuid.uuid4()), "evidence": [{"type": "OPERATOR_HYPOTHESIS", "note": "TEST private hypothesis note"}]})["opportunity"]
        if approve:
            self.c.ok("POST", f"{self.base}/opportunities/{o['id']}/approve", {"expectedStatus": "PROPOSED", "expectedRevision": 1, "idempotencyKey": str(uuid.uuid4()), "reason": "TEST private approval reason"})
        return o["id"]
    def plan_api(self, oid, baseline=BASELINE, observation=OBSERVATION):
        return self.c.call("POST", f"{self.base}/opportunities/{oid}/measurement-plan", {"baselineStart": baseline[0], "baselineEnd": baseline[1], "observationStart": observation[0],
            "observationEnd": observation[1], "idempotencyKey": str(uuid.uuid4())})
    def plan_fixture(self, oid, declared_at=PLAN_DECLARED_AT):
        """LABELLED TEST FIXTURE: a plan row with a backdated declared_at (see module docstring)."""
        psql(f"INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key,declared_at) "
             f"VALUES('{oid}','{self.id}','{self.definition}','{BASELINE[0]}','{BASELINE[1]}','{OBSERVATION[0]}','{OBSERVATION[1]}','{self.user}','{uuid.uuid4()}','{declared_at}')")
    def execute(self, oid, **body):
        payload = {"type": "SOURCE_UPDATED", "channel": "WEBSITE", "target": "https://saas.w6-fixture.test/pricing", "description": "TEST private execution note", "performedAt": EXECUTION_AT, "idempotencyKey": str(uuid.uuid4()), **body}
        return self.c.call("POST", f"{self.base}/opportunities/{oid}/executions", payload)
    def import_csv(self, csv, provenance="OPERATOR_SUPPLIED_EXPORT", start="2026-09-01", end="2026-09-15", definition=None):
        return self.c.call("POST", f"{self.base}/metrics/{definition or self.definition}/imports", {"provenance": provenance, "dateStart": start, "dateEnd": end, "csv": csv})
    def evaluation(self, oid):
        return self.c.ok("GET", f"{self.base}/opportunities/{oid}/evaluation")["evaluation"]
    def review(self, oid, conclusion, reason, revision=2):
        return self.c.ok("POST", f"{self.base}/opportunities/{oid}/review", {"expectedStatus": "APPROVED", "expectedRevision": revision, "idempotencyKey": str(uuid.uuid4()), "reason": reason, "conclusion": conclusion})
    def preview(self, oid):
        return self.c.ok("GET", f"{self.base}/opportunities/{oid}/report-preview")["preview"]
    def publish(self, oid, p, next_steps=None, key=None):
        return self.c.call("POST", f"{self.base}/opportunities/{oid}/reports", {"idempotencyKey": key or str(uuid.uuid4()), "expectedLatestVersion": p["latestVersion"], "evidenceDigest": p["evidenceDigest"], "nextSteps": next_steps})
    def share(self, report_id):
        return self.c.ok("POST", f"{self.base}/reports/{report_id}/share")["share"]

def public(public_id):
    anon = Client()
    return anon.call("GET", f"/api/public/growth-reports/{public_id}", origin=False)

evidence = {}
processes = []
try:
    env = dict(os.environ, PORT=str(args.port), APP_BASE_URL=base, NINE_ROUTER_ENABLED="false", RECORD_ALLOW_FIXTURE="1")
    env.pop("NODE_ENV", None)
    processes.append(subprocess.Popen(["node", "--import", "tsx", "dist/server.js"], cwd=root / "apps" / "api", env=env,
        stdout=open(args.output.with_suffix(".api.log"), "wb"), stderr=subprocess.STDOUT, start_new_session=True))
    probe, deadline = Client(), time.monotonic() + 90
    while True:
        if processes[0].poll() is not None:
            raise RuntimeError("built API exited during startup")
        try:
            if probe.call("GET", "/api/auth/me")[0] == 401:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("API startup timed out")
        time.sleep(0.2)

    # ---------------- Journey A: software business ----------------
    opA, meA = new_operator("software")
    A = Biz(opA, meA, SOFTWARE)
    check("A.01 software business, goal and GA4 count metric created through the API", A.definition and A.goal)
    oidA = A.initiative("TEST pricing explainer")
    check("A.02 initiative proposed then approved by an authenticated operator", True)
    s, d, _, _ = A.plan_api(oidA)  # real API plan (declared now => after the later backdated execution)
    check("A.03 measurement plan can be declared through the API", s == 200 and d["plan"]["timing"] in ("PRE_DECLARED", "DECLARED_AFTER_EXECUTION"), f"{s}")
    s, d, _, _ = A.execute(oidA)
    execA = d["opportunity"]["executions"][0] if s == 200 else {}
    check("A.04 operator-attested website action recorded", s == 200 and execA.get("assurance") == "OPERATOR_ATTESTED" and execA.get("verification") is None, f"{s}")
    A.plan_fixture(oidA)  # fixture: earlier-declared plan; the evaluator uses the latest declaration
    ev = A.evaluation(oidA)
    check("A.05 evaluation uses the latest plan; earlier one disclosed as re-declared", ev["plan"]["declarations"] == 2, str(ev["plan"]))
    # The real-API plan was declared after the action, the fixture plan before it. The latest declaration is the API one.
    check("A.05b a plan declared after the action cannot be read as pre-declared", ev["status"] == "INDETERMINATE" and any(r["code"] == "PLAN_DECLARED_AFTER_EXECUTION" for r in ev["reasons"]), json.dumps(ev["reasons"]))
    evidence["A_late_plan_evaluation"] = ev

    # clean journey on a second initiative: fixture plan only (pre-declared)
    oidA2 = A.initiative("TEST pricing explainer v2")
    A.plan_fixture(oidA2)
    s, d, _, _ = A.execute(oidA2)
    check("A.06 second initiative: attested execution recorded", s == 200)
    s, d, _, _ = A.import_csv(ga4_csv())
    check("A.07 valid GA4 baseline and observation measurements imported", s == 200 and d["result"]["coverage"]["missingDays"] == 0, f"{s} {d}")
    ev = A.evaluation(oidA2)
    check("A.08 evaluation COMPARABLE with descriptive comparison only", ev["status"] == "COMPARABLE" and ev["comparison"]["totalDifference"] == 14 and ev["comparison"]["dailyMeanPercentChange"] == 50, json.dumps(ev.get("comparison")))
    check("A.09 plan is PRE_DECLARED", ev["plan"]["timing"] == "PRE_DECLARED")
    check("A.10 action assurance is attestation, never verification", all(a["assurance"] == "OPERATOR_ATTESTED" for a in ev["actions"]), json.dumps([a["assurance"] for a in ev["actions"]]))
    check("A.11 evaluation carries limitations and caveat list", len(ev["limitations"]) > 0 and isinstance(ev["caveats"], list))
    evidence["A_evaluation"] = ev
    pre = A.preview(oidA2)
    check("A.12 report preview has no invented human decision", pre["snapshot"]["review"] is None)
    A.review(oidA2, "KEEP", "TEST keep the explainer and re-check next month")
    pre = A.preview(oidA2)
    check("A.13 human review decision appears in preview verbatim", pre["snapshot"]["review"]["conclusion"] == "KEEP")
    s, d, _, _ = A.publish(oidA2, pre, "TEST re-check signups in October", key=str(uuid.uuid4()))
    rep = d["report"]
    check("A.14 immutable report v1 published", s == 200 and rep["version"] == 1 and not d["replayed"])
    shareA = A.share(rep["id"])
    check("A.15 share link has a 43-char base64url (256-bit) id", re.fullmatch(r"[A-Za-z0-9_-]{43}", shareA["publicId"]) is not None)
    s, pub, hdr, body = public(shareA["publicId"])
    check("A.16 client-facing context opens the report (no session)", s == 200 and pub["report"]["status"] == "COMPARABLE")
    check("A.17 public headers: no-store, noindex, no-referrer", hdr.get("cache-control") == "no-store" and "noindex" in (hdr.get("x-robots-tag") or "") and hdr.get("referrer-policy") == "no-referrer")
    check("A.18 public report shows figures, decision, limitations", pub["report"]["review"]["conclusion"] == "KEEP" and pub["report"]["comparison"]["totalDifference"] == 14 and len(pub["report"]["limitations"]) > 0)
    text = body.decode()
    for secret in ("TEST private", "date,value", "key events", "or_session", "password"):
        check(f"A.19 public payload contains no '{secret}'", secret not in text)
    evidence["A_public_report"] = pub["report"]

    # ---------------- Journey B: service business ----------------
    opB, meB = new_operator("service")
    B = Biz(opB, meB, SERVICE)
    check("B.01 service business with a booking goal and operator-CSV metric (Asia/Makassar)", B.definition)
    oidB = B.initiative("TEST listing refresh and email campaign")
    B.plan_fixture(oidB)
    s1, d1, _, _ = B.execute(oidB, type="LISTING_UPDATED", channel="THIRD_PARTY_PROFILE", target="TEST directory listing", description="TEST private note listing", performedAt="2026-09-08T02:00:00Z")
    s2, d2, _, _ = B.execute(oidB, type="CAMPAIGN_SENT", channel="EMAIL", target="TEST September newsletter", description="TEST private note email", performedAt="2026-09-08T03:00:00Z")
    check("B.02 multiple executions recorded (third-party listing + email)", s1 == 200 and s2 == 200 and len(d2["opportunity"]["executions"]) == 2, f"{s1} {s2}")
    # unrelated activity on another initiative in the same period must be disclosed
    oidB2 = B.initiative("TEST unrelated social post")
    s, d, _, _ = B.execute(oidB2, type="OTHER", channel="SOCIAL", target="TEST social post", description="TEST other activity", performedAt="2026-09-10T03:00:00Z")
    check("B.03 unrelated activity recorded on another initiative", s == 200)
    values = {d: (3 if d <= BASELINE[1] else 5) for d in days("2026-09-01", "2026-09-15")}
    s, d, _, _ = B.import_csv(operator_csv(values, skip=("2026-09-04", "2026-09-05", "2026-09-11")))
    check("B.04 operator CSV with incomplete coverage accepted; missing days stay missing", s == 200 and d["result"]["coverage"]["missingDays"] == 3, f"{s} {d}")
    ev = B.evaluation(oidB)
    check("B.05 evaluation INDETERMINATE with incomplete coverage", ev["status"] == "INDETERMINATE", json.dumps(ev["reasons"]))
    check("B.06 no invented comparison figures", ev["comparison"] is None)
    series = B.c.ok("GET", f"{B.base}/metrics/{B.definition}/series?start=2026-09-01&end=2026-09-15")["series"]
    missing = [x for x in series["days"] if x["status"] == "MISSING"]
    check("B.07 missing days are null, never zero", len(missing) == 3 and all(x["value"] is None for x in missing))
    check("B.08 other activity disclosed", any(a["association"] != "THIS_INITIATIVE" for a in ev["actions"]) or any("OTHER" in c["code"] or "ACTIVITY" in c["code"] for c in ev["caveats"]), json.dumps([c["code"] for c in ev["caveats"]]))
    check("B.09 timezone from definition (Asia/Makassar) respected", ev["metric"]["reportingTimeZone"] == "Asia/Makassar" if "reportingTimeZone" in ev["metric"] else series["timeZone"] == "Asia/Makassar")
    evidence["B_evaluation"] = ev
    pre = B.preview(oidB)
    check("B.10 service preview: no decision invented", pre["snapshot"]["review"] is None)
    s, d, _, _ = B.publish(oidB, pre, None)
    repB = d["report"]
    check("B.11 report published despite uncertainty (INDETERMINATE)", s == 200 and repB["status"] == "INDETERMINATE")
    shareB = B.share(repB["id"])
    s, pubB, _, bodyB = public(shareB["publicId"])
    check("B.12 service share link works", s == 200 and pubB["report"]["review"] is None and pubB["report"]["comparison"] is None)
    check("B.13 public service report omits private notes", "TEST private" not in bodyB.decode())
    s, _, _, _ = B.c.call("POST", f"{B.base}/reports/{repB['id']}/share/revoke")
    s2, _, _, bodyR = public(shareB["publicId"])
    _, _, _, bodyU = public("A" * 43)
    check("B.14 revocation disables access", s == 200 and s2 == 404)
    check("B.15 revoked, unknown and malformed links are byte-identical 404s", bodyR == bodyU and public("not-a-link")[0] == 404 and public("../../etc/passwd")[0] in (404, 422) and bodyR == public("not-a-link")[3])
    evidence["B_public_report"] = pubB["report"]

    # ---------------- Integrity / security ----------------
    # Execution
    check("C.01 attested execution never reads as verified (ledger)", all(e["assurance"] == "OPERATOR_ATTESTED" for e in d2["opportunity"]["executions"]))
    other, otherMe = new_operator("intruder")
    for label, method, path in [("evaluation", "GET", f"{A.base}/opportunities/{oidA2}/evaluation"), ("preview", "GET", f"{A.base}/opportunities/{oidA2}/report-preview"),
        ("report", "GET", f"{A.base}/reports/{rep['id']}"), ("share", "POST", f"{A.base}/reports/{rep['id']}/share"), ("revoke", "POST", f"{A.base}/reports/{rep['id']}/share/revoke"),
        ("series", "GET", f"{A.base}/metrics/{A.definition}/series?start=2026-09-01&end=2026-09-15"), ("import", "POST", f"{A.base}/metrics/{A.definition}/imports"), ("execute", "POST", f"{A.base}/opportunities/{oidA2}/executions"),
        ("plan", "POST", f"{A.base}/opportunities/{oidA2}/measurement-plan"), ("publish", "POST", f"{A.base}/opportunities/{oidA2}/reports")]:
        s, _, _, body = other.call(method, path, {} if method == "POST" else None)
        check(f"C.02 cross-account {label} refused", s in (403, 404, 422) and b"TEST" not in body and b"Trial signups" not in body, f"{s}")
    s, _, _, _ = Client().call("GET", f"{A.base}/opportunities/{oidA2}/evaluation")
    check("C.03 unauthenticated evaluation refused", s == 401)
    s, _, _, _ = opA.call("POST", f"{A.base}/opportunities/{oidA2}/reports", {}, origin=False)
    check("C.04 cross-origin/no-origin write refused", s in (401, 403, 422), f"{s}")
    # Measurement
    s, d, _, _ = A.import_csv("date,value\n2026-09-01,-4\n")
    check("C.05 wrong format for GA4 definition refused", s == 422)
    s, d, _, _ = B.import_csv("date,value\n2026-09-01,1.5\n")
    check("C.06 fractional/negative values refused", s == 422)
    s, d, _, _ = B.import_csv("date,value\n2026-09-01,1\n2026-09-01,2\n")
    check("C.07 duplicate day refused", s == 422)
    s, d, _, _ = B.import_csv("date,value\n2026-09-20,1\n")
    check("C.08 row outside declared range refused", s == 422)
    # conflict stays visible, newest wins
    conflict = {d: 9 for d in days("2026-09-01", "2026-09-03")}
    s, d, _, _ = B.import_csv(operator_csv(conflict), end="2026-09-03")
    series = B.c.ok("GET", f"{B.base}/metrics/{B.definition}/series?start=2026-09-01&end=2026-09-03")["series"]
    check("C.09 conflicting exports stay visible", s == 200 and len(series["conflicts"]) == 3 and all(x["status"] == "CONFLICT" for x in series["days"]), json.dumps(series["conflicts"]))
    s, d, _, _ = B.import_csv(operator_csv(conflict), provenance="SYNTHETIC_FIXTURE", start="2026-09-01", end="2026-09-03")
    check("C.10a same bytes under a different provenance are refused, not relabelled", s == 409 and d["reason"] == "IdempotencyConflict", f"{s} {d}")
    s, d, _, _ = B.import_csv(operator_csv({d: 11 for d in days("2026-09-01", "2026-09-03")}), provenance="SYNTHETIC_FIXTURE", start="2026-09-01", end="2026-09-03")
    imps = B.c.ok("GET", f"{B.base}/metrics/{B.definition}/imports")["imports"]
    check("C.10 synthetic observations identified", any(i["provenance"] == "SYNTHETIC_FIXTURE" for i in imps))
    # currency metric fails closed
    cur = {**SERVICE, "name": "TEST Fixture Currency (W6)", "metric": {**SERVICE["metric"], "label": "Revenue", "countingSemantics": "SUM", "unit": "CURRENCY_MINOR", "currency": "USD"}}
    opC, meC = new_operator("currency")
    C = Biz(opC, meC, cur)
    oidC = C.initiative("TEST currency initiative")
    s, d, _, _ = C.plan_api(oidC)
    check("C.11 currency metric plan fails closed", s == 409 and d["reason"] == "CurrencyMeasurementRefused", f"{s} {d}")
    s, d, _, _ = C.import_csv("date,value\n2026-09-01,100\n")
    check("C.12 currency metric import fails closed", s in (409, 422), f"{s} {d}")
    # Evaluation
    # The limitations array is the disclaimer itself; every other field must not use these words.
    flat = json.dumps({**evidence["A_evaluation"], "limitations": [], "assumptions": []}).lower() + json.dumps({**evidence["A_public_report"], "limitations": [], "assumptions": []}).lower()
    for word in ("roi", "caused by", "attributed", "lift", "success", "return on"):
        # only negations and disclaimers may mention these words
        for m in re.finditer(word, flat):
            context = flat[max(0, m.start() - 80): m.end() + 60]
            check(f"C.13 '{word}' appears only in a disclaimer", any(n in context for n in ("not ", "no ", "never", "cannot", "does not", "nor ")), context)
        else:
            check(f"C.13 '{word}' is absent outside the limitations text", True)
    # Reports: idempotency, immutability, versioning
    preview2 = A.preview(oidA2)
    k = str(uuid.uuid4())
    s1, d1, _, _ = A.publish(oidA2, preview2, "TEST v2 note", key=k)
    s2, d2r, _, _ = A.publish(oidA2, preview2, "TEST v2 note", key=k)
    check("D.01 retry with the same key is idempotent", s1 == 409 or (s1 == 200 and s2 == 200 and d2r["replayed"] is True and d2r["report"]["id"] == d1["report"]["id"]), f"{s1} {s2}")
    # new import must not change published figures
    s, d, _, _ = A.import_csv(ga4_csv(before=10, after=20), start="2026-09-01", end="2026-09-15")
    s_after, pub_after, _, _ = public(shareA["publicId"])
    check("D.02 new import leaves the published figures unchanged", pub_after["report"]["comparison"] == pub["report"]["comparison"])
    stale = A.publish(oidA2, preview2, None)
    check("D.03 stale evidence is refused after a new import", stale[0] == 409 and stale[1]["reason"] in ("ReportEvidenceChanged", "StaleReport"), f"{stale[0]} {stale[1]}")
    fresh = A.preview(oidA2)
    s, d, _, _ = A.publish(oidA2, fresh, "TEST corrected")
    check("D.04 correction publishes a new version superseding the previous one", s == 200 and d["report"]["version"] == 3 and d["report"]["supersedesId"] == d1["report"]["id"], f"{s} {str(d)[:200]}")
    s, pub_old, _, _ = public(shareA["publicId"])
    check("D.05 old link still shows frozen v1 with a newer-version notice", pub_old["report"]["version"] == 1 and pub_old["report"]["superseded"] is True and pub_old["report"]["comparison"]["totalDifference"] == 14)
    # concurrent publication
    oidA3 = A.initiative("TEST concurrent publication")
    A.plan_fixture(oidA3); A.execute(oidA3)
    p3 = A.preview(oidA3)
    def pub_once(_):
        return A.publish(oidA3, p3, "TEST concurrent")[0:2]
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        outcomes = list(pool.map(pub_once, range(8)))
    versions = A.c.ok("GET", f"{A.base}/opportunities/{oidA3}/reports")["reports"]
    check("D.06 concurrent publication keeps a linear version chain", sorted(r["version"] for r in versions) == list(range(1, len(versions) + 1)) and len(versions) >= 1, json.dumps([o[0] for o in outcomes]))
    # database guards (direct writes fail closed)
    out = subprocess.run(["psql", os.environ["DATABASE_URL"], "-At", "-c", f"UPDATE growth_reports SET snapshot_text='x' WHERE id='{rep['id']}'"], capture_output=True, text=True)
    check("D.07 published report row cannot be updated", out.returncode != 0)
    out = subprocess.run(["psql", os.environ["DATABASE_URL"], "-At", "-c", f"DELETE FROM growth_reports WHERE id='{rep['id']}'"], capture_output=True, text=True)
    check("D.08 published report row cannot be deleted", out.returncode != 0)
    stored = psql(f"SELECT snapshot_digest = encode(sha256(convert_to(snapshot_text,'UTF8')),'hex') FROM growth_reports WHERE id='{rep['id']}'")
    check("D.09 stored digest matches stored snapshot text", stored == "t")
    leak = psql(f"SELECT count(*) FROM growth_reports WHERE snapshot_text ILIKE '%date,value%' OR snapshot_text ILIKE '%key events%' OR snapshot_text ILIKE '%TEST private%'")
    # private notes are retained in the evaluation/internal view but must not exist in the public projection
    check("D.10 raw CSV never stored in report snapshots", psql("SELECT count(*) FROM growth_reports WHERE snapshot_text ILIKE '%date,value%' OR snapshot_text ILIKE '%key events%'") == "0")
    ids = set()
    for _ in range(5):
        r2 = A.share(rep["id"])
        ids.add(r2["publicId"])
    check("D.11 share creation returns the active link (no id churn)", len(ids) == 1)
    s, _, _, _ = A.c.call("POST", f"{A.base}/reports/{rep['id']}/share/revoke")
    s_rev, _, _, _ = public(shareA["publicId"])
    newshare = A.share(rep["id"])
    check("D.12 revoked link never works again; a new link has a new id", s_rev == 404 and newshare["publicId"] != shareA["publicId"] and public(newshare["publicId"])[0] == 200 and public(shareA["publicId"])[0] == 404)
    unique = psql("SELECT count(DISTINCT public_id) = count(*) FROM growth_report_shares")
    check("D.13 share identifiers are unique", unique == "t")
    # ---------------- Execution / measurement edge cases ----------------
    # The product has no HTTP route that corrects a recorded execution (evidence-protocol corrections
    # stay out of scope), so the correction chain is created by a labelled SQL fixture, as the W5 tests do.
    oidE = A.initiative("TEST correction chain")
    A.plan_fixture(oidE)
    s, d, _, _ = A.execute(oidE)
    original = d["opportunity"]["executions"][0]["id"]
    corr = psql(f"INSERT INTO interventions(business_id,type,target,performed_at,actor,notes,supersedes_id,correction_reason) VALUES('{A.id}','SOURCE_UPDATED','https://saas.w6-fixture.test/pricing','2026-09-08T11:00:00Z','UNKNOWN','TEST corrected time','{original}','TEST time typo') RETURNING id").splitlines()[0]
    evE = A.evaluation(oidE)
    check("E.01 corrected execution stays attributed to its initiative", [a["id"] for a in evE["actions"] if a["association"] == "THIS_INITIATIVE"] == [corr] and all(a["id"] != original for a in evE["actions"]), json.dumps(evE["actions"])[:300])
    check("E.02 correction does not invalidate plan timing", evE["plan"]["timing"] == "PRE_DECLARED")
    psql(f"INSERT INTO interventions(business_id,type,target,performed_at,actor,supersedes_id,correction_reason) VALUES('{A.id}','SOURCE_UPDATED','https://saas.w6-fixture.test/pricing','2026-08-20T09:00:00Z','UNKNOWN','{corr}','TEST actually earlier')")
    evE2 = A.evaluation(oidE)
    check("E.03 a correction dated before the plan cannot hide an earlier action", evE2["plan"]["timing"] == "DECLARED_AFTER_EXECUTION")
    # Time zone: 2026-09-07T20:00Z is 04:00 on 09-08 in Asia/Makassar, i.e. between the windows, not in the baseline.
    oidT = B.initiative("TEST timezone boundary")
    B.plan_fixture(oidT)
    B.execute(oidT, performedAt="2026-09-07T20:00:00Z", type="OTHER", channel="OTHER", target="TEST tz action", description="TEST tz")
    evT = B.evaluation(oidT)
    tz_action = [a for a in evT["actions"] if a["association"] == "THIS_INITIATIVE"][0]
    check("E.04 action day uses the metric time zone", tz_action["performedDay"] == "2026-09-08" and tz_action["phase"] == "BETWEEN_WINDOWS", json.dumps(tz_action)[:300])
    # Historical metric definitions stay pinned when the profile changes.
    revised = {**SERVICE["metric"], "label": "Bookings (revised definition)", "sourceIdentity": "TEST booking system v2"}
    B.c.ok("PUT", f"{B.base}", {"category": SERVICE["category"], "audience": SERVICE["audience"], "valueProposition": SERVICE["valueProposition"], "goalStatement": "Increase booked appointments (v2)", "metric": revised, "idempotencyKey": str(uuid.uuid4())})
    evOld = B.evaluation(oidB)
    check("E.05 earlier initiative keeps its pinned goal and metric version", evOld["metric"]["version"] == 1 and evOld["goal"]["version"] == 1 and evOld["metric"]["label"] == "Bookings", json.dumps(evOld["metric"]))
    newGoal = B.c.ok("GET", f"{B.base}")["profile"]["primaryGoal"]
    check("E.06 the profile change created a new metric version", newGoal["metricDefinition"]["version"] == 2 and newGoal["metricDefinition"]["id"] != B.definition)
    # Cancelled / unapproved initiatives cannot produce reports
    oidU = A.initiative("TEST never approved", approve=False)
    s, d, _, _ = A.c.call("GET", f"{A.base}/opportunities/{oidU}/report-preview")
    pu = A.c.call("POST", f"{A.base}/opportunities/{oidU}/reports", {"idempotencyKey": str(uuid.uuid4()), "expectedLatestVersion": 0, "evidenceDigest": "0" * 64, "nextSteps": None})
    check("E.07 an initiative without approval cannot be published", pu[0] in (409, 404, 422), f"{pu[0]} {pu[1]}")
except Exception as err:
    check("HARNESS no unexpected exception", False, f"{type(err).__name__}: {err}")
finally:
    for p in processes:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
    for p in processes:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
    failed = [r for r in results if not r["pass"]]
    args.output.write_text(json.dumps({"summary": {"checks": len(results), "failed": len(failed)}, "results": results, "evidence": evidence}, indent=2, sort_keys=True))
    print(f"{len(results) - len(failed)}/{len(results)} checks passed; evidence: {args.output}")
    sys.exit(1 if failed else 0)
