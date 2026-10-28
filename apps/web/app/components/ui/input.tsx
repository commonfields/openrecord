import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-7 w-full min-w-0 rounded-[6px] bg-control px-2.5 py-1 text-[0.8125rem] shadow-(--control-shadow) transition-[color,box-shadow] outline-none placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
        "focus-visible:border-primary-ink/60 focus-visible:ring-[3px] focus-visible:ring-ring",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
