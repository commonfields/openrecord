// In-app confirmation for consequential actions (runs that ask a provider,
// stopping a run, revoking a link). The dialog stays open while the action is
// in flight and closes only when it succeeds, so a failure is never hidden.
import { useState, type ReactNode } from "react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/spinner"
import { cn } from "@/lib/utils"

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  icon,
  tone = "default",
  confirmLabel,
  confirmIcon,
  cancelLabel = "Cancel",
  footnote,
  wide = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  icon?: ReactNode
  tone?: "default" | "destructive"
  confirmLabel: ReactNode
  confirmIcon?: ReactNode
  cancelLabel?: ReactNode
  /** A short line beside the buttons, e.g. what happens after confirming. */
  footnote?: ReactNode
  /** Room for a list (a run's questions) rather than a sentence. */
  wide?: boolean
  /** Resolve false to keep the dialog open (the action reported its own error). */
  onConfirm: () => Promise<boolean | void>
}) {
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    try {
      if ((await onConfirm()) !== false) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <AlertDialogContent className={cn("gap-0 overflow-hidden p-0", wide ? "sm:max-w-xl" : "sm:max-w-md")}>
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          {icon ? (
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
                tone === "destructive" ? "bg-wrong-soft text-wrong" : "bg-primary-ink/10 text-primary-ink",
              )}
            >
              {icon}
            </span>
          ) : null}
          <AlertDialogHeader className="min-w-0 gap-1 pt-0.5">
            <AlertDialogTitle className="text-sm leading-snug">{title}</AlertDialogTitle>
            {description ? <AlertDialogDescription className="leading-relaxed">{description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
        </div>
        {children ? <div className="space-y-3 px-5 pb-4 text-xs">{children}</div> : null}
        <AlertDialogFooter className="items-center border-t bg-muted/30 px-5 py-3">
          {footnote ? <p className="mr-auto text-[0.6875rem] text-muted-foreground max-sm:order-last max-sm:text-center">{footnote}</p> : null}
          <AlertDialogCancel disabled={busy} className="h-8">{cancelLabel}</AlertDialogCancel>
          <Button variant={tone === "destructive" ? "destructive" : "default"} disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner /> : confirmIcon}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
