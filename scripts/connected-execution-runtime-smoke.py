#!/usr/bin/env python3
"""Built-runtime smoke for W7 connected execution (TEST fixtures, loopback only).

Boots the BUILT API and worker against a disposable loopback database and a
local GitHub STAND-IN (an independent Python implementation of the few REST
endpoints OpenRecord uses). The real HTTP transport, the real worker loop and
the real database guards run; the provider is a mock. A pass here is
MOCK_ADAPTER_PASS. It is not LIVE_PROVIDER_PASS and it is not LIVE_SITE_PASS:
the live-site check goes through the real SSRF-safe fetch, which refuses the
unroutable test hostname, so the site observation is reported as
inconclusive, never as success.

Requires HOSTED_SMOKE_ALLOWED=1 and a migrated, disposable loopback DATABASE_URL.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import signal
import subprocess
import sys
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
API_PORT = int(os.environ.get("EXEC_SMOKE_PORT", "3027"))
GH_PORT = int(os.environ.get("EXEC_SMOKE_GITHUB_PORT", "3028"))
TOKEN = "smoke-token-" + uuid.uuid4().hex
OWNER, REPO = "smoke-owner", "salon-site"
PAGE = "pricing.html"
BEFORE = '<!doctype html>\n<html>\n<head>\n<title>Pricing</title>\n<meta name="robots" content="noindex">\n</head>\n<body>Pricing</body>\n</html>\n'
base = f"http://127.0.0.1:{API_PORT}"
checks = []

def check(name, ok, detail=""):
    checks.append({"check": name, "pass": bool(ok)})
    print(("PASS " if ok else "FAIL ") + name + (f" -- {detail}" if detail and not ok else ""))
    if not ok:
        raise AssertionError(name)

# ------------------------------------------------------------------ GitHub stand-in
def blob_sha(text):
    b = text.encode()
    return hashlib.sha1(b"blob " + str(len(b)).encode() + b"\0" + b).hexdigest()

class GitHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.counter = 0
        head = self.sha("base")
        self.branches = {"main": {"head": head, "files": {PAGE: BEFORE}}}
        self.commits = {head: {PAGE: BEFORE}}
        self.prs = []
        self.writes = []
        self.requests = 0
        self.bad_auth = 0
    def sha(self, s):
        self.counter += 1
        return hashlib.sha1(f"{s}-{self.counter}".encode()).hexdigest()
    def pr_json(self, p):
        full = f"{OWNER}/{REPO}"
        return {"number": p["number"], "html_url": f"https://github.com/{full}/pull/{p['number']}", "state": p["state"], "merged": p["merged"],
                "merge_commit_sha": p["merge"], "merged_at": p["merged_at"], "closed_at": "2026-10-20T00:00:00Z" if p["state"] == "closed" else None,
                "head": {"sha": self.branches[p["head"]]["head"], "ref": p["head"], "repo": {"full_name": full}}, "base": {"ref": p["base"], "repo": {"full_name": full}}}

gh = GitHub()

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
    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")
    def handle_any(self, method):
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path, urllib.parse.parse_qs(url.query)
        with gh.lock:
            if path.startswith("/__"):
                return self.control(method, path)
            gh.requests += 1
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                gh.bad_auth += 1
                return self.send(401, {"message": "Bad credentials"})
            m = re.match(rf"^/repos/{OWNER}/{REPO}(/.*)?$", path)
            if not m:
                return self.send(404, {"message": "Not Found"})
            rest = m.group(1) or ""
            if rest == "" and method == "GET":
                return self.send(200, {"default_branch": "main", "full_name": f"{OWNER}/{REPO}"})
            if (g := re.match(r"^/git/ref/heads/(.+)$", rest)) and method == "GET":
                b = gh.branches.get(urllib.parse.unquote(g.group(1)))
                return self.send(200, {"object": {"sha": b["head"]}}) if b else self.send(404)
            if (g := re.match(r"^/contents/(.+)$", rest)):
                p = urllib.parse.unquote(g.group(1))
                if method == "GET":
                    ref = query.get("ref", ["main"])[0]
                    files = gh.commits.get(ref) or (gh.branches.get(ref) or {}).get("files")
                    if files is None or p not in files:
                        return self.send(404)
                    c = files[p]
                    return self.send(200, {"type": "file", "size": len(c.encode()), "encoding": "base64", "content": base64.b64encode(c.encode()).decode(), "sha": blob_sha(c)})
                if method == "PUT":
                    b = self.body()
                    br = gh.branches.get(b["branch"])
                    if not br or p not in br["files"] or blob_sha(br["files"][p]) != b["sha"]:
                        return self.send(409, {"message": "conflict"})
                    br["files"][p] = base64.b64decode(b["content"]).decode()
                    br["head"] = gh.sha("commit")
                    gh.commits[br["head"]] = dict(br["files"])
                    gh.writes.append(f"commit:{b['branch']}:{p}")
                    return self.send(200, {"commit": {"sha": br["head"]}})
            if rest == "/git/refs" and method == "POST":
                b = self.body()
                name = b["ref"].removeprefix("refs/heads/")
                if name in gh.branches:
                    return self.send(422, {"message": "Reference already exists"})
                if b["sha"] not in gh.commits:
                    return self.send(422, {"message": "Object does not exist"})
                gh.branches[name] = {"head": b["sha"], "files": dict(gh.commits[b["sha"]])}
                gh.writes.append(f"branch:{name}")
                return self.send(201, {"ref": b["ref"]})
            if rest == "/pulls" and method == "GET":
                head = query.get("head", [""])[0].split(":", 1)[-1]
                found = [p for p in gh.prs if p["head"] == head and p["base"] == query.get("base", ["main"])[0]]
                return self.send(200, [gh.pr_json(found[0])] if found else [])
            if rest == "/pulls" and method == "POST":
                b = self.body()
                if b["head"] not in gh.branches or any(p["head"] == b["head"] and p["state"] == "open" for p in gh.prs):
                    return self.send(422, {"message": "Validation Failed"})
                p = {"number": len(gh.prs) + 1, "head": b["head"], "base": b["base"], "state": "open", "merged": False, "merge": None, "merged_at": None, "changed": [], "title": b["title"], "body": b["body"]}
                gh.prs.append(p)
                gh.writes.append(f"pr:{p['number']}")
                return self.send(201, gh.pr_json(p))
            if (g := re.match(r"^/pulls/(\d+)(/files)?$", rest)) and method == "GET":
                p = next((x for x in gh.prs if x["number"] == int(g.group(1))), None)
                if not p:
                    return self.send(404)
                if g.group(2):
                    base_f, head_f = gh.branches[p["base"]]["files"], gh.branches[p["head"]]["files"]
                    paths = p["changed"] or [k for k in set(base_f) | set(head_f) if base_f.get(k) != head_f.get(k)]
                    return self.send(200, [{"filename": k, "status": "modified"} for k in sorted(paths)])
                return self.send(200, gh.pr_json(p))
            return self.send(404, {"message": "Not Found"})
    def control(self, method, path):
        if path == "/__state":
            return self.send(200, {"writes": gh.writes, "prs": len(gh.prs), "requests": gh.requests, "badAuth": gh.bad_auth})
        g = re.match(r"^/__merge/(\d+)$", path)
        if g and method == "POST":
            p = next(x for x in gh.prs if x["number"] == int(g.group(1)))
            base, head = gh.branches[p["base"]], gh.branches[p["head"]]
            p["changed"] = [k for k in set(base["files"]) | set(head["files"]) if base["files"].get(k) != head["files"].get(k)]
            base["files"].update(head["files"])
            base["head"] = gh.sha("merge")
            gh.commits[base["head"]] = dict(base["files"])
            p.update(state="closed", merged=True, merge=base["head"], merged_at="2026-10-20T10:00:00Z")
            return self.send(200)
        return self.send(404)
    def do_GET(self):
        self.handle_any("GET")
    def do_POST(self):
        self.handle_any("POST")
    def do_PUT(self):
        self.handle_any("PUT")

github = ThreadingHTTPServer(("127.0.0.1", GH_PORT), Handler)
threading.Thread(target=github.serve_forever, daemon=True).start()

def ctl(method, path):
    req = urllib.request.Request(f"http://127.0.0.1:{GH_PORT}{path}", method=method, data=b"{}" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read() or b"{}")

# ------------------------------------------------------------------ app client
class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, payload=None):
        req = urllib.request.Request(base + path, data=None if payload is None else json.dumps(payload).encode(), method=method, headers={"Content-Type": "application/json", "Origin": base})
        try:
            with self.opener.open(req, timeout=30) as res:
                body = res.read()
                return res.status, (json.loads(body) if body else None)
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except Exception:
                return err.code, None
    def ok(self, method, path, payload=None):
        s, d = self.call(method, path, payload)
        assert s == 200, f"{method} {path} -> {s} {d}"
        return d

def psql(sql):
    out = subprocess.run(["psql", os.environ["DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError("sql failed: " + out.stderr.strip()[:200])
    return out.stdout.strip()

processes = []
def start(entry, app, extra):
    env = dict(os.environ, PORT=str(API_PORT), APP_BASE_URL=base, NINE_ROUTER_ENABLED="false", WORKER_POLL_MS="50", **extra)
    env.pop("NODE_ENV", None)
    p = subprocess.Popen(["node", "--import", "tsx", f"dist/{entry}.js"], cwd=root / "apps" / app, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
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
    # Phase 1: an account and a business (no provider configured yet).
    start("server", "api", {})
    wait_api()
    op = Client()
    marker = uuid.uuid4().hex[:10]
    email = f"exec-{marker}@fixture.test"
    assert op.call("POST", "/api/auth/signup", {"email": email, "password": "disposable-fixture-password", "accountName": "Exec smoke fixture"})[0] in (200, 201)
    assert op.call("POST", "/api/auth/signin", {"email": email, "password": "disposable-fixture-password"})[0] == 200
    profile = op.ok("POST", "/api/growth/products", {"name": "TEST Smoke Salon", "websiteUrl": "https://salon.test", "engagement": "CLIENT", "category": "TEST", "audience": "TEST", "valueProposition": "TEST",
        "goalStatement": "Increase bookings", "metric": {"conversionKind": "BOOKING", "label": "Bookings", "sourceKind": "OPERATOR_AGGREGATE_EXPORT", "sourceIdentity": "TEST", "eventName": None,
        "reportingTimeZone": "UTC", "propertyRef": None, "countingSemantics": "EVENT_COUNT", "unit": "COUNT", "currency": None}, "idempotencyKey": str(uuid.uuid4())})["profile"]
    biz, goal = profile["businessId"], profile["primaryGoal"]["id"]
    site = op.ok("POST", f"/api/businesses/{biz}/search/sites", {"rootUrl": "https://salon.test/"})["site"]["id"]
    account = psql(f"SELECT account_id FROM businesses WHERE id='{biz}'")
    user = op.ok("GET", "/api/auth/me")["userId"]
    unconfigured = op.call("POST", f"/api/growth/clients/{biz}/execution-targets", {"owner": OWNER, "repository": REPO, "baseBranch": "main", "siteTargetId": site, "allowedPaths": [PAGE], "idempotencyKey": str(uuid.uuid4())})
    check("S.01 without provider configuration nothing can be connected", unconfigured[0] == 409 and unconfigured[1]["reason"] == "RepositoryNotPermitted")
    stop_all()

    # Phase 2: the deployment configures the provider and allows exactly one repository for this account.
    cfg = {"GITHUB_EXECUTION_TOKEN": TOKEN, "GITHUB_EXECUTION_REPOSITORIES": f"{OWNER}/{REPO}={account},commonfields/openrecord={account}", "GITHUB_EXECUTION_API_URL": f"http://127.0.0.1:{GH_PORT}",
           "EXECUTION_RECONCILE_POLL_SECONDS": "1", "EXECUTION_LIVE_CHECK_DELAY_SECONDS": "0"}
    start("server", "api", cfg)
    start("runner", "worker", cfg)
    wait_api()
    assert op.call("POST", "/api/auth/signin", {"email": email, "password": "disposable-fixture-password"})[0] == 200
    base_c = f"/api/growth/clients/{biz}"
    # The destination is operator-controlled: OpenRecord's own repository is refused even if a configuration names it.
    own = op.call("POST", f"{base_c}/execution-targets", {"owner": "commonfields", "repository": "openrecord", "baseBranch": "main", "siteTargetId": site, "allowedPaths": [PAGE], "idempotencyKey": str(uuid.uuid4())})
    check("S.02 OpenRecord's own repository is refused even when listed", own[0] == 409)
    other = op.call("POST", f"{base_c}/execution-targets", {"owner": "someone", "repository": "else", "baseBranch": "main", "siteTargetId": site, "allowedPaths": [PAGE], "idempotencyKey": str(uuid.uuid4())})
    check("S.03 a repository outside the allowlist is refused", other[0] == 409 and other[1]["reason"] == "RepositoryNotPermitted")
    target = op.ok("POST", f"{base_c}/execution-targets", {"owner": OWNER, "repository": REPO, "baseBranch": "main", "siteTargetId": site, "allowedPaths": [PAGE, "pages/"], "idempotencyKey": str(uuid.uuid4())})["target"]
    opp = op.ok("POST", f"{base_c}/opportunities", {"goalId": goal, "title": "TEST remove accidental noindex", "problemStatement": "TEST hidden", "audience": "TEST", "buyerIntent": "TEST", "targetUrl": None, "source": "TEST",
        "proposedChange": "TEST", "expectedMechanism": "TEST", "assumptions": "TEST", "uncertainty": "TEST", "baselineAvailability": "UNKNOWN", "ownerUserId": user, "initialStatus": "PROPOSED", "idempotencyKey": str(uuid.uuid4()),
        "evidence": [{"type": "OPERATOR_HYPOTHESIS", "note": "TEST"}]})["opportunity"]["id"]
    op.ok("POST", f"{base_c}/opportunities/{opp}/approve", {"expectedStatus": "PROPOSED", "expectedRevision": 1, "idempotencyKey": str(uuid.uuid4()), "reason": "TEST approve"})
    prepared = op.ok("POST", f"{base_c}/opportunities/{opp}/connected-executions", {"targetId": target["id"], "actionKind": "REMOVE_NOINDEX_META", "filePath": PAGE, "liveUrl": "https://salon.test/pricing.html",
        "rationale": "TEST remove an accidental noindex", "siteFindingId": None, "idempotencyKey": str(uuid.uuid4())})["operation"]
    check("S.04 the exact change is prepared from the provider's page, and nothing was written", prepared["state"] == "PREPARED" and 'robots' in prepared["diff"] and ctl("GET", "/__state")["writes"] == [])
    authorized = op.ok("POST", f"{base_c}/connected-executions/{prepared['id']}/authorize", {"reviewedPatchSha256": prepared["patchSha256"], "expectedRevision": 1, "reason": "TEST reviewed the diff", "idempotencyKey": str(uuid.uuid4())})["operation"]
    check("S.05 the operator authorizes the exact patch", authorized["state"] == "AUTHORIZED")
    op.ok("POST", f"{base_c}/connected-executions/{prepared['id']}/dispatch", {"expectedRevision": 2, "idempotencyKey": str(uuid.uuid4())})
    pending = until(lambda: (lambda o: o if o["state"] == "AWAITING_MERGE" else None)(op.ok("GET", f"{base_c}/connected-executions/{prepared['id']}")["operation"]), "pull request")
    state = ctl("GET", "/__state")
    check("S.06 the worker opened exactly one branch, one commit and one pull request through the real transport", state["writes"] == [f"branch:openrecord/exec-{prepared['id']}", f"commit:openrecord/exec-{prepared['id']}:{PAGE}", "pr:1"], str(state))
    check("S.07 every provider request carried the configured credential and the credential is not in any response", state["badAuth"] == 0 and TOKEN not in json.dumps(pending))
    check("S.08 an open pull request is not a verified merge", pending["receipt"] is None and int(psql(f"SELECT count(*) FROM interventions WHERE verification_id='{prepared['id']}'")) == 0)
    cross = Client()
    assert cross.call("POST", "/api/auth/signup", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})[0] in (200, 201)
    assert cross.call("POST", "/api/auth/signin", {"email": f"other-{marker}@fixture.test", "password": "disposable-fixture-password"})[0] == 200
    check("S.09 another account cannot see the operation", cross.call("GET", f"{base_c}/connected-executions/{prepared['id']}")[0] == 404)
    check("S.10 the initiative's final decision waits for the unresolved change",
          op.call("POST", f"{base_c}/opportunities/{opp}/cancel", {"expectedStatus": "APPROVED", "expectedRevision": 2, "idempotencyKey": str(uuid.uuid4()), "reason": "TEST"})[1]["reason"] == "ExecutionUnresolved")
    # The maintainer merges; the operator asks for an immediate check instead of waiting for the poll.
    ctl("POST", "/__merge/1")
    op.ok("POST", f"{base_c}/connected-executions/{prepared['id']}/check", {"idempotencyKey": str(uuid.uuid4())})
    done = until(lambda: (lambda o: o if o["state"] == "VERIFIED" else None)(op.ok("GET", f"{base_c}/connected-executions/{prepared['id']}")["operation"]), "verified merge")
    check("S.11 the merge is verified from provider evidence and produces one receipt", done["receipt"]["claim"] == "PR_MERGED" and int(psql(f"SELECT count(*) FROM interventions WHERE verification_id='{prepared['id']}'")) == 1)
    ledger = op.ok("GET", f"{base_c}/opportunities/{opp}")["opportunity"]
    check("S.12 the initiative shows a SYSTEM_VERIFIED merge and is still APPROVED", ledger["status"] == "APPROVED" and ledger["executions"][0]["assurance"] == "SYSTEM_VERIFIED" and ledger["executions"][0]["verification"]["claim"] == "PR_MERGED")
    live = until(lambda: (lambda o: o if o["liveChecks"] else None)(op.ok("GET", f"{base_c}/connected-executions/{prepared['id']}")["operation"]), "live check")
    check("S.13 the live site is observed separately; an unreachable site is inconclusive, never success", live["liveChecks"][0]["result"] == "INCONCLUSIVE" and live["state"] == "VERIFIED", live["liveChecks"][0]["detail"])
    forged = subprocess.run(["psql", os.environ["DATABASE_URL"], "-c", f"INSERT INTO interventions(business_id,type,target,performed_at,actor,channel,assurance,verification_kind,verification_id,verification_claim) VALUES('{biz}','SOURCE_UPDATED','x',now(),'SYSTEM','WEBSITE','SYSTEM_VERIFIED','GROWTH_DELIVERY','{uuid.uuid4()}','PR_MERGED')"], capture_output=True, text=True)
    check("S.14 a receipt cannot be forged through SQL", forged.returncode != 0 and "unverified" in forged.stderr)
    reviewed = op.call("POST", f"{base_c}/opportunities/{opp}/review", {"expectedStatus": "APPROVED", "expectedRevision": 2, "idempotencyKey": str(uuid.uuid4()), "reason": "TEST decide", "conclusion": "KEEP"})
    check("S.15 once settled, the human decision is recorded with the receipt in place", reviewed[0] == 200)
    print("connected execution runtime smoke passed (MOCK_ADAPTER_PASS: local GitHub stand-in over HTTP; not LIVE_PROVIDER_PASS, not LIVE_SITE_PASS)")
except Exception as err:
    if isinstance(err, (AssertionError, RuntimeError)):
        print(f"connected execution runtime smoke failed: {err}")
    else:
        print(f"connected execution runtime smoke failed: {type(err).__name__}: {str(err)[:200]}")
    sys.exit(1)
finally:
    stop_all()
    github.shutdown()
