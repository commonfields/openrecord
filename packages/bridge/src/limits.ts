// Usage limits the bridge has seen. Codex reports its limit when probed;
// Claude Code and the ACP agents only say so when a run is refused. A refused
// run marks the provider "usage limited" until a run succeeds or HOLD_MS pass,
// so the next 30-second probe does not report it ready again in between.
import type { HarnessReport } from "@openrecord/contracts"

export const HOLD_MS = 30 * 60_000

export class UsageLimits {
  private until = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}
  /** A run on this provider was refused for a usage limit. */
  hit(localId: string) { this.until.set(localId, this.now() + HOLD_MS) }
  /** A run on this provider succeeded: the limit has lifted. */
  clear(localId: string) { this.until.delete(localId) }
  /** Probe results with remembered limits applied; a provider's own report wins. */
  apply(reports: ReadonlyArray<HarnessReport>): HarnessReport[] {
    const now = this.now()
    return reports.map(r => {
      const until = this.until.get(r.localId)
      if (until === undefined) return r
      if (until <= now) { this.until.delete(r.localId); return r }
      return r.state === "ready" ? { ...r, state: "usage_limited" } : r
    })
  }
}
