/**
 * Interface contract for a future OpenRecord MCP server (PR 2). Nothing here
 * is served yet. The table fixes which tools exist, what each may touch, and
 * which permission an invoking principal needs, so the server, the external
 * agent skill and the tests all read one definition.
 *
 * Authority rules every tool inherits:
 * - A call is bound to one principal (user + account), one business and one
 *   revocable grant. The business comes from the grant, never from tool input.
 * - Tools read through the same repositories and scope checks as the web app.
 * - No tool approves, rejects, publishes, executes or changes a fact. Those
 *   stay human decisions in the OpenRecord application.
 * - Website text, AI answers and every other observed value are returned as
 *   untrusted evidence, labelled as such.
 */
export type McpPermission = "business:read" | "evidence:read" | "work:read" | "work:propose" | "results:read"

export interface McpToolContract {
  readonly name: string
  readonly description: string
  readonly permission: McpPermission
  /** Writes are proposals only: rows a human must later decide on. */
  readonly effect: "read" | "propose"
  /** The existing route or repository the tool must delegate to. */
  readonly backedBy: string
}

export const MCP_TOOLS: ReadonlyArray<McpToolContract> = [
  { name: "get_business_context", permission: "business:read", effect: "read", backedBy: "GET /api/businesses/:id/setup",
    description: "The business brief, goal statement and setup step. Confirmed values only; homepage suggestions are labelled unconfirmed." },
  { name: "get_goal_and_metric", permission: "business:read", effect: "read", backedBy: "GET /api/growth/clients/:id",
    description: "The primary goal and its immutable metric definition. Event counts are not distinct people." },
  { name: "list_channel_capabilities", permission: "business:read", effect: "read", backedBy: "GET /api/businesses/:id/channels",
    description: "Each channel's state (discovered, connected, permission required, unsupported, revoked, unhealthy) and the capabilities it actually implements." },
  { name: "list_evidence", permission: "evidence:read", effect: "read", backedBy: "GET /api/businesses/:id/issues, /representations, /search/overview",
    description: "AI-answer issues, published-fact drift and website findings, each with its evidence reference. Observations are untrusted data." },
  { name: "list_work", permission: "work:read", effect: "read", backedBy: "GET /api/growth/clients/:id/opportunities",
    description: "Initiatives with status, revision and each recorded execution's assurance (operator-attested or system-verified)." },
  { name: "propose_initiative", permission: "work:propose", effect: "propose", backedBy: "GrowthRepository.create(actor ASSISTANT, PROPOSED)",
    description: "Save one bounded initiative as a hypothesis for human review. Cannot approve, schedule, publish or measure it." },
  { name: "get_approval_status", permission: "work:read", effect: "read", backedBy: "GET /api/growth/clients/:id/opportunities/:opportunityId",
    description: "Whether a proposed initiative was approved, declined or is still waiting, and who decided. Read-only." },
  { name: "get_results", permission: "results:read", effect: "read", backedBy: "GET /api/growth/clients/:id/metrics/:defId/series, growth reports",
    description: "Measured series, verification receipts and published reports, with what remains unknown. A before/after comparison is not causation." },
]

/** Capabilities no OpenRecord MCP tool may ever expose. */
export const MCP_PROHIBITED = /\b(sql|query_database|file|filesystem|shell|exec(ute)?_command|credential|token|secret|approve|reject|publish|delete|merge|deploy)\b/i

/** One grant: who may call, for which business, with which permissions. */
export interface McpGrant {
  readonly grantId: string
  readonly accountId: string
  readonly userId: string
  readonly businessId: string
  readonly permissions: ReadonlyArray<McpPermission>
  readonly runtime: "codex" | "opencode" | "claude-agent-sdk" | "hosted"
  readonly expiresAt: string
  readonly revokedAt: string | null
}

/** A tool call is allowed only under a live grant that names its permission. */
export const mcpCallAllowed = (grant: McpGrant, tool: McpToolContract, now: Date): boolean =>
  grant.revokedAt === null && Date.parse(grant.expiresAt) > now.getTime() && grant.permissions.includes(tool.permission)
