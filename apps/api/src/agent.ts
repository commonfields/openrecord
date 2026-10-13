// Agent assistance V1: deterministic, read-only answers over real tool calls.
//
// No LLM, no autonomous writes. The message is untrusted operator input;
// the reply cites only rows the server read under the session account.
// Anything that would write (run check, discovery run, intervention,
// recheck, packet export bytes) is returned as a plan with a UI deep link
// the human clicks. Publishing stays manual by design.
//
// All reads go through the agent tool harness (agent-tools.ts): schema-
// declared, tenant-scoped tools. The keyword routing below only decides
// which tools to invoke and how to present their cited rows.
import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import {
  BusinessRepository,
  DiscoveryScopeRepository,
  FactRepository,
  ProductReadRepository,
  QuestionRepository,
  RecordRepository,
} from "@openrecord/db"
import { runAgentTool } from "./agent-tools.js"
import { AgentProposalRepository } from "@openrecord/db"

export interface AgentToolCall {
  readonly tool: string
  readonly summary: string
}

export interface AgentCitation {
  readonly kind: string
  readonly id: string
  readonly text: string
}

export interface AgentReply {
  readonly reply: string
  readonly toolCalls: ReadonlyArray<AgentToolCall>
  readonly citations: ReadonlyArray<AgentCitation>
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const has = (message: string, ...words: Array<string>): boolean => {
  const lower = message.toLowerCase()
  return words.some((w) => lower.includes(w))
}

const take = <T>(rows: ReadonlyArray<T>, n: number): Array<T> => rows.slice(0, n)

interface TruthData {
  readonly totalActive: number
  readonly facts: ReadonlyArray<{ readonly id: string; readonly predicate: string; readonly valueText: string; readonly version: number }>
}
interface QuestionsData {
  readonly total: number
  readonly questions: ReadonlyArray<{ readonly id: string; readonly prompt: string; readonly label: string | null }>
}
interface IssuesData {
  readonly totalOpen: number
  readonly issues: ReadonlyArray<{ readonly claim_id: string; readonly claim_text: string; readonly state: string; readonly observation_id: string }>
}
interface RepresentationsData {
  readonly total: number
  readonly drift: number
  readonly unknown: number
  readonly representations: ReadonlyArray<{
    readonly binding_id: string
    readonly predicate: string
    readonly state: string
    readonly control: string
    readonly url: string
  }>
}
interface ScopesData {
  readonly total: number
  readonly scopes: ReadonlyArray<{ readonly id: string; readonly rootUrl: string }>
}

const notFound = {
  reply: "That business was not found in your account, so I cannot read its evidence.",
  toolCalls: [],
  citations: [],
} satisfies AgentReply

export const handleAgentMessage = (
  accountId: string,
  userId: string,
  businessId: string,
  message: string,
): Effect.Effect<
  AgentReply,
  unknown,
  BusinessRepository | DiscoveryScopeRepository | FactRepository | ProductReadRepository | QuestionRepository | RecordRepository | SqlClient.SqlClient | AgentProposalRepository
> =>
  Effect.gen(function*() {
    const biz = yield* BusinessRepository
    if (!(yield* biz.getScoped(accountId, businessId))) {
      return notFound
    }

    const clean = message.trim().slice(0, 4000)
    const ids = Array.from(new Set((clean.match(UUID_RE) ?? []).map((s) => s.toLowerCase())))
    const toolCalls: Array<AgentToolCall> = []
    const citations: Array<AgentCitation> = []
    const lines: Array<string> = []

    const reads = yield* Effect.gen(function*() {
      const truth = yield* runAgentTool(accountId, businessId, "read_business_truth", {})
      // Full windows for internal lookups (named-question matching below);
      // user-facing branches still present the top 5.
      const questions = yield* runAgentTool(accountId, businessId, "discover_buyer_questions", { limit: 20 })
      const issues = yield* runAgentTool(accountId, businessId, "read_open_issues", { limit: 20 })
      const representations = yield* runAgentTool(accountId, businessId, "read_representations", {})
      const scopes = yield* runAgentTool(accountId, businessId, "read_discovery_scopes", {})
      return { truth, questions, issues, representations, scopes }
    }).pipe(
      Effect.catchAll((e) =>
        (e as { readonly _tag?: string })._tag === "AgentNotInScope" ? Effect.succeed(null) : Effect.succeed("FAILED" as const),
      ),
    )
    if (reads === null) return notFound
    if (reads === "FAILED") {
      return {
        reply: "I could not read this business's evidence right now. Try again, or continue in the workspace pages.",
        toolCalls: [],
        citations: [],
      } satisfies AgentReply
    }

    const invoked = [
      ["read_business_truth", reads.truth],
      ["discover_buyer_questions", reads.questions],
      ["audit_page_answerability", reads.representations],
    ] as const
    // Summaries go out with every reply; row citations are attached by the
    // branch that presents them, exactly as before.
    for (const [tool, result] of invoked) {
      toolCalls.push({ tool, summary: result.summary })
    }

    const truth = reads.truth.data as TruthData
    const questionData = reads.questions.data as QuestionsData
    const issuesData = reads.issues.data as IssuesData
    const representationsData = reads.representations.data as RepresentationsData
    const scopesData = reads.scopes.data as ScopesData
    const activeFacts = truth.facts
    const questionRows = questionData.questions
    const openIssues = issuesData.issues
    const representations = representationsData.representations
    const scopes = scopesData.scopes

    // GSC / broad-SEO boundary: CLI-only, never hosted. Say so plainly.
    if (has(clean, "search console", "gsc", "keyword", "competitor", "backlink", "crawl the web", "google seo", "semrush", "ahrefs")) {
      return {
        reply: [
          "Search Console evidence and broad SEO tooling live in the local Rust CLI, not in this hosted workspace.",
          "Import a Search Console CSV with: openrecord observations import-gsc --file Queries.csv --date YYYY-MM-DD.",
          "Competitor monitoring, keyword discovery, and content generation are CLI capabilities; the hosted Agent cannot run them. What it can do is trace an AI misrepresentation to your approved facts and tracked sources below.",
        ].join(" "),
        toolCalls: [{ tool: "import_search_console_evidence", summary: "boundary answered: CLI-only, no hosted write" }],
        citations: [],
      } satisfies AgentReply
    }

    if (has(clean, "truth", "fact", "approve", "correct value", "pricing", "price")) {
      const top = take(activeFacts, 5)
      lines.push(`Approved truth: ${truth.totalActive} active facts.`)
      for (const f of top) {
        lines.push(`- ${f.predicate}: ${f.valueText} (v${f.version})`)
        citations.push({ kind: "fact", id: f.id, text: `${f.predicate}: ${f.valueText}` })
      }
      if (truth.totalActive > top.length) lines.push(`…and ${truth.totalActive - top.length} more on the Truth page.`)
    }

    if (has(clean, "question", "ask", "buyer", "prompt")) {
      const top = take(questionRows, 5)
      lines.push(`Buyer questions: ${questionData.total} tracked.`)
      for (const q of top) {
        lines.push(`- ${q.label ?? q.prompt.slice(0, 80)}`)
        citations.push({ kind: "question", id: q.id, text: q.prompt })
      }
      if (questionData.total === 0) lines.push("Add the first question on the Checks page, then run a check to collect evidence.")
    }

    if (has(clean, "issue", "wrong", "incorrect", "outdated", "misrepresent", "contradict", "partial", "inbox")) {
      lines.push(`Open issues: ${issuesData.totalOpen}.`)
      for (const issue of take(openIssues, 5)) {
        lines.push(`- [${issue.state}] ${issue.claim_text.slice(0, 120)}`)
        if (issue.claim_id) citations.push({ kind: "issue", id: issue.claim_id, text: issue.claim_text.slice(0, 140) })
      }
      if (issuesData.totalOpen === 0) lines.push("No open issues. Run a check, transcribe the claim, and ask a reviewer to judge it.")
    }

    if (has(clean, "source", "representation", "track", "drift", "sync", "verify", "citation")) {
      lines.push(`Tracked sources: ${representationsData.total} (${representationsData.drift} drift, ${representationsData.unknown} unknown).`)
      for (const r of take(representations, 5)) {
        lines.push(`- ${r.predicate}: ${r.state} — ${r.control} ${r.url.slice(0, 60)}`)
        citations.push({ kind: "representation", id: r.binding_id, text: `${r.predicate} ${r.state}` })
      }
      toolCalls.push({ tool: "explain_representation_issue", summary: "representation findings summarized with citations" })
    }

    if (has(clean, "discover", "crawl", "site", "owned", "sitemap", "robots")) {
      lines.push(`Owned-site discovery: ${scopesData.total} scopes.`)
      for (const s of take(scopes, 5)) {
        lines.push(`- ${s.rootUrl}`)
        citations.push({ kind: "discovery_scope", id: s.id, text: s.rootUrl })
      }
      lines.push("Discovery runs are append-only evidence collection. Start one from Representations → Discovery.")
      toolCalls.push({ tool: "crawl_owned_site", summary: "discovery scopes listed; run requires human click" })
    }

    if (has(clean, "fix", "correct", "recommend", "draft", "change", "update the site")) {
      const target = openIssues[0]
      if (target) {
        lines.push(`Draft fix (not applied): reword the controlled source behind “${target.claim_text.slice(0, 100)}” to match approved truth, then record the action by hand on the issue page. Publishing stays manual.`)
        toolCalls.push({ tool: "draft_evidence_linked_fix", summary: "draft only; no source changed" })
      } else {
        lines.push("Draft fix: nothing to draft — there are no open issues. Collect a check first.")
      }
    }

    if (has(clean, "record", "intervention", "action taken", "we fixed")) {
      lines.push("Recorded actions are append-only and human-attested. Open the issue, use “Record action”, pick the type and target URL. I do not record actions on your behalf.")
      toolCalls.push({ tool: "record_intervention", summary: "plan returned; human records in UI" })
    }

    if (has(clean, "recheck", "re-observe", "reobserve", "verify source and", "before/after", "before after", "compare")) {
      // Current record outcomes, when a record exists. A failed read is
      // skipped silently rather than breaking the reply.
      const outcomes = yield* runAgentTool(accountId, businessId, "read_record_outcomes", {}).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (outcomes !== null) {
        toolCalls.push({ tool: "read_record_outcomes", summary: outcomes.summary })
        const record = outcomes.data as {
          hasRecord: boolean
          slots?: ReadonlyArray<{ slot: number; comparison: { state: string; outcome?: string; reason?: string | null; text?: string } | null }>
        }
        if (!record.hasRecord) {
          lines.push("Record outcomes: this business has no client record yet.")
        } else {
          lines.push("Record outcomes:")
          for (const s of record.slots ?? []) {
            lines.push(
              s.comparison === null
                ? `- Slot ${s.slot}: no comparison yet.`
                : s.comparison.state === "DERIVED"
                  ? `- Slot ${s.slot}: ${s.comparison.text ?? s.comparison.outcome}`
                  : `- Slot ${s.slot}: ${s.comparison.state === "AWAITING_REVIEW" ? "awaiting review." : "re-check in progress."}`,
            )
          }
        }
      }
      // A named question turns the plan into a real proposal: the assistant
      // drafts, the human approves, and approval runs as the approver.
      const named = ids
        .map((id) => questionData.questions.find((q) => q.id.toLowerCase() === id))
        .find((q) => q !== undefined)
      if (named) {
        const proposals = yield* AgentProposalRepository
        const proposal = yield* proposals.propose({
          accountId,
          businessId,
          kind: "REQUEST_CHECK",
          questionId: named.id,
          message: clean,
          proposer: "assistant-v1",
          proposedByUserId: userId,
        })
        lines.push(`Proposed re-check of “${named.label ?? named.prompt.slice(0, 80)}” (proposal ${proposal.id.slice(0, 8)}…). Approve it to enqueue the check — approval runs as you, not as the assistant.`)
        citations.push({ kind: "question", id: named.id, text: named.prompt })
        toolCalls.push({ tool: "propose_check_run", summary: `proposal ${proposal.id.slice(0, 8)} pending approval` })
      } else {
        lines.push("Verification is two human clicks on the issue page: “Verify source” re-fetches the tracked representation, “Recheck AI” collects a fresh answer. The before/after view below compares them and always leaves causal attribution unknown.")
        toolCalls.push({ tool: "verify_source_and_reobserve", summary: "plan returned; human clicks Verify + Recheck" })
      }
    }

    if (has(clean, "packet", "export", "download", "report", "evidence pack")) {
      if (ids.length > 0) {
        lines.push(`Evidence packet: open the issue ${ids[0]} and use “Download packet (JSON)”. The digest verifies the bytes.`)
      } else {
        lines.push("Evidence packet: open any issue and use “Download packet (JSON)”. The digest verifies the bytes.")
      }
      toolCalls.push({ tool: "export_evidence_report", summary: "packet download pointed at issue UI" })
    }

    if (has(clean, "check", "run", "observe", "9router", "model", "live")) {
      lines.push("AI checks are append-only evidence. On the Checks page pick Mock (tests) or 9Router with a configured model, run a buyer question, and review the answer. Failed PROVIDER_UNSUPPORTED runs mean no model was configured.")
      toolCalls.push({ tool: "run_ai_answer_checks", summary: "guidance returned; run requires human click" })
    }

    if (lines.length === 0) {
      lines.push(
        `Overview for this business: ${truth.totalActive} active facts, ${questionData.total} buyer questions, ${issuesData.totalOpen} open issues, ${representationsData.total} tracked representations, ${scopesData.total} discovery scopes.`,
      )
      lines.push("Ask me to explain an issue, summarize truth, list buyer questions, review tracked sources, or draft an evidence-linked fix. I read evidence and cite it; I never publish or change verdicts.")
      for (const issue of take(openIssues, 3)) {
        if (issue.claim_id) citations.push({ kind: "issue", id: issue.claim_id, text: issue.claim_text.slice(0, 140) })
      }
    }

    return { reply: lines.join("\n"), toolCalls, citations } satisfies AgentReply
  })
