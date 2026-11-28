// What a turn cut short by a restart is told when it continues: the original
// request, that saved work stays saved, and to check before repeating anything
// that may have half run. Shared by chat requests (agent-request-queue.ts) and
// background agent work (agent-work-queue.ts), which continue the same way.
import { Context } from "effect"

/** How many times one request may be continued after restarts, so a turn that keeps crashing stops. */
export const MAX_CONTINUATIONS = 3
const ORIGINAL_CHARS = 3200
/** What a continued turn is told. Saved work survives a restart; what may have half-run must be checked, not repeated. */
export const continuationMessage = (original: string) => `OpenRecord notice: your last turn on this request was cut short when OpenRecord restarted. The request was:
«${original.slice(0, ORIGINAL_CHARS)}»
Anything that turn saved is listed above and stays saved. Finish the request now. Before you save, prepare or propose anything, check whether it already exists (read_proposals, list_artifacts or the matching read) and never repeat what completed. Mention the restart in one short line at most.`

/** Present while a background job runs again after a restart cut its turn short; sendUnattendedTurn then words the turn as a continuation. */
export class TurnContinuation extends Context.Tag("TurnContinuation")<TurnContinuation, { readonly continuations: number }>() {}
