import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-[0.8125rem] font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-(--primary-shadow) hover:bg-primary/90",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90",
        outline: "bg-control shadow-(--control-shadow) hover:bg-control-hover",
        secondary: "bg-control text-foreground shadow-(--control-shadow) hover:bg-control-hover",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-3 has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-5 has-[>svg]:px-4",
        icon: "size-7",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
