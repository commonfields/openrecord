#!/usr/bin/env python3
"""Read-only live probe: how does the real GA4 Data API report a zero day?

W8 reads daily key-event counts with one report (date x eventName, metrics
keyEvents and eventCount, an exact eventName filter, keepEmptyRows). A day
without a row stays MISSING; zero is recorded only when Google returns "0".
Google's documentation does not settle whether that filtered report returns
an explicit zero row for a day on which the event did not occur, so the
modeled fixtures cannot answer it. This probe asks the real API.

For one property, key event and window of complete days it runs four reads:

  A  OpenRecord's exact W8 request (packages/ga4/src/report.ts)
  B  the same with keepEmptyRows false
  C  date only, metric keyEvents:<event>, keepEmptyRows true
  D  date only, metric eventCount (any event), keepEmptyRows true

and classifies every day: EXPLICIT_ZERO or POSITIVE in A; for a day missing
from A, whether C reports an explicit zero (the event was absent on a day the
property recorded data), D shows property activity, or nothing reports the
day at all. Response restrictions (sampling, "(other)" rows, thresholding,
emptyReason, schema restrictions) are recorded per read.

The answer decides whether W8's MISSING days are genuine gaps or zero days
that a different request could report authoritatively. It is evidence for a
human decision; this probe changes nothing in OpenRecord or in Google.

Usage (an authorized operator, read-only token, never pasted into chat):
  GA4_PROBE_ACCESS_TOKEN=<analytics.readonly access token> \\
    python3 scripts/ga4-zero-semantics-probe.py --property properties/N \\
      --event generate_lead --start 2026-09-01 --end 2026-09-30 \\
      --output ~/openrecord-validation-private/<dir>/ga4-zero-probe.json

  python3 scripts/ga4-zero-semantics-probe.py --self-test   # offline classifier check

The token is sent only as a request header to analyticsdata.googleapis.com.
It is never printed or written. Keep the output private: it contains the
property id and daily counts.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

DATA_API = "https://analyticsdata.googleapis.com/v1beta"
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def variant_bodies(event, start, end):
    window = [{"startDate": start, "endDate": end}]
    exact = {"filter": {"fieldName": "eventName", "stringFilter": {"matchType": "EXACT", "value": event, "caseSensitive": True}}}
    a = {"dateRanges": window, "dimensions": [{"name": "date"}, {"name": "eventName"}],
         "metrics": [{"name": "keyEvents"}, {"name": "eventCount"}], "dimensionFilter": exact,
         "keepEmptyRows": True, "limit": 1000, "returnPropertyQuota": True}
    b = dict(a, keepEmptyRows=False)
    c = {"dateRanges": window, "dimensions": [{"name": "date"}], "metrics": [{"name": f"keyEvents:{event}"}],
         "keepEmptyRows": True, "limit": 1000, "returnPropertyQuota": True}
    d = {"dateRanges": window, "dimensions": [{"name": "date"}], "metrics": [{"name": "eventCount"}],
         "keepEmptyRows": True, "limit": 1000, "returnPropertyQuota": True}
    return {"A_openrecord_w8": a, "B_no_empty_rows": b, "C_date_only_key_event_metric": c, "D_date_only_property_activity": d}


def iso_day(yyyymmdd):
    return f"{yyyymmdd[0:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}" if re.fullmatch(r"\d{8}", yyyymmdd or "") else None


def summarize(response):
    """Per-day first metric value as Google's string, plus the restriction metadata."""
    if "error" in response:
        err = response["error"]
        return {"error": {"status": err.get("status"), "code": err.get("code"), "message": str(err.get("message", ""))[:300]}}
    meta = response.get("metadata", {}) or {}
    dims = [h.get("name") for h in response.get("dimensionHeaders", [])]
    date_at = dims.index("date") if "date" in dims else -1
    days = {}
    for row in response.get("rows", []) or []:
        day = iso_day(row["dimensionValues"][date_at]["value"]) if date_at >= 0 else None
        days[day] = row["metricValues"][0]["value"]
    return {
        "rowCount": response.get("rowCount"),
        "days": days,
        "metadata": {
            "timeZone": meta.get("timeZone"),
            "subjectToThresholding": meta.get("subjectToThresholding", False),
            "dataLossFromOtherRow": meta.get("dataLossFromOtherRow", False),
            "sampled": bool(meta.get("samplingMetadatas")),
            "emptyReason": meta.get("emptyReason"),
            "schemaRestrictionResponse": meta.get("schemaRestrictionResponse"),
        },
    }


