# OpenRecord marketing control plane — W6 final report

Operator acceptance and pilot readiness. All data below is synthetic test
fixture data. Nothing here is customer evidence.

## 1. Repository state

| Item | Value |
| --- | --- |
| Starting `origin/main` | `af70c5d058d3f5ce34a64ff5c1d23e326b8601c2` (W4 merge) |
| W5 on starting `main`? | **No.** PR #69 merged into the W4 branch `claude/dazzling-edison-qtohzz`, not `main`. `0033_growth_reports_v1.sql` and all W5 code were absent. |
| W5 integration | PR #70 (`integrate/w5-client-report-to-main`), the single existing commit `f5c3fcb`, unchanged. Effective diff: 1 commit, 20 files, +1709/−4, W5 only. Remote CI passed (both CLI and hosted jobs). |
| `main` after W5 | `e634508` (merge of PR #70). W5 confirmed present, including `0033`. |
| W6 branch | `w6/operator-acceptance`, based on `e634508` |
| Final `main` SHA | The merge commit of the W6 PR. It is reported in the hand-off message because a report inside the PR cannot contain its own merge SHA. |

Nothing was recovered from bundles and nothing was rebuilt. W0–W5 architecture
was not changed.

## 2. Environment

Node 24.3.0, pnpm 10.12.1, PostgreSQL 16 (`postgres:16-alpine`, new loopback
container `openrecord-w6-pg16`). The host `psql` is 14, used only as a client.
Disposable databases: `w6_w5int`, `w6_base`, `w6_sw`, `w6_accept`, plus the
rehearsal databases the migration script creates. No existing container,
database or evidence was reset, stopped or modified. Legacy migration `0031`
was never replayed.

## 3. Test commands and counts

Baseline on clean `main` `e634508` and again on the W6 branch:
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — all exit 0.

| Package | Tests (baseline) | Tests (W6 branch) |
| --- | --- | --- |
| apps/api | 288 | 288 |
| apps/web | 99 | **102** (+3 regression tests) |
| apps/worker | 87 | 87 |
| packages/db | 246 | 246 |
| packages/representation | 202 | 202 |
| other packages | 344 | 344 |
| **Total** | **1266** | **1269** |

Remote CI on PR #70 (W5 integration) passed. Remote CI for the W6 PR is
recorded in the PR (section 11).

New acceptance driver: `scripts/marketing-w6-acceptance.py` (87 checks, final
run 87/87). It boots the **built** API against a disposable loopback database
and drives real HTTP with real signup, signin and cookie sessions. Results:
`docs/evidence/marketing-w6-acceptance-checks.json`.

## 4. Migration rehearsal (`0033`)

`scripts/verify-marketing-w5-migrations.py` against the loopback PG16, run on
the integration commit and on the W6 branch. Every result below is true:

- fresh install and replay;
- populated upgrade from the pre-`0033` lineage (with W0 rows) and replay;
- fresh and upgraded catalogs identical (`e37f5e68…`);
- a database already holding **5 published reports and 3 shares** replays with
  byte-identical rows;
- the legacy `0031` marker column is refused by `migrate()` and by `0033`
  applied alone, before any W5 object exists;
- no existing database was reset.

## 5. Software-business acceptance (GA4 signups)

Over the built API (checks A.01–A.19) **and** in a real browser (section 8):

1. Business, signup goal and GA4 count metric created.
2. Initiative proposed and approved by an authenticated operator.
3. Plan declared; operator-attested website action recorded.
4. GA4 baseline and observation imported (15/15 days).
5. Evaluation `COMPARABLE`: 4 → 6 per day (+2, +50%), totals +14, plan
   `PRE_DECLARED`, action shown as operator-attested, limitations listed.
6. Human review KEEP recorded; preview showed no decision before it existed.
7. Report v1 published; share link is 43 base64url characters (256 bits).
8. A client-facing context with no session opened the report: figures,
   decision, evidence and limitations present; no private notes, raw CSV,
   cookies or credentials; headers `no-store`, `noindex`, `no-referrer`.

## 6. Service-business acceptance (bookings, Asia/Makassar)

Same contracts, no business-specific code. Checks B.01–B.15 and browser:

- Operator CSV with 3 missing days; third-party listing update and email
  campaign recorded (two executions); an unrelated initiative's action in the
  same period.
- Evaluation `INDETERMINATE`; **no comparison figures**; missing days are
  `null`, never zero; other activity disclosed.
- Report published despite uncertainty; **no human decision invented**
  ("No decision has been recorded yet").
- Share link worked; revocation made it return the same 404 as unknown and
  malformed links.

## 7. Security and integrity results

All passed (87/87 API checks; the existing W3–W5 suites also cover these):

- **Execution.** Attested work never reads as verified. A corrected execution
  stays attributed to its initiative and does not invalidate plan timing; a
  correction dated before the plan correctly makes the plan late. Cross-account
  access is refused for 10 routes (evaluation, preview, report, share, revoke,
  series, import, execute, plan, publish). Unauthenticated and
  wrong-origin writes are refused.
- **Measurement.** Earlier initiatives keep their pinned metric and goal
  version after a profile change. Missing days stay missing; conflicts stay
  visible; synthetic observations are identified, and the same bytes under a
  different provenance are refused rather than relabelled. Fractional,
  negative, duplicate and out-of-range rows are refused. Currency metrics fail
  closed for both plans and imports. An action at 20:00Z lands on the next
  local day in `Asia/Makassar`.
- **Evaluation.** The words ROI, lift, attributed, "caused by" and success
  appear only inside the limitation statements. Indeterminate evaluations
  carry no improvement figures. Concurrent activity is disclosed.
- **Reports.** A new import left the published figures unchanged and made a
  stale publish refuse. A correction created a new superseding version; the old
  link still shows its frozen version with a newer-version notice. Same-key
  retries replay. Eight concurrent publications kept a linear version chain.
  The database refused update and delete of a published row; stored digest
  equals the digest of the stored text; no raw CSV is stored. Revoked links
  never work again and a new link gets a new id; share ids are unique.

## 8. Browser acceptance

Real built web app (`vite preview`) with the built API, in an automation
browser. The default profile was the operator and an incognito profile was the
client. Both journeys completed through the product UI: signup, product and
goal, proposal, approval, plan (on the fixed build), execution, CSV import
with an error case, evaluation, review, report preview, publication, share,
client page and revocation. The client page had no operator shell, 401 from
the session endpoint, and no horizontal overflow at 375 px width.

Limits of this evidence:

- The browser tool's click and type commands timed out in this environment, so
  the UI was driven with scripted DOM events on the real forms. Pixel-level
  rendering was not inspected and **no screenshots were captured**.
- Print layout was not rendered. Only the `print:hidden` control on the client
  page was confirmed.
- Automation passing is not human usability validation.

## 9. Findings and fixes

| # | Class | Finding | Status |
| --- | --- | --- | --- |
| 1 | **P1** | The measurement plan could only be declared through the API. Without it every evaluation reads "no plan", so an ordinary operator could not reach a comparable report without a developer. | **Fixed** (`90e66c3`): plan form on approved initiatives, with client-side checks and plain error messages. Regression tests in `apps/web/tests/growth-plan.test.ts`. Reproduced first in the browser (card had only Record execution / Record review / Cancel). |
| 2 | **P1** | No page linked to the measurement import console; imports were reachable only by typing its URL. | **Fixed** (`90e66c3`): "Measurement imports" link in the Growth workspace header and in the plan form. |
| 3 | P2 | A recorded execution cannot be edited or deleted, and there is no corrections route in the product. A wrong entry stays in the report. | Documented in the runbook. Not changed. |
| 4 | P2 | The product form pre-fills `Asia/Makassar` as the reporting time zone for every business. | Documented. Not changed. |
| 5 | P2 | Evaluation only reads after the observation window has ended and a plan must precede work. A real pilot therefore takes weeks. Backfilled work reads "plan declared after the action". | Documented. By design. |
| 6 | P2 | Imports are pasted text only, no file upload. | Documented. |
| 7 | P3 | "Growth workspace" on the measurement page is a plain link causing a full reload. | Not changed. |
| 8 | P3 | Revenue/currency metrics, GA4 connector, client login, report email. | Out of scope. |

No P0 findings. Every P0/P1 security and integrity check passed.

One controlled SQL fixture is used by the acceptance driver and the browser
run: a plan row with a backdated `declared_at` (and, in section 7, a
correction row), because a test cannot wait weeks for a genuine
plan-before-work sequence and the product has no corrections route. Every
other step used application routes.

## 10. Operator runbook

`docs/marketing-pilot-runbook-v1.md` covers onboarding, outcome and source,
initiative and approval, plan before work, recording work, import formats and
limits, evaluation, decision, publish and share, correction, revocation,
limits, common errors, and the distinction between test fixtures and real
evidence.

## 11. W6 PR

Branch `w6/operator-acceptance`. Files: the web fix and tests, the acceptance
driver, the runbook, the evidence JSON and this report. PR number, CI result
and merge SHA are reported in the hand-off. No production deployment was made.

## 12. Known limitations

See runbook section 11 and findings 3–8. Also: reports show figures the
operator supplied; OpenRecord does not authenticate analytics or booking
systems. Public report content is a projection that includes the initiative
title, problem statement, proposed change and target page.

## 13. Required human pilot steps

1. A real operator (not a developer) runs the runbook once on a harmless
   goal, unaided, and records every place they needed help.
2. Set `APP_BASE_URL` to the exact operator address in the pilot deployment.
3. Pick one real business, get consent to share its numbers, declare the plan
   before the work, and wait for the observation window to end.
4. Import real exports; publish; share the link with the client.
5. Record outside OpenRecord whether the client read the report, made a
   decision from it, and would continue or pay.
6. Check the print/PDF output and the report on a real phone.

## 14. Milestones

- **ENGINEERING_PASS: yes.** The integrated workflow passes the technical
  acceptance tests, migrations rehearse cleanly, and the two P1 gaps are
  fixed.
- **OPERATOR_ACCEPTANCE_PASS: not claimed.** No real human operator has
  completed the workflow unaided. Automated browser runs do not establish it.
- **CUSTOMER_VALIDATED: not claimed.** No customer has received a report.

`W6_ENGINEERING_PASS_PILOT_READY`
