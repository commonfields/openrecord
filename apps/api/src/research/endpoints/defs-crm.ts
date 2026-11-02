// The business's own CRM records in HubSpot, read through its private app
// token (provider "hubspot", generated from the public API directory, which
// lacks HubSpot's core CRM object reads). HubSpot's CRM object API is one
// uniform pattern for every standard object: list, read one, owners,
// pipelines and the object's property definitions.
import { Schema } from "effect"
import { compactJson } from "./generated.js"
import { arr, none, obj, ok } from "./defs-public.js"
import type { AnyEndpoint, Parsed } from "./types.js"

const BASE = "https://api.hubapi.com/crm/v3"
const ObjectType = Schema.Literal("contacts", "companies", "deals", "tickets", "line_items", "products", "quotes", "calls", "emails", "meetings", "notes", "tasks")
const Props = Schema.optional(Schema.Array(Schema.String.pipe(Schema.pattern(/^[a-z0-9_]{1,80}$/))).pipe(Schema.maxItems(30)))
const List = Schema.Struct({ object: ObjectType, properties: Props, limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))), after: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/))), archived: Schema.optional(Schema.Boolean) })
const One = Schema.Struct({ object: ObjectType, id: Schema.String.pipe(Schema.pattern(/^\d{1,20}$/)), properties: Props, associations: Schema.optional(Schema.Array(ObjectType).pipe(Schema.maxItems(5))) })
const Typed = Schema.Struct({ object: ObjectType })
const NOTE = "As the business's own HubSpot holds it now. CRM records are what the team entered or HubSpot tracked; source fields are HubSpot's attribution, not proof of what caused a sale."

const results = (json: unknown): Parsed => {
  const o = obj(json), list = arr(o["results"])
  if (!list.length) return none("HubSpot returned no records. Not listed is not zero.")
  const next = obj(obj(o["paging"])["next"])["after"]
  return ok({ label: "SEEN", items: compactJson(list), count: list.length, ...(typeof next === "string" ? { nextAfter: next } : {}) }, { note: NOTE })
}

export const CRM_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "crm.hubspot.objects.list", provider: "hubspot", platform: "crm", title: "HubSpot CRM records", label: "SEEN", input: List, docs: "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
    description: "A page of the business's own HubSpot records of one type (contacts, companies, deals, tickets, products and activities), with chosen properties; pass nextAfter as after for the next page.",
    subject: (i: typeof List.Type) => `hubspot ${i.object}`,
    request: (i: typeof List.Type) => ({ method: "GET", url: `${BASE}/objects/${i.object}`, query: { limit: i.limit ?? 50, after: i.after, archived: i.archived, properties: i.properties?.join(",") } }), parse: results },
  { id: "crm.hubspot.objects.get", provider: "hubspot", platform: "crm", title: "One HubSpot CRM record", label: "SEEN", input: One, docs: "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
    description: "One of the business's own HubSpot records by id, with chosen properties and the ids of associated records (for example a deal's contacts and company).",
    subject: (i: typeof One.Type) => `hubspot ${i.object} ${i.id}`,
    request: (i: typeof One.Type) => ({ method: "GET", url: `${BASE}/objects/${i.object}/${i.id}`, query: { properties: i.properties?.join(","), associations: i.associations?.join(",") } }),
    parse: json => Object.keys(obj(json)).length ? ok({ label: "SEEN", result: compactJson(json) }, { note: NOTE }) : none("HubSpot returned nothing for this record.") },
  { id: "crm.hubspot.owners", provider: "hubspot", platform: "crm", title: "HubSpot record owners", label: "SEEN", input: Schema.Struct({}), docs: "https://developers.hubspot.com/docs/api/crm/owners",
    description: "The people records are assigned to in the business's own HubSpot (sales and marketing team members).", subject: () => "hubspot owners",
    request: () => ({ method: "GET", url: `${BASE}/owners`, query: { limit: 100 } }), parse: results },
  { id: "crm.hubspot.pipelines", provider: "hubspot", platform: "crm", title: "HubSpot pipelines and stages", label: "SEEN", input: Typed, docs: "https://developers.hubspot.com/docs/api/crm/pipelines",
    description: "The business's own HubSpot pipelines for deals or tickets with their stages, order and win probabilities.", subject: (i: typeof Typed.Type) => `hubspot ${i.object} pipelines`,
    request: (i: typeof Typed.Type) => ({ method: "GET", url: `${BASE}/pipelines/${i.object}` }), parse: results },
  { id: "crm.hubspot.properties", provider: "hubspot", platform: "crm", title: "HubSpot fields of a record type", label: "SEEN", input: Typed, docs: "https://developers.hubspot.com/docs/api/crm/properties",
    description: "The fields the business's HubSpot keeps for a record type (name, label, type, options), so the right properties can be asked for, for example original source or lifecycle stage.",
    subject: (i: typeof Typed.Type) => `hubspot ${i.object} properties`,
    request: (i: typeof Typed.Type) => ({ method: "GET", url: `${BASE}/properties/${i.object}` }), parse: results },
]
