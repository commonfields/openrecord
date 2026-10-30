# Connected execution (W7)

OpenRecord can now carry one exact, human-authorized website change through a
provider (GitHub first), reconcile what happened, and record trustworthy
evidence of it. This document is the contract. The code and tests follow it.

## 1. Three facts, kept apart

| Fact | Meaning | Where it lives |
| --- | --- | --- |
| **Request accepted** | OpenRecord accepted the authorized operation, or GitHub accepted the pull request | `growth_execution_events`, evidence `PR_OPENED` |
| **Provider action verified** | OpenRecord confirmed from provider evidence that the exact authorized change was merged | evidence `PR_MERGE_CONFIRMED` + one `SYSTEM_VERIFIED / GROWTH_DELIVERY / PR_MERGED` intervention linked to the initiative |
| **Live change observed** | OpenRecord re-observed the intended change on the configured live page | `growth_execution_live_checks` |

A fourth thing, **business impact**, is never derived from these. Only the
measurement and evaluation system (W3/W4) speaks to it.

Consequences enforced in code and tests:

- A merge is never written as `SOURCE_PUBLISHED`. The receipt is `SOURCE_UPDATED`
  on channel `WEBSITE` and its note says it does not show a deployment.
- A live check needs a verified merge first. A page that changed for another
  reason says nothing about this authorization.
- A stopped operation is `NOT_VERIFIED`, never "not performed": OpenRecord
  cannot prove a negative at the provider.
- Provider states are never written into the initiative's human lifecycle
  (`growth_opportunity_events`). That table gained no states and no columns.

## 2. Lifecycle of one operation

Operation states (their own append-only lifecycle):
`PREPARED, AUTHORIZED, DISPATCHING, AWAITING_MERGE, RECONCILING, VERIFIED, FAILED, BLOCKED, UNKNOWN, CANCELLED`.

| Step | Who | State after | Rests on |
| --- | --- | --- | --- |
| 1. Initiative approved | operator | (initiative `APPROVED`) | W0 |
| 2. Exact change proposed | API, from the provider's page at the base commit | `PREPARED` | before/after bytes, patch hash |
| 3. Human reviews destination, content, risk | operator | | diff, repository, path, base commit |
| 4. Human authorizes the specific change | operator | `AUTHORIZED` | `approvedPatchSha256` equals the stored patch hash, expiry 24 h |
| 5. Durable execution intent | operator | `DISPATCHING` + a `DISPATCH` job | initiative still approved, authorization unexpired |
| 6. Worker claims the job | worker | | lease, `SKIP LOCKED` |
| 7. Authorized write | worker | `AWAITING_MERGE` | branch, commit and pull request read back from the provider |
| 8. Provider artifact | worker | evidence `PR_OPENED` | number, URL, head sha, repository, branches |
| 9. Reconciliation | worker | `RECONCILING` | provider reports merged |
| 10. Verified evidence linked | worker | `VERIFIED` | merge verified against the approved change, one receipt linked |
| 11. Live publication assessed | worker | live check rows | safe fetch of the registered page |
| 12. Measurement and reporting | W3/W4/W5 | | consume the receipt as a `SYSTEM_VERIFIED` action |

Who may move where is one table (`EXECUTION_TRANSITIONS` in
`packages/contracts/src/growth-execution.ts`). The migration mirrors it and a
test compares the two. Only a person authorizes, dispatches or cancels. Only
the execution system records provider facts. The assistant can propose
(`PREPARED`) and nothing else; there is no assistant route or tool for
execution.

`UNKNOWN` means a provider write may have happened and the response was lost.
`BLOCKED` means OpenRecord stopped before anything unapproved could happen and a
new approval is needed. `FAILED` means a permanent refusal or a pull request that
closed unmerged.

## 3. The exact change

