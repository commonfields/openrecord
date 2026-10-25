import { Schema } from "effect"
import { HarnessJob, type HarnessJobResult, type HarnessReport } from "@openrecord/contracts"
import { BridgeFailure } from "./process.js"

export function serverOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use the OpenRecord origin without a path or credentials")
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("OpenRecord requires HTTPS, except on this machine")
  return url.origin
}
const PollResponse = Schema.Struct({
  job: Schema.NullOr(HarnessJob),
  active: Schema.Array(Schema.UUID),
  refresh: Schema.optional(Schema.Boolean)
})

// Both the aggregate request and each stored jsonb report need byte headroom.
// Rotate batches rather than dropping whole account instances from discovery.
export function reportBatch(reports: readonly HarnessReport[], start: number) {
  const batch: HarnessReport[] = []
  let size = 100,
    next = reports.length ? start % reports.length : 0
  for (let count = 0; count < reports.length; count++) {
    const source = reports[next]
    if (!source) break
    const models: HarnessReport["models"][number][] = []
    let reportSize = Buffer.byteLength(JSON.stringify({ ...source, models: [], modelsTruncated: false }), "utf8")
    for (const model of source.models.slice(0, 500)) {
      const bytes = Buffer.byteLength(JSON.stringify(model), "utf8") + 1
      if (reportSize + bytes > 125000) break
      models.push(model)
      reportSize += bytes
    }
    const report = {
      ...source,
      models,
      modelsTruncated: source.modelsTruncated || models.length < source.models.length
    }
    const bytes = Buffer.byteLength(JSON.stringify(report), "utf8")
    if (batch.length && size + bytes > 150000) break
    if (bytes > 150000) throw new BridgeFailure("MALFORMED")
    batch.push(report)
    size += bytes + 1
    next = (next + 1) % reports.length
  }
  return { reports: batch, next }
}
export class BridgeClient {
  readonly server: string
  private reportCursor = 0
  constructor(
    server: string,
    private token: string
  ) {
    this.server = serverOrigin(server)
  }
  async request(path: string, body: unknown, authenticated = true): Promise<unknown> {
    const response = await fetch(new URL(path, this.server), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new BridgeFailure(
        response.status === 401 ? "UNAUTHENTICATED" : response.status === 409 ? "CANCELLED" : "UNAVAILABLE"
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new BridgeFailure("MALFORMED")
    let text = "",
      size = 0
    const decoder = new TextDecoder("utf-8", { fatal: true })
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 500000) throw new BridgeFailure("MALFORMED")
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
      return JSON.parse(text)
    } finally {
      await reader.cancel()
    }
  }
  async poll(reports: readonly HarnessReport[], acceptJob = true) {
    const batch = reportBatch(reports, this.reportCursor)
    const response = Schema.decodeUnknownSync(PollResponse)(
      await this.request("/api/bridge/poll", { reports: batch.reports, acceptJob })
    )
    this.reportCursor = batch.next
    return response
  }
  async complete(id: string, result: HarnessJobResult) {
    await this.request(`/api/bridge/jobs/${id}/result`, result)
  }
}
