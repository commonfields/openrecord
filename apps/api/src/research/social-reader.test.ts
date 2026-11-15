// Reading what people wrote on Reddit and a YouTube video's public page, from
// hand-written answers. No real service is called.
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { findCapabilities, capability } from "./catalog.js"
import { ENDPOINTS } from "./endpoints/run.js"
import { brandMentions } from "./mentions.js"
import type { ResearchNetService } from "./net.js"
import { parseYoutubeVideo, youtubeVideoId } from "./social.js"

const endpoint = (id: string) => ENDPOINTS.find(e => e.id === id)!
const post = (d: Record<string, unknown>) => ({ kind: "t3", data: d })
const comment = (body: string, score: number, replies: unknown[] = []) => ({ kind: "t1", data: { body, score, author: "someone_private", created_utc: 1_762_000_000, replies: replies.length ? { data: { children: replies } } : "" } })

describe("which brands people's words name", () => {
  it("matches whole names in any case, never inside another word", () => {
    const m = brandMentions([{ text: "We moved from Acme to Zenith last year" }, { text: "acme.io is fine" }, { text: "Acmeworks is unrelated" }], "OpenRecord", ["Acme", "Zenith"])!
    expect(m.counts).toEqual({ OpenRecord: 0, Acme: 2, Zenith: 1 })
    expect(m.tagged.map(t => t.named)).toEqual([["Acme", "Zenith"], ["Acme"], []])
  })

  it("counts the places that name others but not the business: the gaps to close", () => {
    const m = brandMentions([{ text: "Try Acme" }, { text: "Acme or OpenRecord, both work" }, { text: "No tools named here" }], "OpenRecord", ["Acme"])!
    expect(m.othersNotUs).toBe(1)
  })

  it("is absent when no brand is given, and treats names as text, not patterns", () => {
    expect(brandMentions([{ text: "anything" }], undefined, undefined)).toBeNull()
    expect(brandMentions([{ text: "We use C++ daily" }, { text: "C is old" }], undefined, ["C++"])!.counts).toEqual({ "C++": 1 })
  })
})

describe("a Reddit thread and Reddit search (official API answers)", () => {
  it("reads a thread's post and top comments, with brand counts, keeping no usernames", () => {
    const e = endpoint("community.reddit.thread")
    const input = { url: "https://www.reddit.com/r/marketing/comments/abc123/best_ai_visibility_tool/", own: "OpenRecord", brands: ["Acme", "Zenith"] }
    expect(e.request(input, new Date()).url).toBe("https://oauth.reddit.com/comments/abc123")
    const answer = [
      { data: { children: [post({ id: "abc123", title: "Best AI visibility tool?", subreddit: "marketing", score: 120, num_comments: 3, created_utc: 1_761_900_000, permalink: "/r/marketing/comments/abc123/x/", selftext: "Looking at Acme", author: "op_private" })] } },
      { data: { children: [comment("Zenith worked for us", 40, [comment("OpenRecord too", 12)]), comment("Acme is pricey", 25)] } },
    ]
    const parsed = e.parse(answer, input) as { status: string; findings: Record<string, any> }
    expect(parsed.status).toBe("OBSERVED")
    expect(parsed.findings["post"]).toMatchObject({ title: "Best AI visibility tool?", subreddit: "marketing", names: ["Acme"] })
    expect(parsed.findings["topComments"].map((c: { text: string }) => c.text)).toEqual(["Zenith worked for us", "Acme is pricey", "OpenRecord too"])
    expect(parsed.findings["brandMentions"]).toEqual({ OpenRecord: 1, Acme: 2, Zenith: 1 })
    expect(parsed.findings["itemsNamingOthersNotUs"]).toBe(3)
    expect(JSON.stringify(parsed)).not.toMatch(/_private/)
  })

  it("searches within one community when asked, and counts brands in each post", () => {
    const e = endpoint("community.reddit.search")
    const input = { query: "ai visibility", subreddit: "SEO", own: "OpenRecord", brands: ["Acme"] }
    const req = e.request(input, new Date())
    expect(req.url).toBe("https://oauth.reddit.com/r/SEO/search")
    expect(req.query).toMatchObject({ restrict_sr: 1, q: "ai visibility" })
    const parsed = e.parse({ data: { children: [post({ title: "Acme vs OpenRecord", subreddit: "SEO", score: 5, num_comments: 2, created_utc: 1_761_900_000, permalink: "/r/SEO/1", selftext: "" }),
      post({ title: "Acme review", subreddit: "SEO", score: 1, num_comments: 0, created_utc: 1_761_900_000, permalink: "/r/SEO/2", selftext: "it is fine" })] } }, input) as { findings: Record<string, any> }
    expect(parsed.findings["brandMentions"]).toEqual({ OpenRecord: 1, Acme: 2 })
    expect(parsed.findings["postsNamingOthersNotUs"]).toBe(1)
    expect(parsed.findings["posts"][0]).not.toHaveProperty("text")
  })
})

