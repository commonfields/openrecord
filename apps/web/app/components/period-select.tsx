// The period a card's numbers cover, as the same compact dropdown the
// toolbars above other cards use (the issues filters, the Results range).
import { CalendarIcon } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function PeriodSelect<D extends number>({ value, options, onChange }: { value: D; options: readonly D[]; onChange: (days: D) => void }) {
  return (
    <Select value={String(value)} onValueChange={v => { const d = options.find(o => String(o) === v); if (d !== undefined) onChange(d) }}>
      <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label="Period">
        <CalendarIcon className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map(d => <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