def classify(start, end, reads):
    a, c, d = (reads.get(k, {}) for k in ("A_openrecord_w8", "C_date_only_key_event_metric", "D_date_only_property_activity"))
    out, day = [], dt.date.fromisoformat(start)
    while day <= dt.date.fromisoformat(end):
        k = day.isoformat()
        va, vc, vd = (r.get("days", {}).get(k) if "error" not in r else None for r in (a, c, d))
        if va is not None:
            verdict = "EXPLICIT_ZERO" if va == "0" else "POSITIVE"
        elif vc == "0":
            verdict = "MISSING_IN_A__ZERO_IN_C"
        elif vc is not None:
            verdict = "MISSING_IN_A__POSITIVE_IN_C"  # would contradict A: investigate
        elif vd is not None:
            verdict = "MISSING_IN_A_AND_C__PROPERTY_ACTIVE"
        else:
            verdict = "NO_DATA_IN_ANY_READ"
        out.append({"day": k, "A": va, "C": vc, "D": vd, "verdict": verdict})
        day += dt.timedelta(days=1)
    counts = {}
    for row in out:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
    return out, counts


def post(token, prop, body):
    req = urllib.request.Request(f"{DATA_API}/{prop}:runReport", data=json.dumps(body).encode(), method="POST",
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"error": {"code": e.code, "status": "HTTP_ERROR", "message": ""}}


def self_test():
    rows = lambda pairs, two=False: {"dimensionHeaders": [{"name": "date"}] + ([{"name": "eventName"}] if two else []),
                                     "metadata": {"timeZone": "UTC"},
                                     "rows": [{"dimensionValues": [{"value": d}] + ([{"value": "e"}] if two else []), "metricValues": [{"value": v}]} for d, v in pairs]}
    reads = {
        "A_openrecord_w8": summarize(rows([("20260901", "3"), ("20260902", "0")], two=True)),
        "C_date_only_key_event_metric": summarize(rows([("20260901", "3"), ("20260902", "0"), ("20260903", "0")])),
        "D_date_only_property_activity": summarize(rows([("20260901", "9"), ("20260902", "4"), ("20260903", "2"), ("20260904", "1")])),
    }
    days, counts = classify("2026-09-01", "2026-09-05", reads)
    assert [d["verdict"] for d in days] == ["POSITIVE", "EXPLICIT_ZERO", "MISSING_IN_A__ZERO_IN_C", "MISSING_IN_A_AND_C__PROPERTY_ACTIVE", "NO_DATA_IN_ANY_READ"], days
    assert counts["POSITIVE"] == 1 and counts["NO_DATA_IN_ANY_READ"] == 1
    assert summarize({"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "x"}})["error"]["code"] == 403
    body = variant_bodies("e", "2026-09-01", "2026-09-05")["A_openrecord_w8"]
    assert body["keepEmptyRows"] is True and [m["name"] for m in body["metrics"]] == ["keyEvents", "eventCount"]
    print("self-test: pass")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--property")
    p.add_argument("--event")
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--output")
    a = p.parse_args()
    if a.self_test:
        return self_test()
    if not (a.property and re.fullmatch(r"properties/\d{1,20}", a.property)):
        raise SystemExit("--property must be properties/<number>")
    if not (a.event and a.start and a.end and ISO.match(a.start) and ISO.match(a.end) and a.start <= a.end):
        raise SystemExit("--event, --start and --end (YYYY-MM-DD, start <= end) are required")
    if dt.date.fromisoformat(a.end) >= dt.date.today():
        raise SystemExit("--end must be a complete day (before today); incomplete days are not evidence")
    token = os.environ.get("GA4_PROBE_ACCESS_TOKEN", "")
    if not token:
        raise SystemExit("GA4_PROBE_ACCESS_TOKEN is not set (read-only token; never paste it into chat)")
    collected = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    bodies = variant_bodies(a.event, a.start, a.end)
    reads = {name: summarize(post(token, a.property, body)) for name, body in bodies.items()}
    days, counts = classify(a.start, a.end, reads)
    report = {"schema": "openrecord.ga4-zero-semantics-probe/v1", "collectedAt": collected, "property": a.property,
              "event": a.event, "window": [a.start, a.end], "requests": bodies, "reads": reads, "days": days, "verdictCounts": counts}
    text = json.dumps(report, indent=2, sort_keys=True)
    if token in text:
        raise SystemExit("refusing to write: output would contain the token")
    if a.output:
        with open(os.path.expanduser(a.output), "w") as f:
            f.write(text + "\n")
    print(json.dumps({"verdictCounts": counts, "errors": {k: v["error"] for k, v in reads.items() if "error" in v},
                      "restrictions": {k: v.get("metadata") for k, v in reads.items() if "metadata" in v}}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
