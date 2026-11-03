import { describe, expect, it } from "vitest"
import { citationTargets, schemaKit } from "./visibility-engine.js"

describe("AEO schema kit", () => {
  const facts = [
    { predicate: "monthly_price", value: "$39", type: "CURRENCY" }, { predicate: "phone_support", value: "false", type: "BOOLEAN" },
    { predicate: "support_email", value: "help@northstar.test", type: "TEXT" }, { predicate: "opening_hours", value: "Mo-Fr 09:00-17:00", type: "TEXT" },
    { predicate: "free_trial_days", value: "14", type: "NUMBER" },
  ]
  it("maps recognised facts into schema.org and never guesses the rest", () => {
    const kit = schemaKit("Northstar", "https://northstar.test", facts)
    expect(kit.organization).toMatchObject({ "@type": "LocalBusiness", name: "Northstar", url: "https://northstar.test", email: "help@northstar.test", openingHours: "Mo-Fr 09:00-17:00",
      makesOffer: [{ "@type": "Offer", name: "monthly price", price: "39", priceCurrency: "USD" }] })
    // phone_support is a yes/no fact, not a phone number.
    expect(kit.organization["telephone"]).toBeUndefined()
    expect(kit.unmapped).toEqual(["phone_support", "free_trial_days"])
  })
  it("answers FAQ questions only with approved values, and lists them in llms.txt", () => {
    const kit = schemaKit("Northstar", null, facts)
    expect(kit.faq?.mainEntity).toContainEqual({ "@type": "Question", name: "Does Northstar offer phone support?", acceptedAnswer: { "@type": "Answer", text: "No." } })
    expect(kit.llmsTxt).toContain("# Northstar")
    expect(kit.llmsTxt).toContain("- monthly price: $39")
    expect(kit.organization["url"]).toBeUndefined()
  })
})

describe("GEO citation targets", () => {
  const cite = (url: string, owner = "OTHER", sourceType = "REVIEW_SITE") => ({ url, domain: new URL(url).hostname, owner, sourceType })
  it("keeps pages cited when competitors are named and the business is not, most cited first", () => {
    const t = citationTargets([
      { prompt: "best dental software", answeredAt: "2026-11-01T00:00:00Z", brandMentioned: false, mentions: [{ brand: "Rival", role: "COMPETITOR" }],
        citations: [cite("https://reviews.example/top10"), cite("https://northstar.test/pricing", "OWNED")] },
      { prompt: "dental software for clinics", answeredAt: "2026-11-02T00:00:00Z", brandMentioned: false, mentions: [{ brand: "Other Co", role: "COMPETITOR" }],
        citations: [cite("https://reviews.example/top10"), cite("https://forum.example/thread", "OTHER", "FORUM")] },
      // Names the business: not a gap.
      { prompt: "northstar reviews", answeredAt: "2026-11-02T00:00:00Z", brandMentioned: true, mentions: [{ brand: "Rival", role: "COMPETITOR" }], citations: [cite("https://press.example/a")] },
      // Names no competitor: not a gap either.
      { prompt: "what is dental software", answeredAt: "2026-11-02T00:00:00Z", brandMentioned: false, mentions: [], citations: [cite("https://wiki.example/x")] },
    ])
    expect(t.map(x => x.url)).toEqual(["https://reviews.example/top10", "https://forum.example/thread"])
    expect(t[0]).toMatchObject({ citations: 2, last: "2026-11-02T00:00:00Z" })
    expect([...t[0]!.competitors]).toEqual(["Rival", "Other Co"])
  })
})
