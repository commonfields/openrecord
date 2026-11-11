// The web app's motion, built on Motion (motion.dev). Calm by design: things
// fade and numbers count; nothing slides up the page, and the agent chat is
// left without entrance motion. `MotionConfig reducedMotion="user"` in the app
// root turns all of it off when the system asks for reduced motion.
import { animate, motion, useInView, useReducedMotion } from "motion/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

/** The app's one easing: quick out, settled in. */
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

/** Fades its content in once, on mount. Opacity only. */
export function FadeIn({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22, delay, ease: EASE }}>
      {children}
    </motion.div>
  )
}

const item = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0.2, ease: EASE } } }

/** A list whose `StaggerItem`s fade in one after another, 30 ms apart. Opacity only. */
export function Stagger({ children, className, as = "ul", label }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol"; label?: string }) {
  const Tag = motion[as]
  return (
    <Tag className={className} aria-label={label} initial="hidden" animate="shown" variants={{ shown: { transition: { staggerChildren: 0.03 } } }}>
      {children}
    </Tag>
  )
}

/** One item of a `Stagger` list. */
export function StaggerItem({ children, className, as = "li" }: { children: ReactNode; className?: string; as?: "div" | "li" }) {
  const Tag = motion[as]
  return (
    <Tag className={className} variants={item}>
      {children}
    </Tag>
  )
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/

/**
 * Counts a figure up to its value when it scrolls into view, and from the old
 * value to the new one when it changes. Keeps the text around the number
 * ("77%", "4 of 5", "$1,204") and its decimals; anything without a number is
 * shown as is.
 */
export function CountUp({ value }: { value: ReactNode }) {
  const text = typeof value === "number" ? value.toLocaleString() : typeof value === "string" ? value : null
  const match = text ? NUMBER.exec(text) : null
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true })
  const reduce = useReducedMotion()
  const target = match ? Number(match[0].replace(/,/g, "")) : null
  const decimals = match?.[0].includes(".") ? match[0].split(".")[1]!.length : 0
  const [shown, setShown] = useState<number | null>(reduce ? target : 0)
  const last = useRef(0)

  useEffect(() => {
    if (target === null || !inView) return
    if (reduce) {
      setShown(target)
      return
    }
    const controls = animate(last.current, target, { duration: 0.7, ease: EASE, onUpdate: v => setShown(v) })
    last.current = target
    return () => controls.stop()
  }, [target, inView, reduce])

  if (!text || !match || target === null) return <>{value}</>
  const format = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return (
    <span ref={ref}>
      {text.slice(0, match.index)}
      {format(shown ?? target)}
      {text.slice(match.index + match[0].length)}
    </span>
  )
}

/** Swaps its content with a short cross-fade whenever `id` changes (a page, a tab). */
export function PageFade({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <motion.div key={id} className={className} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE }}>
      {children}
    </motion.div>
  )
}
