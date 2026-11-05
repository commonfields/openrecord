import { useState } from "react"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "./button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./dialog"

/** Calendar-only dates use local components, never UTC conversion or native pickers. */
export function DatePicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date())
  const selected = value ? new Date(`${value}T12:00:00`) : null
  const dateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const choose = (d: Date) => { onChange(dateString(d)); setOpen(false) }
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const shift = (offset: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + offset, 1))
  return <Dialog open={open} onOpenChange={next => {
    if (next) setMonth(selected && !Number.isNaN(selected.getTime()) ? selected : new Date())
    setOpen(next)
  }}>
    <DialogTrigger asChild><Button type="button" variant="outline" aria-label={`${label}: ${value || "Choose date"}`} className="h-9 w-full justify-start font-normal"><CalendarIcon className="size-4 text-muted-foreground" />{selected && !Number.isNaN(selected.getTime()) ? selected.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Choose date"}</Button></DialogTrigger>
    <DialogContent className="sm:max-w-sm">
      <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>Choose a date for this campaign.</DialogDescription></DialogHeader>
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="icon" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeftIcon /></Button>
        <p aria-live="polite" className="text-sm font-medium">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
        <Button type="button" variant="ghost" size="icon" aria-label="Next month" onClick={() => shift(1)}><ChevronRightIcon /></Button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <span key={day} className="py-2 text-center text-xs text-muted-foreground">{day}</span>)}
        {Array.from({ length: first.getDay() }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const day = new Date(month.getFullYear(), month.getMonth(), i + 1)
          const active = dateString(day) === value
          return <Button key={i} type="button" size="icon" variant={active ? "default" : "ghost"} className="w-full" aria-label={day.toLocaleDateString(undefined, { dateStyle: "full" })} aria-pressed={active} aria-current={dateString(day) === dateString(new Date()) ? "date" : undefined} onClick={() => choose(day)}>{i + 1}</Button>
        })}
      </div>
      <div className="flex justify-between border-t pt-3"><Button type="button" variant="ghost" onClick={() => { onChange(""); setOpen(false) }}>Clear date</Button><Button type="button" variant="outline" onClick={() => choose(new Date())}>Today</Button></div>
    </DialogContent>
  </Dialog>
}