Only one action exists: `REMOVE_NOINDEX_META` on one HTML page. The page must be
inside the target's allowed paths: plain relative segments, `.html`/`.htm`, no
dot-segments, no traversal. The transform is the existing deterministic
`removeNoindexFromHtml` from the Site Operator; anything it cannot do safely is
refused (`NotApplicable`), never guessed.

`patch_sha256 = sha256(plan version, action, owner/repo (lower-case), base
branch, base commit, page, live URL, before sha256, after sha256)`. Approval binds
to it. At dispatch the worker re-proves everything:

- initiative still `APPROVED`; authorization present, bound to this patch, unexpired;
- repository on the server allowlist for this account and not OpenRecord's own;
- page still inside the connected paths;
- the page at the base branch head is still the reviewed blob (`SOURCE_CHANGED`
  otherwise); the branch is cut from the **approved** base commit.

## 4. Provider adapter boundary

`GitHubTransport` (in `packages/site-operator/src/github.ts`, ported from the
preserved W2 transport) performs only: read repository, branch head, one file and
one pull request; create one branch; commit one file; open one pull request;
list a pull request's files. There is no merge, no workflow dispatch, no other
write. OpenRecord never merges and never deploys; the repository maintainer does.

Credentials come only from server configuration:

| Variable | Meaning |
| --- | --- |
| `GITHUB_EXECUTION_TOKEN` | fine-grained token limited to the chosen repositories (Contents and Pull requests: read and write) |
| `GITHUB_EXECUTION_REPOSITORIES` | `owner/repo=<account id>,...`: a repository is usable only by the account it is listed for |
| `GITHUB_EXECUTION_API_URL` | optional; `https`, or an exact loopback address for a local stand-in. An invalid value disables execution rather than sending the token elsewhere |
| `EXECUTION_RECONCILE_POLL_SECONDS` | default 120 |
| `EXECUTION_LIVE_CHECK_DELAY_SECONDS` | default 300 |

For local development, `pnpm --filter @openrecord/worker dev:execution` runs
only the connected-execution queue. Set `DATABASE_URL` and the GitHub execution
variables in its environment. The API needs the same GitHub configuration.
The worker refuses to start when the token, endpoint, or allowlist is missing
or invalid, before it claims a job. This command can process every due approved
execution job in that database; check the queue and destination configuration
before starting it. It does not process AI checks or setup jobs. The default
`scripts/dev-up.sh` does not start this worker.

Destination safety: an operator connects a repository to a registered website;
the API and the worker both require it on the allowlist; `commonfields/openrecord`
is refused in the contract, the API, the worker and the database whatever any
list says; a repository belongs to one account; foreign accounts get `404`.
The token travels only as a request header to the configured endpoint with
redirects refused. No error, log line, receipt or response carries it.

## 5. Durable orchestration

`growth_execution_jobs` holds scheduling only: `DISPATCH`, `RECONCILE`,
`LIVE_CHECK`. One open job per operation and kind (unique index). A worker claims
with `FOR UPDATE SKIP LOCKED` and a lease; an expired lease is reclaimed.

**Read before write.** Every dispatch step reads the provider first: branch
exists? file on the branch already the approved bytes? pull request for this
head already open? So a replay after any crash reaches the same branch, commit
and pull request. The head branch is deterministic per operation
(`openrecord/exec-<operation id>`).

| Crash or failure point | Outcome |
| --- | --- |
| before dispatch | job stays queued; any worker takes it |
| during a provider request / response lost | `UNKNOWN`, evidence `DISPATCH_UNCERTAIN`, reconcile finds the pull request (`AWAITING_MERGE`) or finds none and dispatches again |
| after provider success, before DB persistence | the replay finds the branch/commit/pull request and records them; no second write |
| during reconciliation | state `RECONCILING` is resumed by the next claim |
| after provider merge, before the ledger update | reconciliation verifies the merge and writes the receipt once |
| after the receipt, before the job closed | replay sees `VERIFIED` and changes nothing |

