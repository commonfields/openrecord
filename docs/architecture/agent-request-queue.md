# Durable agent requests and standalone execution

## Scope

This change adds backend queue endpoints, fenced recovery, and standalone worker execution. Existing synchronous `.../agent/messages` routes remain compatible. Web composer polling and reload reattachment are separate, uncommitted work and are not included in this PR.

## API and ownership

- `POST /api/agent/requests` or `/api/businesses/:id/agent/requests` accepts an existing conversation, expected revision and immutable request ID; returns 202.
- `GET /api/agent/requests/:requestId` returns durable status/result.
- `GET /api/agent/requests?conversationId=...` discovers active or recent failed work.
- `POST /api/agent/requests/:requestId/cancel` cancels queued/running work.

Requests and results are account/user scoped, authenticated, origin protected and uncached. Replay of identical input reuses the request; changed content conflicts. Limits are eight queued/running requests per account, two running per account, four globally. Database claims coordinate all workers.

## Safety and recovery

Each worker runs two loops and renews 30-second job leases every ten seconds. Existing conversation leases and human approval boundaries remain enforced. Request ownership and authorization are checked during execution and in the answer commit transaction.

Before starting a turn, the worker atomically sets `execution_started_at` under its live claim. Expired claims requeue only when that marker is absent and neither a run nor a committed reply exists. The previous worker is fenced from starting. Once execution may have begun, expired work becomes INTERRUPTED and requires explicit operator action; no automatic replay of tools, publication, sending or spending occurs. Already-committed replies are recovered without rerunning the turn.

Cancellation revokes the job and conversation lease and rejects late answer commits. A reply committed first wins over cancellation. External actions already accepted by a provider cannot be rolled back.

## Deployment

Apply `0075_agent_request_queue.sql` and `0076_agent_worker_runtime.sql`. Start `pnpm --filter @openrecord/api agent:worker` with the API's database/provider configuration; set `AGENT_REQUEST_WORKER_ENABLED=false` on API replicas. The default remains true for compatibility. Both modes can coexist and share limits during rollout.

`services.ts` contains shared dependencies only. The standalone entry point starts no HTTP listener, local bridge launcher, or unrelated scheduler/queue consumer. Worker liveness and startup fingerprint are persisted in `agent_worker_instances`; authenticated `/api/dev/runtime` shows recently live workers. Deployment infrastructure must provide process supervision. Heartbeat liveness does not establish provider health.

`scripts/dev-up.sh` starts a standalone worker if no recent standalone heartbeat exists, disables API-owned loops on new API processes, and defers stale API restarts while agent work is active. It does not automatically replace live stale workers: drain before replacing them. API-owned local CLI bridges and other API schedulers are not isolated by this change.

## Validation

Eight queue integration tests cover authentication, origin/tenant boundaries, replay/conflict behavior, competing claims and caps, committed-answer recovery, ambiguous interruption, safe pre-execution recovery, duplicate fencing, lifecycle registration, and cancellation versus late commit.

On the development checkout, a read-only Gemini request was observed RUNNING, then the API received SIGTERM and restarted. A fresh authenticated client observed a different API instance, the same standalone worker, and a COMPLETED / ANSWERED result (request `7dbf0f12-369d-4670-bb92-000f092b5247`). That checkout also contains separate pending inference and frontend changes; this live result is supporting evidence, not a substitute for branch-specific tests. It does not validate worker hard-crash continuation, provider outages, or external publication.
