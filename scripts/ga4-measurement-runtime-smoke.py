#!/usr/bin/env python3
"""Built-runtime smoke for W8 authenticated GA4 measurement (TEST fixtures, loopback only).

Boots the BUILT API and worker against a disposable loopback database and a
local Google STAND-IN: an independent Python implementation of the OAuth
consent redirect, token and revocation endpoints, Admin API account summaries,
property and key events, and Data API runReport. The real OAuth flow (state,
PKCE S256, exact redirect URI), the real HTTP transport, the real worker loop,
credential encryption and the database guards run; Google is a mock. A pass
here is MOCK_ADAPTER_PASS, never LIVE_PROVIDER_PASS.

Requires HOSTED_SMOKE_ALLOWED=1 and a migrated, disposable loopback DATABASE_URL.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent.parent
db = urllib.parse.urlsplit(os.environ.get("DATABASE_URL", ""))
if os.environ.get("HOSTED_SMOKE_ALLOWED") != "1" or db.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit("refusing: require HOSTED_SMOKE_ALLOWED=1 and a disposable loopback database")
API_PORT = int(os.environ.get("GA4_SMOKE_PORT", "3037"))
GOOGLE_PORT = int(os.environ.get("GA4_SMOKE_GOOGLE_PORT", "3038"))
base = f"http://127.0.0.1:{API_PORT}"
REDIRECT = f"{base}/api/growth/ga4/oauth/callback"
CLIENT_ID = "smoke-client.apps.googleusercontent.com"
CLIENT_SECRET = "smoke-secret-" + uuid.uuid4().hex
KEY = base64.b64encode(secrets.token_bytes(32)).decode()
READONLY = "https://www.googleapis.com/auth/analytics.readonly"
P1, P_FOREIGN, EVENT, TZ = "properties/515151", "properties/929292", "book_appointment", "Asia/Makassar"
checks = []

def check(name, ok, detail=""):
    checks.append({"check": name, "pass": bool(ok)})
    print(("PASS " if ok else "FAIL ") + name + (f" -- {detail}" if detail and not ok else ""))
    if not ok:
        raise AssertionError(name)

# ------------------------------------------------------------------ Google stand-in
class Google:
    def __init__(self):
        self.lock = threading.Lock()
        self.codes, self.access, self.refresh = {}, {}, {}
        self.issued, self.revoked = [], 0
        self.pkce_checked = 0
        self.data = {"2026-09-01": 3, "2026-09-02": 0, "2026-09-03": 5, "2026-09-05": 2}   # 2026-09-04: no row
    def token(self, prefix):
        t = prefix + secrets.token_urlsafe(18)
        self.issued.append(t)
        return t

google = Google()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def send(self, status, body=None, headers=None):
        data = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)
    def err(self, status, code):
        return self.send(status, {"error": {"code": status, "message": "stand-in", "status": code}})
    def form(self):
        n = int(self.headers.get("content-length") or 0)
        return {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode()).items()}
    def grant(self):
        entry = google.access.get((self.headers.get("authorization") or "").removeprefix("Bearer "))
        if not entry or entry["grant"]["revoked"] or entry["expires"] < time.time():
            return None
        return entry["grant"]
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        with google.lock:
            if url.path == "/o/oauth2/v2/auth":
                # The consent screen: validate like Google, then redirect to the registered URI.
                if q.get("client_id") != CLIENT_ID or q.get("redirect_uri") != REDIRECT or q.get("code_challenge_method") != "S256" or not q.get("state"):
                    return self.send(400, {"error": "invalid_request"})
                code = google.token("4/smoke-")
                google.codes[code] = {"challenge": q["code_challenge"], "redirect": q["redirect_uri"], "scope": q["scope"], "used": False}
                self.send_response(302)
                self.send_header("location", f"{q['redirect_uri']}?state={urllib.parse.quote(q['state'])}&code={urllib.parse.quote(code)}&scope={urllib.parse.quote(q['scope'])}")
                self.send_header("content-length", "0")
                self.end_headers()
                return
            if url.path == "/__state":
                return self.send(200, {"revoked": google.revoked, "pkceChecked": google.pkce_checked, "issued": google.issued})
            grant = self.grant()
            if grant is None:
                return self.err(401, "UNAUTHENTICATED")
            if url.path == "/admin/v1beta/accountSummaries":
                return self.send(200, {"accountSummaries": [{"name": "accountSummaries/51", "account": "accounts/51", "displayName": "TEST Salon",
                    "propertySummaries": [{"property": P1, "displayName": "TEST Salon site", "propertyType": "PROPERTY_TYPE_ORDINARY", "parent": "accounts/51"}]}]})
            if url.path == f"/admin/v1beta/{P1}":
                return self.send(200, {"name": P1, "displayName": "TEST Salon site", "timeZone": TZ, "parent": "accounts/51"})
            if url.path == f"/admin/v1beta/{P1}/keyEvents":
                return self.send(200, {"keyEvents": [{"name": f"{P1}/keyEvents/1", "eventName": EVENT, "countingMethod": "ONCE_PER_EVENT"}]})
            return self.err(403, "PERMISSION_DENIED")
    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        with google.lock:
            if url.path == "/token":
                f = self.form()
                if f.get("client_id") != CLIENT_ID or f.get("client_secret") != CLIENT_SECRET:
                    return self.send(401, {"error": "invalid_client"})
                if f.get("grant_type") == "authorization_code":
                    c = google.codes.get(f.get("code", ""))
                    if not c or c["used"] or f.get("redirect_uri") != c["redirect"]:
                        return self.send(400, {"error": "invalid_grant"})
                    c["used"] = True
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
                    if challenge != c["challenge"]:
                        return self.send(400, {"error": "invalid_grant"})
                    google.pkce_checked += 1
                    grant = {"revoked": False}
                    access, refresh = google.token("ya29.smoke-"), google.token("1//smoke-")
                    google.access[access] = {"grant": grant, "expires": time.time() + 3600}
                    google.refresh[refresh] = grant
                    part = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
                    id_token = part({"alg": "RS256"}) + "." + part({"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "77001", "email": "agency@smoke.test", "email_verified": True, "exp": int(time.time()) + 3600}) + ".sig"
                    return self.send(200, {"access_token": access, "refresh_token": refresh, "expires_in": 3600, "scope": c["scope"], "token_type": "Bearer", "id_token": id_token})
                if f.get("grant_type") == "refresh_token":
                    grant = google.refresh.get(f.get("refresh_token", ""))
                    if not grant or grant["revoked"]:
                        return self.send(400, {"error": "invalid_grant"})
                    access = google.token("ya29.smoke-")
                    google.access[access] = {"grant": grant, "expires": time.time() + 3600}
                    return self.send(200, {"access_token": access, "expires_in": 3600, "scope": f"openid email {READONLY}", "token_type": "Bearer"})
                return self.send(400, {"error": "unsupported_grant_type"})
            if url.path == "/revoke":
                t = self.form().get("token", "")
                grant = google.refresh.get(t) or (google.access.get(t) or {}).get("grant")
                if not grant or grant["revoked"]:
                    return self.send(400, {"error": "invalid_token"})
                grant["revoked"] = True
                google.revoked += 1
                return self.send(200, {})
            if url.path == "/__revise":
                google.data["2026-09-03"] = 9
                return self.send(200, {})
            if url.path == f"/data/v1beta/{P1}:runReport":
                if self.grant() is None:
                    return self.err(401, "UNAUTHENTICATED")
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                r = body["dateRanges"][0]
                assert [d["name"] for d in body["dimensions"]] == ["date", "eventName"] and body["dimensionFilter"]["filter"]["stringFilter"]["value"] == EVENT
                rows = [{"dimensionValues": [{"value": d.replace("-", "")}, {"value": EVENT}], "metricValues": [{"value": str(v)}, {"value": str(v + 4)}]}
                        for d, v in sorted(google.data.items()) if r["startDate"] <= d <= r["endDate"]]
                return self.send(200, {"dimensionHeaders": [{"name": "date"}, {"name": "eventName"}], "metricHeaders": [{"name": "keyEvents"}, {"name": "eventCount"}],
                                       "rows": rows, "rowCount": len(rows), "metadata": {"timeZone": TZ, "currencyCode": "USD"}, "kind": "analyticsData#runReport"})
            return self.err(404, "NOT_FOUND")

stand_in = ThreadingHTTPServer(("127.0.0.1", GOOGLE_PORT), Handler)
threading.Thread(target=stand_in.serve_forever, daemon=True).start()
GOOGLE = f"http://127.0.0.1:{GOOGLE_PORT}"

def google_state():
    with urllib.request.urlopen(GOOGLE + "/__state", timeout=5) as r:
        return json.loads(r.read())

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())
        self.bodies = []
    def call(self, method, path, payload=None):
        ours = not path.startswith("http") or path.startswith(base)   # only OpenRecord's responses are checked for leaks; Google's consent redirect carries the code by design
        req = urllib.request.Request(path if path.startswith("http") else base + path, data=None if payload is None else json.dumps(payload).encode(), method=method,
                                     headers={"Content-Type": "application/json", "Origin": base})
        try:
            with self.opener.open(req, timeout=30) as res:
                raw = res.read()
                if ours:
                    self.bodies.append(raw.decode(errors="replace"))
                return res.status, (json.loads(raw) if raw else None), res.headers
        except urllib.error.HTTPError as err:
            raw = err.read()
            if ours:
                self.bodies.append(raw.decode(errors="replace") + (err.headers.get("location") or ""))
            try:
                return err.code, json.loads(raw) if raw else None, err.headers
            except Exception:
                return err.code, None, err.headers
    def ok(self, method, path, payload=None):
        s, d, _ = self.call(method, path, payload)
        assert s == 200, f"{method} {path} -> {s} {d}"
        return d

def psql(sql):
    out = subprocess.run(["psql", os.environ["DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError("sql failed: " + out.stderr.strip()[:200])
    return out.stdout.strip()

logs = Path(tempfile.mkdtemp(prefix="ga4-smoke-"))
processes = []
def start(entry, app, extra):
    env = dict(os.environ, PORT=str(API_PORT), APP_BASE_URL=base, NINE_ROUTER_ENABLED="false", WORKER_POLL_MS="50", **extra)
    env.pop("NODE_ENV", None)
    log = open(logs / f"{app}-{len(processes)}.log", "wb")
    p = subprocess.Popen(["node", "--import", "tsx", f"dist/{entry}.js"], cwd=root / "apps" / app, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(p)
    return p
def stop_all():
    for p in processes:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
    for p in processes:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
    processes.clear()
def wait_api():
    deadline = time.monotonic() + 90
    while True:
        try:
            if Client().call("GET", "/api/auth/me")[0] == 401:
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("API startup timed out")
        time.sleep(0.2)
def until(fn, what, seconds=40):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError("timed out waiting for " + what)

try:
    # Phase 1: no GA4 configuration. The feature says so and refuses.
    start("server", "api", {})
    wait_api()
    op = Client()
    marker = uuid.uuid4().hex[:10]
    email = f"ga4-{marker}@fixture.test"
    assert op.call("POST", "/api/auth/signup", {"email": email, "password": "disposable-fixture-password", "accountName": "GA4 smoke fixture"})[0] in (200, 201)
    assert op.call("POST", "/api/auth/signin", {"email": email, "password": "disposable-fixture-password"})[0] == 200
    profile = op.ok("POST", "/api/growth/products", {"name": "TEST GA4 Salon", "websiteUrl": "https://salon.test", "engagement": "CLIENT", "category": "TEST", "audience": "TEST", "valueProposition": "TEST",
        "goalStatement": "Increase bookings", "metric": {"conversionKind": "BOOKING", "label": "Bookings", "sourceKind": "GA4_AGGREGATE_EXPORT", "sourceIdentity": "TEST GA4", "eventName": EVENT,
        "reportingTimeZone": TZ, "propertyRef": P1, "countingSemantics": "EVENT_COUNT", "unit": "COUNT", "currency": None}, "idempotencyKey": str(uuid.uuid4())})["profile"]
    biz, definition = profile["businessId"], profile["primaryGoal"]["metricDefinition"]["id"]
    unconfigured = op.ok("GET", "/api/growth/ga4/connections")
    refused = op.call("POST", "/api/growth/ga4/connect", {"businessId": biz})
    check("G.01 without configuration the connection is reported unavailable and refused", unconfigured["configured"] is False and refused[0] == 503 and refused[1]["reason"] == "Ga4NotConfigured")
    stop_all()

    # Phase 2: the deployment configures the OAuth client, exact redirect URI and encryption key.
    cfg = {"GOOGLE_OAUTH_CLIENT_ID": CLIENT_ID, "GOOGLE_OAUTH_CLIENT_SECRET": CLIENT_SECRET, "GA4_OAUTH_REDIRECT_URI": REDIRECT,
           "GA4_TOKEN_ENCRYPTION_KEYS": f"smoke:{KEY}", "GA4_PROVIDER_STAND_IN_URL": GOOGLE}
    start("server", "api", cfg)
    start("runner", "worker", cfg)
    wait_api()
    assert op.call("POST", "/api/auth/signin", {"email": email, "password": "disposable-fixture-password"})[0] == 200
    auth_url = op.ok("POST", "/api/growth/ga4/connect", {"businessId": biz})["authorizationUrl"]
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(auth_url).query))
    check("G.02 the authorization request is read-only, PKCE S256, with the exact redirect URI", q["scope"] == f"openid email {READONLY}" and q["code_challenge_method"] == "S256" and q["redirect_uri"] == REDIRECT
          and CLIENT_SECRET not in auth_url)
    status, _, headers = op.call("GET", auth_url)
    callback = headers.get("location")
    check("G.03 the stand-in consent screen redirects back to the registered callback", status == 302 and callback.startswith(REDIRECT + "?"))
    status, _, headers = op.call("GET", callback)
    check("G.04 the callback exchanges the code with the PKCE verifier and lands on the measurement page",
          status == 303 and headers.get("location") == f"{base}/clients/{biz}/growth-measurement?ga4=connected" and google_state()["pkceChecked"] == 1)
    replay = op.call("GET", callback)
    check("G.05 the same callback cannot be replayed", replay[0] == 303 and replay[2].get("location", "").endswith("ga4=state_reused"))
    conn = op.ok("GET", "/api/growth/ga4/connections")["connections"][0]
    check("G.06 the connection records the authorizing identity and read-only scope", conn["status"] == "ACTIVE" and conn["googleEmail"] == "agency@smoke.test" and READONLY in conn["grantedScopes"])
    props = op.ok("GET", f"/api/growth/ga4/connections/{conn['id']}/properties")["properties"]
    check("G.07 only properties the identity can read are listed", [p["property"] for p in props] == [P1])
    bind = lambda prop: op.call("POST", f"/api/growth/clients/{biz}/ga4/bindings", {"connectionId": conn["id"], "property": prop, "metricDefinitionId": definition, "eventName": EVENT, "idempotencyKey": str(uuid.uuid4())})
    check("G.08 a property the identity cannot read cannot be bound", bind(P_FOREIGN)[0] == 409)
    binding = bind(P1)[1]["binding"]
    check("G.09 the property, key event and time zone are bound to the exact definition", binding["metricDefinitionId"] == definition and binding["propertyTimeZone"] == TZ and binding["providerMetric"] == "keyEvents")

    # The worker's scheduled refresh (the last three complete days) records its own observations; count the September window under test.
    imports = lambda: int(psql(f"SELECT count(*) FROM growth_metric_imports WHERE business_id='{biz}' AND provenance='AUTHENTICATED_PROVIDER_API' AND date_start <= '2026-09-05' AND date_end >= '2026-09-01'"))
    def sync(start_day, end_day, kind="BACKFILL"):
        # One open job per binding: the worker's own scheduled refresh may be queued or running; let it settle first.
        until(lambda: psql(f"SELECT count(*) FROM growth_ga4_sync_jobs WHERE binding_id='{binding['id']}' AND status IN ('QUEUED','CLAIMED')") == "0", "open jobs to settle")
        job = op.ok("POST", f"/api/growth/clients/{biz}/ga4/bindings/{binding['id']}/sync", {"kind": kind, "dateStart": start_day, "dateEnd": end_day, "idempotencyKey": str(uuid.uuid4())})["job"]
        return until(lambda: psql(f"SELECT status FROM growth_ga4_sync_jobs WHERE id='{job['id']}'") in ("SUCCEEDED", "FAILED") and psql(f"SELECT status FROM growth_ga4_sync_jobs WHERE id='{job['id']}'"), "sync job")
    check("G.10 the worker synchronizes a historical window", sync("2026-09-01", "2026-09-05") == "SUCCEEDED" and imports() == 1)
    series = op.ok("GET", f"/api/growth/clients/{biz}/metrics/{definition}/series?start=2026-09-01&end=2026-09-05")["series"]
    values = [(d["day"], d["value"], d["status"]) for d in series["days"]]
    check("G.11 key events per day, an explicit zero kept, a missing day not fabricated",
          values == [("2026-09-01", 3, "OK"), ("2026-09-02", 0, "OK"), ("2026-09-03", 5, "OK"), ("2026-09-04", None, "MISSING"), ("2026-09-05", 2, "OK")]
          and all(d.get("provider") == "GA4_DATA_API" for d in series["days"] if d["value"] is not None), str(values))
    check("G.12 a repeated identical answer is confirmed, not stored twice", sync("2026-09-01", "2026-09-05", "REFRESH") == "SUCCEEDED" and imports() == 1
          and "UNCHANGED" in psql(f"SELECT string_agg(outcome, ',' ORDER BY finished_at) FROM growth_ga4_sync_runs WHERE binding_id='{binding['id']}'").split(","))
    urllib.request.urlopen(urllib.request.Request(GOOGLE + "/__revise", method="POST", data=b""), timeout=5)
    sync("2026-09-01", "2026-09-05")
    series = op.ok("GET", f"/api/growth/clients/{biz}/metrics/{definition}/series?start=2026-09-01&end=2026-09-05")["series"]
    check("G.13 a provider revision is kept as a revision, not a conflict", imports() == 2 and series["revisions"] == [{"day": "2026-09-03", "values": [5, 9]}] and series["conflicts"] == []
          and series["days"][2]["value"] == 9)
    health = op.ok("GET", f"/api/growth/clients/{biz}/ga4/bindings")["health"][0]
    check("G.14 health shows a fresh connection and its last successful synchronization", health["freshness"] == "FRESH" and health["lastSuccessfulSyncAt"] and health["connectionStatus"] == "ACTIVE")
    other = Client()
    assert other.call("POST", "/api/auth/signup", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})[0] in (200, 201)
    assert other.call("POST", "/api/auth/signin", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})[0] == 200
    check("G.15 another account sees neither the connection nor the business's bindings",
          other.ok("GET", "/api/growth/ga4/connections")["connections"] == [] and other.call("GET", f"/api/growth/ga4/connections/{conn['id']}/properties")[0] == 404
          and other.call("GET", f"/api/growth/clients/{biz}/ga4/bindings")[0] == 404)
    gone = op.ok("POST", f"/api/growth/ga4/connections/{conn['id']}/disconnect", {"idempotencyKey": str(uuid.uuid4())})["connection"]
    check("G.16 disconnect revokes at Google and erases stored credentials", gone["status"] == "DISCONNECTED" and gone["revocationConfirmed"] is True and google_state()["revoked"] == 1
          and psql(f"SELECT coalesce(refresh_ciphertext,'')||coalesce(access_ciphertext,'') FROM growth_ga4_credentials WHERE connection_id='{conn['id']}'") == "")
    check("G.17 collected observations survive the disconnect", imports() == 2)
    stop_all()
    secrets_seen = google_state()["issued"] + [CLIENT_SECRET, KEY]
    responses = "\n".join(op.bodies + other.bodies)
    process_logs = "\n".join(p.read_text(errors="replace") for p in logs.glob("*.log"))
    stored = psql("SELECT coalesce(string_agg(raw_text, ''), '') FROM growth_metric_imports WHERE provenance='AUTHENTICATED_PROVIDER_API'")
    leaked = [s[:8] + "…" + ("R" if s in responses else "") + ("L" if s in process_logs else "") + ("S" if s in stored else "") for s in secrets_seen if s in responses or s in process_logs or s in stored]
    check("G.18 no token, code, client secret or key in any response, log line or stored evidence", leaked == [], str(leaked))
    print("GA4 measurement runtime smoke passed (MOCK_ADAPTER_PASS: local Google stand-in over HTTP; not LIVE_PROVIDER_PASS)")
except Exception as err:
    if isinstance(err, (AssertionError, RuntimeError)):
        print(f"GA4 measurement runtime smoke failed: {err}")
    else:
        print(f"GA4 measurement runtime smoke failed: {type(err).__name__}: {str(err)[:200]}")
    sys.exit(1)
finally:
    stop_all()
    stand_in.shutdown()