**Retries.** Rate limit: wait the provider's `Retry-After` (cap 1 h). Outage or
timeout on a read: exponential backoff 15 s to 10 min, at most 5 attempts per
dispatch, then `FAILED RETRIES_EXHAUSTED` (nothing was written). A write whose
outcome is unknown is never retried blindly: reconcile first; three unknown
cycles end in `BLOCKED RETRIES_EXHAUSTED` ("check the repository"). 401/403 is
`FAILED PROVIDER_AUTH`; 404 `FAILED PROVIDER_NOT_FOUND`; 4xx validation `FAILED
PROVIDER_REJECTED`. Polling an unmerged pull request is waiting, not retrying.

## 6. What `PR_MERGED` verifies

Before the receipt exists, reconciliation checks, from the provider's own data:

1. the pull request is the one that was opened (number and URL) and targets the
   authorized repository (`owner/repo`), base branch and the operation's head branch;
2. its head commit is the one OpenRecord opened (nothing was pushed after);
3. the provider reports it merged, with a 40-hex merge commit and a merge time;
4. it changed exactly one file, the authorized page;
5. that page at the **merge commit** has exactly the approved blob (git blob sha)
   and sha256.

Any mismatch records evidence and stops the operation
(`PR_WRONG_TARGET`, `PR_CONTENT_CHANGED`, `MERGED_CONTENT_DIFFERS`,
`PR_CLOSED_WITHOUT_MERGE`) with **no receipt**. A pull request that is created,
closed unmerged, replaced, edited or merged elsewhere never satisfies the
authorization.

The receipt is created by `verifyMerge` in one transaction: merge evidence, the
`SYSTEM_VERIFIED` intervention (type `SOURCE_UPDATED`, channel `WEBSITE`, actor
`SYSTEM`, target the pull request URL, performed at the provider's merge time,
before/after digests), the `growth_initiative_actions` link, and the `VERIFIED`
event. It does not prove deployment.

## 7. Database enforcement (migration `0034`)

`growth_execution_verified(execution interventions)` keeps its W0 signature and is
replaced only by its implementation. It is true only when the intervention
describes exactly one operation that a person authorized (patch hash match), whose
merge evidence exists, with matching target, time, digests, type, channel, actor
and claim, and no correction. There is no overload and no flag. A unique index
allows one receipt per operation.

The evidence guard refuses merge evidence that contradicts the stored operation
(blob, paths, repository, branch, head, pull request) and refuses evidence out of
stage. The event guard enforces the transition table, the authorization binding
and expiry, and that `VERIFIED` has exactly one linked receipt. Operations, events,
evidence and live checks are append-only (update, delete, truncate refused).

The database cannot know the provider's truth. It guarantees that nothing can
claim verification that is not consistent with an authorization and stored
provider evidence; the worker holding the credential establishes that evidence.
A caller with direct database write access could insert false evidence. That is
the same trust boundary as every other adapter in the system.

**Replay.** The runner re-executes every migration file in order. `0030` recreates
the W0 placeholder `growth_execution_verified` (`SELECT false`) and the W0
`guard_growth_event`; `0034` runs after and replaces both. The rehearsal
(`scripts/verify-marketing-w7-migrations.py`) asserts, after full replay, that the
function still checks merge evidence and the initiative guard still contains the
unresolved-execution refusal. `0034` refuses to install over the old W2 `0031`
artifacts (`delivery_id` column or the old delivery tables) before creating
anything; the whole file is one implicit transaction.

## 8. Governance and races

| Case | Resolution |
| --- | --- |
| Approve while the source changes | authorization binds the patch hash; the worker re-reads the page and stops with `SOURCE_CHANGED` |
| Cancel/review the initiative while a job is queued | `AUTHORIZED` only: allowed; dispatch then refused (`InitiativeNotApproved`) and the worker would block |
| Review/cancel while delivery is in progress | refused with `ExecutionUnresolved` in the API **and** the database, for `DISPATCHING`, `AWAITING_MERGE`, `RECONCILING`, `UNKNOWN`. The initiative row is locked first, so a concurrent dispatch and decision serialize; exactly one wins |
| Pull request merges while reconciliation is pending | the merge is verified and recorded; truth wins over any pending decision |
| Review of a completed or cancelled initiative | W0 transition rules, unchanged |
| Two workers claim one operation | `SKIP LOCKED`; one claim; one set of provider writes |
| Correction supersedes a linked execution | W4/W5 chain-root association, unchanged; the receipt itself cannot be superseded into a "verified" row |
| Reconciliation after a report was published | the snapshot is immutable; a later report is a new version |

