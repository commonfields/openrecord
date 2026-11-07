import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { defaultPreferences } from "../app/lib/preferences"

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
const boot = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ""
const resolve = (stored: string | null, systemDark = false, blocked = false) => {
  let dark = /<html[^>]*class="dark"/.test(html)
  runInNewContext(boot, {
    localStorage: { getItem: () => { if (blocked) throw new Error("Storage unavailable"); return stored } },
    matchMedia: () => ({ matches: systemDark }),
    document: { documentElement: { classList: { toggle: (_name: string, value: boolean) => { dark = value } } } },
  })
  return dark
}

describe("theme before first paint", () => {
  it("defaults the document and preferences to dark even on a light OS", () => {
    expect(defaultPreferences.theme).toBe("dark")
    expect(resolve(null, false)).toBe(true)
    expect(html).toMatch(/<html[^>]*class="dark"/)
  })
  it("paints the matching document canvas before the app bundle loads", () => {
    expect(html).toContain('name="color-scheme" content="dark light"')
    expect(html).toContain("html.dark { background-color: #1a1a1a; color-scheme: dark; }")
    expect(html).toContain("html { background-color: #f9f9f9; color-scheme: light; }")
    expect(html.indexOf("html.dark {")).toBeLessThan(html.indexOf('src="/app/main.tsx"'))
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
    expect(css).toMatch(/\.dark\s*\{\s*--background: #1a1a1a;/)
    expect(css).toContain("--background: #f9f9f9;")
  })
  it.each([
    ['{"theme":"dark"}', false, true], ['{"theme":"light"}', true, false],
    ['{"theme":"system"}', false, false], ['{"theme":"system"}', true, true],
  ])("honors saved preference %s with systemDark=%s", (stored, os, expected) => {
    expect(resolve(stored, os)).toBe(expected)
  })
  it.each(["broken json", "null", "{}", '{"theme":"invalid"}'])("falls back to dark for %s", stored => {
    expect(resolve(stored)).toBe(true)
  })
  it("stays dark if browser storage is unavailable", () => {
    expect(resolve(null, false, true)).toBe(true)
  })
})
