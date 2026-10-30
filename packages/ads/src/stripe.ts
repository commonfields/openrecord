// Stripe revenue, read with a restricted key the business creates with
// read-only permissions (Charges and Customers: Read). Full secret keys are
// refused before any call, so nothing here can charge, refund or change a
// customer, and the module only issues GET requests. Money is reported per
// currency in major units; Stripe's amounts are integers in the currency's
// smallest unit.
import type { RevenueTotals, SearchWindow } from "@openrecord/contracts"
import { unexpected } from "./errors.js"
import { amount, send, text, type FetchLike } from "./http.js"

export interface StripeConfig { readonly endpoint: string; readonly fetch: FetchLike }
export const STRIPE_ENDPOINT = "https://api.stripe.com/v1"

/** A restricted key (rk_live_ or rk_test_) is accepted; a secret or publishable key never is. */
export const stripeKeyKind = (key: string): { readonly ok: true; readonly livemode: boolean; readonly last4: string } | { readonly ok: false; readonly reason: "SECRET_KEY" | "NOT_A_KEY" } => {
  const k = key.trim()
  if (/^sk_(live|test)_/.test(k)) return { ok: false, reason: "SECRET_KEY" }
  const m = /^rk_(live|test)_([A-Za-z0-9]{20,250})$/.exec(k)
  return m ? { ok: true, livemode: m[1] === "live", last4: m[2]!.slice(-4) } : { ok: false, reason: "NOT_A_KEY" }
}

const get = (c: StripeConfig, key: string, path: string, params: Record<string, string> = {}) =>
  send(c.fetch, `${c.endpoint}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" } })

/** The account's name and ID when the key may read them; a key without that permission still works for revenue. */
export const stripeAccount = async (c: StripeConfig, key: string): Promise<{ readonly id: string | null; readonly name: string | null }> => {
  try {
    const a = await get(c, key, "/account") as { id?: unknown; business_profile?: { name?: unknown }; settings?: { dashboard?: { display_name?: unknown } } }
    const id = text(a.id, 60)
    return { id: /^acct_[A-Za-z0-9]{1,40}$/.test(id) ? id : null, name: text(a.settings?.dashboard?.display_name, 200) || text(a.business_profile?.name, 200) || null }
  } catch { return { id: null, name: null } }
}

// Currencies Stripe counts in whole units rather than hundredths.
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"])
const major = (minor: number, currency: string) => ZERO_DECIMAL.has(currency) ? minor : minor / 100

const range = (w: SearchWindow) => {
  const from = Date.parse(`${w.start}T00:00:00Z`), to = Date.parse(`${w.end}T23:59:59Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw unexpected()
  return { "created[gte]": String(Math.floor(from / 1000)), "created[lte]": String(Math.floor(to / 1000)) }
}
const list = async (c: StripeConfig, key: string, path: string, params: Record<string, string>, pages: number) => {
  const rows: Array<Record<string, unknown>> = []
  let after: string | null = null, more = false
  for (let page = 0; page < pages; page++) {
    const body = await get(c, key, path, { ...params, limit: "100", ...(after ? { starting_after: after } : {}) }) as { data?: unknown; has_more?: unknown }
    const data = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : []
    rows.push(...data)
    more = body.has_more === true
    const last = text(data.at(-1)?.["id"], 80)
    if (!more || !last) break
    after = last
  }
  return { rows, truncated: more }
}

export const stripeRevenue = async (c: StripeConfig, key: string, window: SearchWindow): Promise<RevenueTotals> => {
  const { rows, truncated } = await list(c, key, "/charges", range(window), 30)
  const per = new Map<string, { gross: number; refunded: number; orders: number }>()
  const payers = new Set<string>()
  for (const ch of rows) {
    if (ch["status"] !== "succeeded" || ch["paid"] !== true) continue
    const currency = text(ch["currency"], 3).toLowerCase()
    if (!/^[a-z]{3}$/.test(currency)) continue
    const t = per.get(currency) ?? { gross: 0, refunded: 0, orders: 0 }
    t.gross += amount(ch["amount"]); t.refunded += amount(ch["amount_refunded"]); t.orders += 1
    per.set(currency, t)
    const who = text(ch["customer"], 80) || text((ch["billing_details"] as { email?: unknown } | undefined)?.email, 200).toLowerCase()
    if (who) payers.add(who)
  }
  const newCustomers = await list(c, key, "/customers", range(window), 10).then(r => r.rows.length).catch(() => null)
  return {
    byCurrency: [...per].map(([currency, t]) => {
      const net = major(t.gross - t.refunded, currency)
      return { currency: currency.toUpperCase(), net, gross: major(t.gross, currency), refunded: major(t.refunded, currency), orders: t.orders, averageOrder: t.orders ? net / t.orders : null }
    }).sort((a, b) => b.orders - a.orders),
    payingCustomers: payers.size, newCustomers, truncated,
  }
}