describe("a YouTube video's public page", () => {
  const page = (details: Record<string, unknown>, micro: Record<string, unknown> = {}) =>
    `<html><script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: details, microformat: { playerMicroformatRenderer: micro } })};var meta = 1;</script></html>`
  const details = { title: "Acme vs Zenith: honest review", author: "Tool Reviews", channelId: "UCabcdefghijklmnopqrstuv", viewCount: "48210", lengthSeconds: "754",
    shortDescription: "We compare Acme and Zenith.\n0:00 Intro\n2:15 Pricing\n10:02 Verdict\nAcme: https://acme.example/ref\nZenith https://zenith.example" }

  it("finds the video id in any of YouTube's addresses", () => {
    for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"]) expect(youtubeVideoId(u)).toBe("dQw4w9WgXcQ")
    expect(youtubeVideoId("https://example.com/watch")).toBeNull()
  })

  it("reads the title, figures, chapters and description links", () => {
    const v = parseYoutubeVideo(page(details, { publishDate: "2026-09-01T08:00:00-07:00", category: "Science & Technology" }))!
    expect(v).toMatchObject({ title: "Acme vs Zenith: honest review", channel: "Tool Reviews", views: 48210, lengthSeconds: 754, published: "2026-09-01", category: "Science & Technology" })
    expect(v.chapters).toEqual([{ at: "0:00", title: "Intro" }, { at: "2:15", title: "Pricing" }, { at: "10:02", title: "Verdict" }])
    expect(v.links).toEqual(["https://acme.example/ref", "https://zenith.example"])
  })

  it("says so instead of guessing when the page carries no details", () => {
    expect(parseYoutubeVideo("<html>consent required</html>")).toBeNull()
  })

  it("runs as a research capability with brand counts, and says the spoken words are not read", async () => {
    const net = { api: async (url: string) => ({ status: 200, body: url.includes("watch?v=dQw4w9WgXcQ") ? page(details) : null, failure: null }) } as unknown as ResearchNetService
    const cap = capability("social.youtube_video")!
    const out = await Effect.runPromise(cap.run({ net, now: new Date() } as never, { video: "https://youtu.be/dQw4w9WgXcQ", own: "OpenRecord", brands: ["Acme", "Zenith"] }) as Effect.Effect<any, unknown>)
    expect(out.status).toBe("OBSERVED")
    expect(out.findings.brandMentions).toEqual({ OpenRecord: 0, Acme: 1, Zenith: 1 })
    expect(out.coverage.note).toContain("not read")
  })

  it("is found when the agent looks for a way to read videos or Reddit threads", () => {
    expect(findCapabilities("what a youtube video says about competitors").map(c => c.id)).toContain("social.youtube_video")
    expect(findCapabilities("read a reddit thread and its comments").map(c => c.id)).toContain("community.reddit.thread")
  })
})
