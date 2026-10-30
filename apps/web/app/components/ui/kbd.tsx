import * as React from "react"
import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] bg-control px-1.5 font-sans text-xs font-medium text-foreground shadow-(--key-shadow)",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
