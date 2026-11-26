// Resolves which subscription model unattended agent work should use: the same
// rules as the desktop chat (saved pick, same model on another connection, then
// the first ready subscription). Returns undefined when only the hosted model can run.
import type { HarnessInstance, HarnessSelection } from "@openrecord/contracts"
import { Effect } from "effect"
import { harnessCatalog, resolveHarness } from "./harness-store.js"

type Session = { readonly accountId: string; readonly userId: string }

const ready = (i: HarnessInstance) =>
  i.enabled && i.installed && i.state === "ready" && i.auth !== "unauthenticated"

const modelAllowed = (i: HarnessInstance, model: string) =>
  i.models.some(m => m.id === model) && !i.disabledModels?.includes(model)

const effortOk = (i: HarnessInstance, model: string, effort?: HarnessSelection["reasoningEffort"]) =>
  !effort || ((i.driver === "codex" || i.driver === "opencode" || i.driver === "claude") &&
    i.models.find(m => m.id === model)?.reasoningEfforts?.includes(effort))

/** True when this exact pick can run today. */
export const selectionResolvable = (session: Session, selection: HarnessSelection) =>
  resolveHarness(session, selection).pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)))

const firstReadySelection = (instances: ReadonlyArray<HarnessInstance>): HarnessSelection | undefined => {
  for (const i of instances.filter(ready)) {
    const model = i.models.find(m => !i.disabledModels?.includes(m.id))?.id
    if (model) return { instanceId: i.id, model }
  }
  return undefined
}

const sameModelElsewhere = (instances: ReadonlyArray<HarnessInstance>, preferred: HarnessSelection): HarnessSelection | undefined => {
  for (const i of instances.filter(ready)) {
    if (i.id === preferred.instanceId) continue
    if (!modelAllowed(i, preferred.model)) continue
    if (!effortOk(i, preferred.model, preferred.reasoningEffort)) continue
    return { instanceId: i.id, model: preferred.model, ...(preferred.reasoningEffort ? { reasoningEffort: preferred.reasoningEffort } : {}) }
  }
  return undefined
}

/** Pick for background turns: preferred when it still works, else stand-in, else first ready subscription. */
export const resolveUnattendedSelection = (session: Session, preferred?: HarnessSelection) => Effect.gen(function*() {
  const { instances } = yield* harnessCatalog(session)
  if (preferred) {
    if (yield* selectionResolvable(session, preferred)) return preferred
    const elsewhere = sameModelElsewhere(instances, preferred)
    if (elsewhere && (yield* selectionResolvable(session, elsewhere))) return elsewhere
  }
  const fallback = firstReadySelection(instances)
  if (fallback && (yield* selectionResolvable(session, fallback))) return fallback
  return undefined
})