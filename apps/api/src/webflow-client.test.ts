// What each Webflow change writes and replaces, and whether Webflow stored it. No network.
import { describe, expect, it } from "vitest"
import { hasUnpublishedEdits, liveBase, planItemCreate, planItemUpdate, planPageSeo, slugify, storedItem, toCollection, toItem, toPage, toSite } from "./webflow-client.js"

const ID = (n: number) => n.toString(16).padStart(24, "0")
const page = toPage({ id: ID(1), title: "Pricing", slug: "pricing", seo: { title: "Pricing", description: "" }, lastUpdated: "2026-11-01T00:00:00.000Z", publishedPath: "/pricing" })
const blog = toCollection({ id: ID(2), displayName: "Blog Posts", slug: "blog", fields: [
  { slug: "name", displayName: "Name", type: "PlainText", isRequired: true, isEditable: true },
  { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true, isEditable: true },
  { slug: "summary", displayName: "Summary", type: "PlainText", isRequired: false, isEditable: true },
  { slug: "body", displayName: "Body", type: "RichText", isRequired: false, isEditable: true },
  { slug: "cover", displayName: "Cover", type: "Image", isRequired: false, isEditable: true },
] })
const item = toItem({ id: ID(3), lastUpdated: "2026-11-01T00:00:00.000Z", lastPublished: "2026-11-01T00:00:10.000Z", fieldData: { name: "Hello", slug: "hello", summary: "Old", body: "<p>Old body</p>" } })

describe("page SEO", () => {
  it("writes only what differs and keeps what it replaces", () => {
    expect(planPageSeo({ seoTitle: "Pricing", seoDescription: "Plans from $9 a month" }, page)).toEqual({ before: { seo: { description: "" } }, after: { seo: { description: "Plans from $9 a month" } } })
    expect(planPageSeo({ seoTitle: " Pricing " }, page)).toEqual({ refused: "NOTHING_TO_CHANGE" })
    expect(planPageSeo({}, page)).toEqual({ refused: "MISSING_FIELDS" })
  })
})

describe("CMS items", () => {
  it("updates text fields, never the address or a non-text field", () => {
    expect(planItemUpdate({ fields: { summary: "New" } }, blog, item)).toEqual({ before: { fieldData: { summary: "Old" } }, after: { fieldData: { summary: "New" } } })
    expect(planItemUpdate({ fields: { slug: "new-address" } }, blog, item)).toEqual({ refused: "SLUG_CHANGE" })
    expect(planItemUpdate({ fields: { cover: "https://x.test/a.png" } }, blog, item)).toEqual({ refused: "FIELD_NOT_WRITABLE" })
    expect(planItemUpdate({ fields: { unknown: "x" } }, blog, item)).toEqual({ refused: "FIELD_NOT_WRITABLE" })
    expect(planItemUpdate({ fields: { summary: "Old" } }, blog, item)).toEqual({ refused: "NOTHING_TO_CHANGE" })
  })

  it("creates an item with a name and an address made from it", () => {
    expect(planItemCreate({ fields: { name: "Wedding DJs in Bali: a guide", body: "<p>Hi</p>" } }, blog))
      .toEqual({ before: {}, after: { fieldData: { name: "Wedding DJs in Bali: a guide", body: "<p>Hi</p>", slug: "wedding-djs-in-bali-a-guide" } } })
    expect(planItemCreate({ fields: { body: "x" } }, blog)).toEqual({ refused: "MISSING_FIELDS" })
    const withImage = toCollection({ id: ID(4), fields: [{ slug: "name", type: "PlainText", isRequired: true }, { slug: "slug", type: "PlainText", isRequired: true }, { slug: "photo", type: "Image", isRequired: true }] })
    expect(planItemCreate({ fields: { name: "A" } }, withImage)).toEqual({ refused: "COLLECTION_NEEDS_OTHER_FIELDS" })
    expect(slugify("Café & Bar  Ubud")).toBe("cafe-bar-ubud")
  })

  it("compares rich text as a reader sees it", () => {
    const stored = toItem({ id: ID(3), fieldData: { body: "<p id=\"x\">New   body</p>", summary: "New" } })
    expect(storedItem(stored, { fieldData: { body: "<p>New body</p>", summary: "New" } }, blog)).toBe(true)
    expect(storedItem(stored, { fieldData: { summary: "Other" } }, blog)).toBe(false)
  })
})

describe("what is live", () => {
  it("counts edits after the last publish, with a minute's grace, and says yes when unsure", () => {
    expect(hasUnpublishedEdits("2026-11-01T00:00:30Z", "2026-11-01T00:00:00Z")).toBe(false)
    expect(hasUnpublishedEdits("2026-11-01T00:05:00Z", "2026-11-01T00:00:00Z")).toBe(true)
    expect(hasUnpublishedEdits("2026-11-01T00:00:00Z", null)).toBe(true)
  })

  it("checks pages at the first custom domain, else the webflow.io address", () => {
    expect(liveBase(toSite({ id: ID(9), shortName: "cueup", customDomains: [{ id: ID(8), url: "www.cueup.test" }] }))).toBe("https://www.cueup.test")
    expect(liveBase(toSite({ id: ID(9), shortName: "cueup", customDomains: [] }))).toBe("https://cueup.webflow.io")
  })
})
