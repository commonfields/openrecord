// Which brands people's words name: the business's own and the others given
// (usually competitors). Used where research reads what people wrote, to
// find places that name others but not the business: the citation gaps.
/** Which of the brands a text names: whole words, any case. */
const named = (text: string, brands: ReadonlyArray<string>) => brands.filter(b => new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text))
/** Per brand, how many of the items name it; and the items that name another brand but not the business's own. */
export const brandMentions = <T extends { text: string }>(items: ReadonlyArray<T>, own: string | undefined, others: ReadonlyArray<string> | undefined) => {
  const brands = [...new Set([...(own ? [own] : []), ...(others ?? [])])]
  if (!brands.length) return null
  const counts: Record<string, number> = Object.fromEntries(brands.map(b => [b, 0]))
  const tagged = items.map(it => { const n = named(it.text, brands); for (const b of n) counts[b]! += 1; return { item: it, named: n } })
  const othersNotUs = own ? tagged.filter(t => t.named.some(b => b !== own) && !t.named.includes(own)).length : null
  return { counts, tagged, othersNotUs }
}
