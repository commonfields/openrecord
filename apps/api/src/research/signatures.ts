// OpenRecord's own technology signatures: what a public page's markup,
// scripts and headers show a company uses. Each signature is a pattern on a
// script address, the page source or a response header. A match means the
// code is present on the page that was read, not that it is in active use.
// Signatures for advertising, referral and marketing tools also say which
// acquisition channel they imply.

export type TechCategory =
  | "Analytics" | "Tag manager" | "Advertising" | "Marketing automation" | "Email" | "CRM and chat" | "A/B testing" | "Personalization"
  | "CMS" | "Site builder" | "Ecommerce" | "Payments" | "Reviews" | "Referral and affiliate" | "Scheduling" | "Consent" | "Hosting and CDN" | "Framework" | "Support" | "Session replay" | "Forms" | "Video"
export interface Signature {
  readonly name: string
  readonly category: TechCategory
  readonly script?: RegExp
  readonly html?: RegExp
  readonly header?: readonly [string, RegExp]
  /** The acquisition channel the tool implies, when it implies one. */
  readonly channel?: string
}

export const SIGNATURES: ReadonlyArray<Signature> = [
  // Analytics and tag managers
  { name: "Google Analytics", category: "Analytics", script: /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(analytics|ga)\.js/i, html: /gtag\(\s*['"]config['"]\s*,\s*['"]G-/i },
  { name: "Google Tag Manager", category: "Tag manager", script: /googletagmanager\.com\/gtm\.js/i, html: /GTM-[A-Z0-9]{4,8}/ },
  { name: "Segment", category: "Analytics", script: /cdn\.segment\.(com|io)\/analytics\.js/i },
  { name: "Mixpanel", category: "Analytics", script: /cdn\.mxpnl\.com|mixpanel\.com\/libs/i },
  { name: "Amplitude", category: "Analytics", script: /cdn\.amplitude\.com|amplitude\.com\/libs/i },
  { name: "PostHog", category: "Analytics", script: /posthog\.com\/static|\/static\/array\.js/i, html: /posthog\.init\(/i },
  { name: "Heap", category: "Analytics", script: /cdn\.heapanalytics\.com/i },
  { name: "Plausible", category: "Analytics", script: /plausible\.io\/js/i },
  { name: "Fathom", category: "Analytics", script: /cdn\.usefathom\.com/i },
  { name: "Matomo", category: "Analytics", script: /matomo\.js|piwik\.js/i },
  { name: "Adobe Analytics", category: "Analytics", script: /assets\.adobedtm\.com|omtrdc\.net/i },
  { name: "Microsoft Clarity", category: "Session replay", script: /clarity\.ms\/tag/i },
  { name: "Hotjar", category: "Session replay", script: /static\.hotjar\.com/i },
  { name: "FullStory", category: "Session replay", script: /fullstory\.com\/s\/fs\.js|edge\.fullstory\.com/i },
  // Advertising: each pixel implies paid acquisition on its network
  { name: "Google Ads", category: "Advertising", script: /googleadservices\.com\/pagead\/conversion|googletagmanager\.com\/gtag\/js\?id=AW-/i, html: /['"]AW-\d{6,}/, channel: "Paid search and display (Google Ads)" },
  { name: "Meta Pixel", category: "Advertising", script: /connect\.facebook\.net\/[a-z_A-Z]+\/fbevents\.js/i, html: /fbq\(\s*['"]init['"]/i, channel: "Paid social (Facebook and Instagram)" },
  { name: "LinkedIn Insight Tag", category: "Advertising", script: /snap\.licdn\.com\/li\.lms-analytics/i, html: /_linkedin_partner_id/i, channel: "Paid social (LinkedIn)" },
  { name: "TikTok Pixel", category: "Advertising", script: /analytics\.tiktok\.com\/i18n\/pixel/i, html: /ttq\.load\(/i, channel: "Paid social (TikTok)" },
  { name: "X Pixel", category: "Advertising", script: /static\.ads-twitter\.com\/uwt\.js/i, html: /twq\(\s*['"]config/i, channel: "Paid social (X)" },
  { name: "Pinterest Tag", category: "Advertising", script: /s\.pinimg\.com\/ct\/core\.js/i, html: /pintrk\(\s*['"]load/i, channel: "Paid social (Pinterest)" },
  { name: "Snap Pixel", category: "Advertising", script: /sc-static\.net\/scevent\.min\.js/i, channel: "Paid social (Snapchat)" },
  { name: "Reddit Pixel", category: "Advertising", script: /redditstatic\.com\/ads\/pixel\.js/i, html: /rdt\(\s*['"]init/i, channel: "Paid social (Reddit)" },
  { name: "Microsoft Advertising", category: "Advertising", script: /bat\.bing\.com\/bat\.js/i, channel: "Paid search (Microsoft Advertising)" },
  { name: "Quora Pixel", category: "Advertising", script: /a\.quora\.com\/qevents\.js/i, channel: "Paid social (Quora)" },
  { name: "Criteo", category: "Advertising", script: /static\.criteo\.net/i, channel: "Retargeting display (Criteo)" },
  { name: "AdRoll", category: "Advertising", script: /s\.adroll\.com/i, channel: "Retargeting display (AdRoll)" },
  { name: "Taboola", category: "Advertising", script: /cdn\.taboola\.com/i, channel: "Native advertising (Taboola)" },
  { name: "Outbrain", category: "Advertising", script: /amplify\.outbrain\.com/i, channel: "Native advertising (Outbrain)" },
  { name: "Google AdSense", category: "Advertising", script: /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle/i },
  // Marketing automation, email, CRM and chat
  { name: "HubSpot", category: "Marketing automation", script: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/i, channel: "Inbound marketing (forms, email nurture)" },
  { name: "Marketo", category: "Marketing automation", script: /munchkin\.marketo\.net/i, channel: "Inbound marketing (forms, email nurture)" },
  { name: "Pardot", category: "Marketing automation", script: /pi\.pardot\.com/i, channel: "Inbound marketing (forms, email nurture)" },
  { name: "ActiveCampaign", category: "Marketing automation", script: /trackcmp\.net|activehosted\.com/i, channel: "Email marketing" },
  { name: "Klaviyo", category: "Email", script: /static\.klaviyo\.com/i, channel: "Email and SMS marketing" },
  { name: "Mailchimp", category: "Email", script: /chimpstatic\.com|list-manage\.com/i, channel: "Email marketing" },
  { name: "ConvertKit", category: "Email", script: /convertkit\.com|ck\.page/i, channel: "Email newsletter" },
  { name: "Customer.io", category: "Email", script: /assets\.customer\.io/i, channel: "Lifecycle email" },
  { name: "Intercom", category: "CRM and chat", script: /widget\.intercom\.io|js\.intercomcdn\.com/i },
  { name: "Drift", category: "CRM and chat", script: /js\.driftt\.com/i, channel: "Conversational sales" },
  { name: "Crisp", category: "CRM and chat", script: /client\.crisp\.chat/i },
  { name: "Tawk.to", category: "CRM and chat", script: /embed\.tawk\.to/i },
  { name: "Zendesk", category: "Support", script: /static\.zdassets\.com/i },
  { name: "Freshworks", category: "Support", script: /freshworks\.com|freshchat\.com/i },
  { name: "Salesforce", category: "CRM and chat", script: /force\.com|salesforceliveagent\.com/i },
  { name: "Clearbit", category: "Personalization", script: /tag\.clearbitscripts\.com|reveal\.clearbit\.com/i, channel: "Account-based marketing" },
  { name: "6sense", category: "Personalization", script: /j\.6sc\.co/i, channel: "Account-based marketing" },
  { name: "RB2B or visitor identification", category: "Personalization", script: /reb2b\.js|rb2b\.com/i, channel: "Outbound to identified visitors" },
  // Testing and personalization
  { name: "Optimizely", category: "A/B testing", script: /cdn\.optimizely\.com/i },
  { name: "VWO", category: "A/B testing", script: /dev\.visualwebsiteoptimizer\.com/i },
  { name: "LaunchDarkly", category: "A/B testing", script: /launchdarkly/i },
  // CMS and site builders
  { name: "WordPress", category: "CMS", html: /\/wp-content\/|\/wp-includes\//i },
  { name: "Webflow", category: "Site builder", html: /data-wf-site=|webflow\.(js|css)/i },
  { name: "Framer", category: "Site builder", html: /framerusercontent\.com|data-framer-/i },
  { name: "Wix", category: "Site builder", html: /static\.wixstatic\.com|wix-bolt/i },
  { name: "Squarespace", category: "Site builder", html: /static1\.squarespace\.com/i },
  { name: "Ghost", category: "CMS", html: /content="Ghost \d|ghost\.io/i },
  { name: "Contentful", category: "CMS", html: /images\.ctfassets\.net/i },
  { name: "Sanity", category: "CMS", html: /cdn\.sanity\.io/i },
  { name: "HubSpot CMS", category: "CMS", header: ["x-hs-hub-id", /\d+/] },
  // Commerce and payments
  { name: "Shopify", category: "Ecommerce", html: /cdn\.shopify\.com|Shopify\.theme/i, header: ["x-shopid", /\d+/] },
  { name: "WooCommerce", category: "Ecommerce", html: /woocommerce/i },
  { name: "BigCommerce", category: "Ecommerce", html: /cdn\d*\.bigcommerce\.com/i },
  { name: "Stripe", category: "Payments", script: /js\.stripe\.com/i },
  { name: "Paddle", category: "Payments", script: /cdn\.paddle\.com/i },
  { name: "Chargebee", category: "Payments", script: /js\.chargebee\.com/i },
  { name: "PayPal", category: "Payments", script: /paypal\.com\/sdk\/js|paypalobjects\.com/i },
  // Social proof, referral and affiliate
  { name: "Trustpilot", category: "Reviews", script: /widget\.trustpilot\.com/i, channel: "Review sites (social proof)" },
  { name: "G2 badge", category: "Reviews", html: /g2\.com\/products\/[^"']+\/reviews|g2crowd/i, channel: "Review sites (social proof)" },
  { name: "Capterra badge", category: "Reviews", html: /capterra\.com\/(p|reviews)\//i, channel: "Review sites (social proof)" },
  { name: "Yotpo", category: "Reviews", script: /staticw2\.yotpo\.com|cdn-widgetsrepository\.yotpo\.com/i, channel: "Customer reviews" },
  { name: "Judge.me", category: "Reviews", script: /judge\.me/i, channel: "Customer reviews" },
  { name: "Rewardful", category: "Referral and affiliate", script: /r\.wdfl\.co|rewardful/i, channel: "Affiliate program" },
  { name: "FirstPromoter", category: "Referral and affiliate", script: /firstpromoter\.com/i, channel: "Affiliate program" },
  { name: "PartnerStack", category: "Referral and affiliate", script: /partnerstack|grsm\.io/i, channel: "Partner and affiliate program" },
  { name: "Impact", category: "Referral and affiliate", script: /impactcdn\.com|impact\.com/i, channel: "Affiliate program" },
  { name: "ReferralCandy", category: "Referral and affiliate", script: /referralcandy\.com/i, channel: "Customer referral program" },
  { name: "Friendbuy", category: "Referral and affiliate", script: /friendbuy\.(com|io)/i, channel: "Customer referral program" },
  { name: "Viral Loops", category: "Referral and affiliate", script: /viral-loops\.com/i, channel: "Referral waitlist" },
  // Scheduling, forms and video
  { name: "Calendly", category: "Scheduling", script: /assets\.calendly\.com/i, html: /calendly\.com\/[a-z0-9_-]+/i, channel: "Sales-led (book a call)" },
  { name: "Chili Piper", category: "Scheduling", script: /js\.chilipiper\.com/i, channel: "Sales-led (book a demo)" },
  { name: "Typeform", category: "Forms", script: /embed\.typeform\.com/i },
  { name: "Wistia", category: "Video", script: /fast\.wistia\.(com|net)/i },
  { name: "Vimeo", category: "Video", html: /player\.vimeo\.com\/video/i },
  { name: "YouTube embed", category: "Video", html: /youtube(-nocookie)?\.com\/embed\//i },
  // Consent, hosting, frameworks
  { name: "OneTrust", category: "Consent", script: /cdn\.cookielaw\.org|onetrust/i },
  { name: "Cookiebot", category: "Consent", script: /consent\.cookiebot\.com/i },
  { name: "Cloudflare", category: "Hosting and CDN", header: ["server", /cloudflare/i] },
  { name: "Vercel", category: "Hosting and CDN", header: ["server", /vercel/i] },
  { name: "Netlify", category: "Hosting and CDN", header: ["server", /netlify/i] },
  { name: "Fastly", category: "Hosting and CDN", header: ["x-served-by", /cache-/i] },
  { name: "Amazon CloudFront", category: "Hosting and CDN", header: ["via", /cloudfront/i] },
  { name: "Next.js", category: "Framework", html: /\/_next\/static\//i },
  { name: "Nuxt", category: "Framework", html: /\/_nuxt\//i },
  { name: "Gatsby", category: "Framework", html: /___gatsby/i },
]

export interface TechHit { readonly name: string; readonly category: TechCategory; readonly evidence: string; readonly channel: string | null }
/** Signatures matched on one page: the page source, its script addresses and its response headers. */
export const detectTechnologies = (html: string, scripts: ReadonlyArray<string>, headers: Readonly<Record<string, string>>): TechHit[] => {
  const hits: TechHit[] = []
  for (const s of SIGNATURES) {
    const script = s.script ? scripts.find(src => s.script!.test(src)) : undefined
    const header = s.header && s.header[1].test(headers[s.header[0]] ?? "") ? `${s.header[0]} header` : undefined
    const inPage = !script && !header && (s.html?.test(html) || (s.script ? s.script.test(html) : false))
    if (script || header || inPage) hits.push({ name: s.name, category: s.category, channel: s.channel ?? null,
      evidence: script ? `script ${new URL(script).host}` : header ?? "page source" })
  }
  return hits
}

// Public DNS: mail providers and the verification records SaaS tools ask a domain owner to publish.
export const MAIL_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/google(mail)?\.com$|googlemail\.com$|aspmx/i, "Google Workspace"], [/protection\.outlook\.com$|outlook\.com$/i, "Microsoft 365"],
  [/zoho\.(com|eu|in)$/i, "Zoho Mail"], [/protonmail\.ch$|proton\.me$/i, "Proton Mail"], [/messagingengine\.com$/i, "Fastmail"],
  [/mimecast\.com$/i, "Mimecast"], [/pphosted\.com$/i, "Proofpoint"], [/secureserver\.net$/i, "GoDaddy email"],
]
export const TXT_SIGNALS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^google-site-verification=/i, "Google Search Console", "Search"], [/^facebook-domain-verification=/i, "Meta Business Manager", "Paid social"],
  [/^MS=ms\d+/i, "Microsoft 365", "Workplace"], [/^atlassian-domain-verification=/i, "Atlassian", "Workplace"], [/^apple-domain-verification=/i, "Apple Business", "Workplace"],
  [/^docusign=/i, "DocuSign", "Sales"], [/^adobe-idp-site-verification=/i, "Adobe", "Workplace"], [/^stripe-verification=/i, "Stripe", "Payments"],
  [/^hubspot-developer-verification=|hubspot/i, "HubSpot", "Marketing automation"], [/^ZOOM_verify_/i, "Zoom", "Workplace"],
  [/^slack-domain-verification=/i, "Slack", "Workplace"], [/^miro-verification=/i, "Miro", "Workplace"], [/^notion-domain-verification=/i, "Notion", "Workplace"],
  [/^canva-site-verification=/i, "Canva", "Marketing"], [/^pinterest-site-verification=|^p:domain_verify/i, "Pinterest", "Paid social"],
  [/^tiktok-developers-site-verification=|^tiktok-domain-verification=/i, "TikTok", "Paid social"], [/^yandex-verification:/i, "Yandex Webmaster", "Search"],
  [/^ahrefs-site-verification_/i, "SEO tooling", "Search"], [/^semrush-site-verification/i, "SEO tooling", "Search"],
]
export const SPF_SENDERS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/_spf\.google\.com/i, "Google Workspace", "Workplace"], [/spf\.protection\.outlook\.com/i, "Microsoft 365", "Workplace"],
  [/sendgrid\.net/i, "SendGrid", "Email sending"], [/mailgun\.org/i, "Mailgun", "Email sending"], [/amazonses\.com/i, "Amazon SES", "Email sending"],
  [/servers\.mcsv\.net|mcsv\.net/i, "Mailchimp", "Email marketing"], [/spf\.mandrillapp\.com/i, "Mailchimp Transactional", "Email sending"],
  [/_spf\.salesforce\.com/i, "Salesforce", "CRM"], [/mktomail\.com/i, "Marketo", "Marketing automation"], [/hubspotemail\.net|hubspot/i, "HubSpot", "Marketing automation"],
  [/zendesk\.com/i, "Zendesk", "Support"], [/customeriomail\.com|customer\.io/i, "Customer.io", "Lifecycle email"], [/klaviyo/i, "Klaviyo", "Email marketing"],
  [/intercom\.io/i, "Intercom", "Support"], [/freshdesk\.com/i, "Freshdesk", "Support"], [/postmarkapp\.com|mtasv\.net/i, "Postmark", "Email sending"],
  [/sparkpostmail\.com/i, "SparkPost", "Email sending"], [/brevo|sendinblue/i, "Brevo", "Email marketing"], [/activecampaign|acems\d*\.com/i, "ActiveCampaign", "Email marketing"],
]
export const NS_HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/cloudflare\.com$/i, "Cloudflare DNS"], [/awsdns/i, "Amazon Route 53"], [/googledomains\.com$|google\.com$/i, "Google Cloud DNS"],
  [/azure-dns/i, "Azure DNS"], [/domaincontrol\.com$/i, "GoDaddy DNS"], [/nsone\.net$/i, "NS1"], [/vercel-dns\.com$/i, "Vercel DNS"], [/netlify/i, "Netlify DNS"],
]
