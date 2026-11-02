import { GlobeIcon } from "lucide-react"
import { siFacebook, siG2, siGithub, siGoogle, siGoogleads, siGoogleanalytics, siGooglesearchconsole, siInstagram, siMeta, siPinterest, siProducthunt, siStripe, siTiktok, siWordpress, siX, siYelp, siYoutube, type SimpleIcon } from "simple-icons"
import { cn } from "@/lib/utils"

const MARKS: Record<string, SimpleIcon> = {
  ga4: siGoogleanalytics, github: siGithub, "search-console": siGooglesearchconsole,
  meta: siMeta, google_ads: siGoogleads, google_business: siGoogle, stripe: siStripe, wordpress: siWordpress,
  "profile:GITHUB": siGithub, "profile:GOOGLE_BUSINESS": siGoogle,
  "profile:FACEBOOK": siFacebook, "profile:INSTAGRAM": siInstagram,
  "profile:YOUTUBE": siYoutube, "profile:X": siX, "profile:TIKTOK": siTiktok,
  "profile:PINTEREST": siPinterest, "profile:YELP": siYelp,
  "profile:G2": siG2, "profile:PRODUCT_HUNT": siProducthunt,
}

export function ChannelMark({ channelKey, className }: { channelKey: string; className?: string }) {
  const icon = MARKS[channelKey]
  if (!icon) return <GlobeIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
  const [r, g, b] = [0, 2, 4].map(i => parseInt(icon.hex.slice(i, i + 2), 16))
  const lightness = (Math.max(r!, g!, b!) + Math.min(r!, g!, b!)) / 510
  const monochrome = lightness < 0.15 || lightness > 0.9
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={cn("size-4 shrink-0 text-foreground", className)} fill={monochrome ? "currentColor" : `#${icon.hex}`}>
      <path d={icon.path} />
    </svg>
  )
}