## 9. Live website observation

A `LIVE_CHECK` job fetches the operation's live URL through the shared
SSRF-safe `safeFetch` (DNS pinning, forbidden networks, redirects revalidated and
kept inside the registered site, byte and time limits, HTML only) and classifies
it with the existing inspector. Results: `CHANGE_OBSERVED` (no noindex in meta or
header), `CHANGE_NOT_OBSERVED` (noindex still present), `INCONCLUSIVE`
(unreachable, blocked, redirected out of scope, non-200). `PENDING` until the
first check. A check never changes the operation state.

## 10. Operator UI and agent boundary

The Growth card of an approved initiative has a "Connected change" section: connect
a repository, prepare the exact change, review the diff, repository, page, risk and
boundary, approve that exact change, open the pull request, follow progress, check
GitHub now, check the website now. It always shows three lines (request, repository
merge, live website) and never "marketing work completed". The Operator Agent keeps
its read/propose tools; it has no execution, merge, approval, credential or publish
tool (a test asserts the tool names).

## 11. W2 reuse

Reused from the preserved W2 branch (`ee80b91`, left untouched): the GitHub REST
transport, blob-sha comparison, one-branch/one-commit/one-pull-request flow,
repository allowlist parsing, the fixture provider pattern and the line diff.
Not carried over: its migration `0031`, the `IN_DELIVERY`/`DELIVERED` initiative
states, `growth_opportunity_events.delivery_id`, `VERIFIED_ACTION` evidence,
operator-attested deployment, and Markdown-only paths.

## 12. Evidence

| Claim | Test |
| --- | --- |
| lifecycle, guards, forged receipts, tenancy, claims, replay | `packages/db/src/growth-execution.integration.test.ts` |
| write-once, ambiguity, recovery, merge verification, live observation | `apps/worker/src/execution.integration.test.ts` |
| authorization, destination safety, exact change, idempotency over HTTP | `apps/api/src/growth-execution.integration.test.ts` |
| contracts, transport, credential hygiene | `packages/contracts/src/growth-execution.test.ts`, `packages/site-operator/test/github.test.ts` |
| plain-language claims | `apps/web/tests/growth-execution.test.ts` |
| fresh, replay, populated, incompatible databases | `scripts/verify-marketing-w7-migrations.py` |
| built API and worker over real HTTP | `scripts/connected-execution-runtime-smoke.py` (CI) |

All provider behavior in these tests is modeled: `MOCK_ADAPTER_PASS`. None of it
is `LIVE_PROVIDER_PASS` or `LIVE_SITE_PASS`.

## 13. Not in W7

Webhooks (polling is the authority, and a webhook could only trigger the same
reconcile), auto-merge, deployment, any action other than noindex removal, other
providers, the Operator Agent executing, generic external-agent or MCP execution
(W9), authenticated measurement connectors (W8).

## 14. A second destination

A CMS, listing or email platform would reuse the neutral parts: the operation
lifecycle and its guards, the authorization binding (a patch/payload identity
hash), the job table, the receipt contract (a verified claim bound to the
operation), the three facts, and the initiative hold. It would supply its own
exact-change builder, transport, reconcile checks and a claim name other than
`PR_MERGED`, which would need its own database verification clause. The GitHub
specifics (`owner`, `repository`, branch, blob sha, pull request) are columns and
evidence details of this adapter and are named as such; no generic connector
interface is introduced until a second adapter shows its real shape.
