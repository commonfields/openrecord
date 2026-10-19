import { useState } from "react"
import type { GrowthProfile } from "@openrecord/contracts"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { GROWTH_GOAL_LABELS } from "@/lib/growth"

export function GrowthProfileFields({ profile }: { profile?: GrowthProfile | null }) {
  const metric = profile?.primaryGoal.metricDefinition
  const [source, setSource] = useState(metric?.sourceKind ?? "GA4_AGGREGATE_EXPORT")
  const [unit, setUnit] = useState(metric?.unit ?? "COUNT")
  return <>
    <div className="grid gap-2"><Label htmlFor="growth-category">Business category</Label><Input id="growth-category" name="category" maxLength={300} defaultValue={profile?.category} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-audience">Target audience</Label><Textarea id="growth-audience" name="audience" maxLength={1000} defaultValue={profile?.audience} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-value">Core value proposition</Label><Textarea id="growth-value" name="valueProposition" maxLength={2000} defaultValue={profile?.valueProposition} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-statement">What do you want to improve?</Label><Input id="growth-statement" name="goalStatement" maxLength={1000} defaultValue={profile?.primaryGoal.statement} placeholder="Increase trial signups from the pricing page" required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-kind">Outcome category</Label>
      <Select name="conversionKind" defaultValue={metric?.conversionKind ?? "SIGNUP"}><SelectTrigger id="growth-kind" className="w-full"><SelectValue /></SelectTrigger><SelectContent>
        {Object.entries(GROWTH_GOAL_LABELS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
      </SelectContent></Select>
    </div>
    <div className="grid gap-2"><Label htmlFor="growth-label">Metric label</Label><Input id="growth-label" name="metricLabel" maxLength={120} defaultValue={metric?.label} placeholder="Trial signups or confirmed bookings" required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-source">Measurement source</Label>
      <Select name="sourceKind" value={source} onValueChange={v => { if (v === "GA4_AGGREGATE_EXPORT" || v === "OPERATOR_AGGREGATE_EXPORT") { setSource(v); if (v === "GA4_AGGREGATE_EXPORT") setUnit("COUNT") } }}>
        <SelectTrigger id="growth-source"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="GA4_AGGREGATE_EXPORT">GA4 aggregate export</SelectItem><SelectItem value="OPERATOR_AGGREGATE_EXPORT">Operator aggregate CSV</SelectItem></SelectContent>
      </Select>
    </div>
    <div className="grid gap-2"><Label htmlFor="growth-identity">Source identity</Label><Input id="growth-identity" name="sourceIdentity" maxLength={200} defaultValue={metric?.sourceIdentity} placeholder="GA4 property or booking system and account" required /></div>
    {source === "GA4_AGGREGATE_EXPORT" ? <div className="grid gap-2"><Label htmlFor="growth-event">GA4 event name</Label><Input id="growth-event" name="eventName" pattern="[A-Za-z][A-Za-z0-9_]{0,39}" maxLength={40} defaultValue={metric?.eventName ?? "trial_signup"} required /></div> : null}
    <div className="grid gap-2"><Label htmlFor="growth-property">{source === "GA4_AGGREGATE_EXPORT" ? "GA4 property reference" : "Source reference (optional)"}</Label><Input id="growth-property" name="propertyRef" maxLength={200} defaultValue={metric?.propertyRef ?? ""} required={source === "GA4_AGGREGATE_EXPORT"} /></div>
    {source === "OPERATOR_AGGREGATE_EXPORT" ? <div className="grid gap-2"><Label htmlFor="growth-unit">Value semantics</Label><Select name="unit" value={unit} onValueChange={v => { if (v === "COUNT" || v === "CURRENCY_MINOR") setUnit(v) }}>
      <SelectTrigger id="growth-unit"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="COUNT">Event count</SelectItem><SelectItem value="CURRENCY_MINOR">Monetary sum in minor units</SelectItem></SelectContent>
    </Select></div> : <input type="hidden" name="unit" value="COUNT" />}
    {unit === "CURRENCY_MINOR" && source === "OPERATOR_AGGREGATE_EXPORT" ? <div className="grid gap-2"><Label htmlFor="growth-currency">Currency code</Label><Input id="growth-currency" name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={metric?.currency ?? "USD"} required /><p className="text-xs text-muted-foreground">Values use integer minor units, such as cents for USD. One currency per definition. No currency conversion or revenue attribution is performed.</p></div> : null}
    <div className="grid gap-2"><Label htmlFor="growth-zone">Reporting timezone (IANA)</Label><Input id="growth-zone" name="reportingTimeZone" maxLength={100} defaultValue={metric?.reportingTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} required /></div>
    <p className="text-xs text-muted-foreground">Defining a metric does not import a file or validate the external account. Counts are events, not distinct people. Operator CSVs remain operator-supplied evidence.</p>
  </>
}
