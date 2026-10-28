// Settings groups and rows, shared by every settings screen: a 16px title, a
// card with a 10px radius and the raised card shadow, and 80px rows with 14px
// padding, a 14px name and 13px subtext.
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function SettingGroup({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base leading-5 font-medium">{title}</h3>
        {description ? <p className="text-[0.8125rem] text-muted-foreground">{description}</p> : null}
      </div>
      <div className={cn("divide-y divide-border overflow-hidden rounded-[10px] bg-card shadow-(--card-shadow)", className)}>{children}</div>
    </section>
  )
}

export function SettingRow({ label, description, children, icon, htmlFor, className }: {
  label: ReactNode; description?: ReactNode; children?: ReactNode; icon?: ReactNode; htmlFor?: string; className?: string
}) {
  const name = <span className="flex items-center gap-2 text-sm font-medium [&_svg]:shrink-0">{icon}{label}</span>
  return (
    <div className={cn("flex min-h-20 flex-col justify-center gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5", className)}>
      <div className="min-w-0 space-y-0.5">
        {htmlFor ? <label htmlFor={htmlFor} className="block">{name}</label> : name}
        {description ? <div className="text-[0.8125rem] text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}
