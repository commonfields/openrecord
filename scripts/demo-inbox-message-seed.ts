// Sample data for the inbox message layout: a chat whose agent reply proposed
// an open inbox item, written with a generated view (```ui) and a diagram
// (```mermaid), so the desktop Inbox shows the sender, the chat it came from
// and the message as it read in the chat.
//
// It adds one chat to the demo login's business that already has a PROPOSED
// growth initiative (the OpenRecord demo business after
// demo-openrecord-seed.ts) and points its reply at that initiative. The chat is
// kept in history, so the business's current chat stays as it is. Sample data
// only; run again and it replaces its own chat.
//
// Run: DATABASE_URL=... pnpm --filter @openrecord/worker exec tsx ../../scripts/demo-inbox-message-seed.ts
import pg from "pg"

const DEMO_EMAIL = "demo@northstar.test"
const TITLE = "Why the site audit read no pages"

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const view = {
  title: "What the audit could reach",
  root: "r",
  elements: [
    { id: "r", type: "column", gap: "md", children: ["m", "t"] },
    { id: "m", type: "row", children: ["m1", "m2", "m3"] },
    { id: "m1", type: "metric", label: "Pages read", value: 0, trend: "down", hint: "Audit on 15 November" },
    { id: "m2", type: "metric", label: "Priority pages", value: 5, trend: "flat" },
    { id: "m3", type: "metric", label: "Trial sign-ups", value: 96, trend: "up", hint: "Last 7 days" },
    { id: "t", type: "table", columns: ["Page", "Audit", "Known from elsewhere"], rows: [
      ["Homepage", "Not reached", "Live, 200 in the browser"],
      ["Pricing", "Not reached", "Quoted by 3 of 4 assistants"],
      ["Setup guide", "Not reached", "Linked from the homepage"],
      ["robots.txt", "No answer", "Unknown"],
    ] },
  ],
}

const text = [
  "The audit on 15 November asked for robots.txt first and got **no answer**, so it stopped before reading any page. That is an access failure, not a confirmed problem with the site.",
  "",
  "```ui",
  JSON.stringify(view),
  "```",
  "",
  "Where it stopped, and what a fresh audit would check once robots.txt answers:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Audit starts] --> B{robots.txt answers?}",
  "  B -- no --> C[Stops, no pages read]",
  "  B -- yes --> D[Reads priority pages]",
  "  D --> E[Titles and search settings]",
  "  D --> F[Structured data]",
  "  E --> G[Findings for you to approve]",
  "  F --> G",
  "```",
  "",
  "I saved this to your inbox. If you approve, I'll find out why robots.txt didn't answer and prepare the smallest fix only if a real fault turns up.",
].join("\n")

async function main() {
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try {
    const user = await db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [DEMO_EMAIL])
    const userId = user.rows[0]?.id
    if (!userId) throw new Error(`No ${DEMO_EMAIL} login. Run the demo seed first.`)
    // The newest initiative still waiting on the demo login, with its business and account.
    const open = await db.query<{ id: string; business_id: string; account_id: string; title: string }>(
      `SELECT o.id, o.business_id, b.account_id, o.title FROM growth_opportunities o
         JOIN businesses b ON b.id=o.business_id
         JOIN users u ON u.id=$1
        WHERE (SELECT e.status FROM growth_opportunity_events e WHERE e.opportunity_id=o.id ORDER BY e.created_at DESC LIMIT 1)='PROPOSED'
          AND EXISTS (SELECT 1 FROM agent_conversations c WHERE c.user_id=u.id AND c.account_id=b.account_id)
        ORDER BY o.created_at DESC LIMIT 1`, [userId])
    const item = open.rows[0]
    if (!item) throw new Error("No proposed initiative is waiting on the demo login.")
    const messages = [
      { role: "user", text: "Why did the site audit read no pages?" },
      {
        role: "agent", text,
        activity: [
          { kind: "thought", text: "Start from the last audit's log, then what else shows the pages are live.", ms: 3800 },
          { kind: "tool", tool: "read_site_inspection", text: "Audit on 15 November: robots.txt did not answer" },
          { kind: "tool", tool: "read_results", text: "Trial sign-ups: 96 in the last 7 days" },
          { kind: "tool", tool: "propose_growth_opportunity", text: "Saved an idea to approve" },
        ],
        durationMs: 21_000,
        decisions: [{ type: "GROWTH_OPPORTUNITY", id: item.id }],
        inference: { provider: "anthropic", requestedModel: "claude-sonnet-5-5", usage: [] },
      },
    ]
    await db.query("BEGIN")
    await db.query("DELETE FROM agent_conversations WHERE user_id=$1 AND business_id=$2 AND last_reply->>'title'=$3", [userId, item.business_id, TITLE])
    const chat = await db.query<{ id: string }>(
      `INSERT INTO agent_conversations (account_id, business_id, user_id, messages, revision, last_reply, created_at, updated_at, expires_at, archived_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb, now() - interval '20 minutes', now() - interval '20 minutes', now() + interval '30 days', now() - interval '20 minutes')
       RETURNING id`,
      [item.account_id, item.business_id, userId, JSON.stringify(messages), messages.length, JSON.stringify({ title: TITLE })])
    await db.query("COMMIT")
    console.log(`Chat ${chat.rows[0]?.id} now sent "${item.title}" to the inbox.`)
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    await db.end()
  }
}

main().then(() => process.exit(0), e => {
  console.error(e)
  process.exit(1)
})
