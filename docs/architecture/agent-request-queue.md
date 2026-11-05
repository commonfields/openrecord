# Durable chat request queue

The web composer now submits a request with `POST .../agent/requests` and receives 202. It reads status/result separately by request ID; the old synchronous `.../agent/messages` routes remain for compatibility.

## Ownership and concurrency

- Jobs belong to one account, user, business (or general chat), conversation and immutable request payload.
- Submission validates ownership, membership, the expected conversation revision and absence of another active turn. A repeated request ID with the same content reuses the job; different content conflicts.
- At most eight queued/running requests per account, two running per account and four running globally. Each worker process runs two loops, with database claims coordinating replicas.
- Worker authorization and claim identity are checked during tools/inference and in the answer commit transaction. Existing human approval requirements are unchanged.
- A worker renews its 30-second job lease every ten seconds. The conversation retains its independent turn lease. Queued jobs expire after 30 minutes.

## Disconnects and restart

Closing the page stops neither the database job nor its worker. Reload attaches by conversation/request ID without submitting the prompt again. Transient status-read failures reconnect for up to 30 seconds; detaching polling does not cancel work.

Queued work survives restart. A worker atomically writes `execution_started_at` under its live claim before starting a conversation turn. An expired RUNNING claim can requeue only if that marker is absent and no run or committed reply exists. This fences the old worker. Once execution may have started, an expired request becomes INTERRUPTED; external actions are not replayed automatically. If its answer already committed before the process stopped, reconciliation recovers that exact reply instead. Prior finding checkpoints support explicit continuation.

## Standalone deployment

Apply migration `0076_agent_worker_runtime.sql`, start `pnpm --filter @openrecord/api agent:worker` with the same database/provider configuration as the API, and set `AGENT_REQUEST_WORKER_ENABLED=false` on API replicas. The standalone entry point imports shared services, not the HTTP server, bridge launcher or unrelated queue consumers. The existing in-API mode remains enabled by default for compatibility; both modes can coexist during an idle rollout and share concurrency limits.

`scripts/dev-up.sh` starts a standalone worker and disables API-owned loops on newly launched APIs. It defers stale-API restarts while agent work is active. An already-running API needs an idle restart to change mode. Worker startup/heartbeat/stopped state and source fingerprint are stored in `agent_worker_instances`; authenticated `/api/dev/runtime` lists recently live instances. Heartbeats are liveness signals, not proof a provider is healthy. The launcher does not automatically replace a live stale worker; drain it before restarting it.

Hosted inference can continue across API restarts in standalone mode. API-owned local CLI bridges and other API-owned schedulers are not isolated by this change. Arbitrary in-flight model/tool instructions still cannot be resumed after a worker crash. Process supervision/restart must be supplied by the deployment environment.

## Cancellation

The Stop control cancels the durable request, including work still queued. Running cancellation also revokes its conversation lease and stops existing helper tasks. The job guard prevents a late answer from committing. If the answer committed first, cancellation reports that it did not cancel completed work. Cancellation cannot roll back an external action already accepted by a provider.

## Storage and validation

Migration `0075_agent_request_queue.sql` adds queue storage; jobs cascade with conversations. Payloads contain the submitted message, optional files and model selection, not provider credentials. Results remain account/user scoped and uncached.

`agent-request-queue.integration.test.ts` covers authenticated submission, origin/tenant protections, replay/conflict behavior, competing claims, durable results, ambiguous crash interruption, committed-reply recovery and cancellation versus late commit. `agent-request-client.test.ts` checks submit-once polling, transient reconnection, terminal failure and detach behavior. Live queued inference must be checked separately after rollout.

Live validation on 2026-11-04 through port 3000: a read-only campaign-status request returned 202 in 54 ms; the submit client was discarded, a fresh authenticated connection retrieved the same job, and it completed with ANSWERED and two read-only tool calls. This verifies queued execution and result reattachment, not real process-crash recovery or external publishing.

Standalone rollout validation later on 2026-11-04: migration 0076 applied; API-owned request loops disabled; a single standalone worker registered. Read-only request `7dbf0f12-369d-4670-bb92-000f092b5247` was observed RUNNING with its execution marker set, then the API received SIGTERM. After a fresh API startup, a newly authenticated client saw a different API instance and the unchanged worker instance, and retrieved COMPLETED / ANSWERED from Gemini (run `baf8c715-9fea-4882-b9f4-7d40d91fe3ba`). This verifies real API-process restart during hosted inference, not a worker hard crash, provider outage, or external publication.
