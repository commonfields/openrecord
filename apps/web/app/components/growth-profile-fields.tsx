import type { GrowthProfile } from "@openrecord/contracts"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { GROWTH_GOAL_LABELS } from "@/lib/growth"

export function GrowthProfileFields({ profile }: { profile?: GrowthProfile | null }) {
  return <>
    <div className="grid gap-2"><Label htmlFor="growth-category">Product category</Label><Input id="growth-category" name="category" maxLength={300} defaultValue={profile?.category} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-audience">Target audience</Label><Textarea id="growth-audience" name="audience" maxLength={1000} defaultValue={profile?.audience} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-value">Core value proposition</Label><Textarea id="growth-value" name="valueProposition" maxLength={2000} defaultValue={profile?.valueProposition} required /></div>
    <div className="grid gap-2"><Label htmlFor="growth-kind">Primary goal</Label>
      <Select name="goalKind" defaultValue={profile?.primaryGoal.kind ?? "TRIAL_SIGNUPS"}><SelectTrigger id="growth-kind" className="w-full"><SelectValue /></SelectTrigger><SelectContent>
        {Object.entries(GROWTH_GOAL_LABELS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
      </SelectContent></Select>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-2"><Label htmlFor="growth-event">GA4 event name</Label><Input id="growth-event" name="eventName" placeholder="trial_signup" pattern="[A-Za-z][A-Za-z0-9_]{0,39}" maxLength={40} defaultValue={profile?.primaryGoal.eventName} required /></div>
      <div className="grid gap-2"><Label htmlFor="growth-zone">Reporting timezone (IANA)</Label><Input id="growth-zone" name="reportingTimeZone" placeholder="Asia/Makassar" maxLength={100} defaultValue={profile?.primaryGoal.reportingTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} required /></div>
    </div>
    <div className="grid gap-2"><Label htmlFor="growth-property">Analytics property reference (optional)</Label><Input id="growth-property" name="propertyRef" maxLength={200} defaultValue={profile?.primaryGoal.propertyRef ?? ""} /></div>
    <p className="text-xs text-muted-foreground">Metric: GA4 aggregate export, event count. Events are not distinct people. Defining a goal does not import analytics or measure signups.</p>
  </>
}
