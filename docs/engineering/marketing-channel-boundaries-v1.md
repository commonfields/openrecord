# Marketing channel boundaries (v1)

Status: decision record, W8. No adapter in this document is implemented except
GitHub (W7) and the read-only GA4 measurement source (W8).

OpenRecord keeps three things apart, for every channel:

| Concept | Meaning | Examples |
| --- | --- | --- |
| **Marketing destination** | Where approved work is carried out | website/CMS, Facebook Page, Instagram account, Google Business Profile, X account, ad account, email platform |
| **Measurement source** | Where performance data is read from | GA4, booking system, CRM, an ad platform's reporting |
| **Business outcome** | What the business cares about | leads, bookings, signups, purchases |

A destination's own statistics (likes, impressions, ad clicks) are *channel
metrics*, not business outcomes. A measurement source is never the control
plane. The W0 metric definition, not the provider, says what a business
outcome is.

For each channel below, the five questions are the same: how authorization
works, what OpenRecord could execute, what the provider lets OpenRecord
**verify** about that execution, what can be measured, and what limits or
gates access. Facts come from the providers' current developer documentation
(October 2026). Items marked *(verify)* came from secondary sources or
conflicting pages and must be checked against the provider before any build.

## 1. Website / CMS

**GitHub-hosted sites (W7, implemented).** Fine-grained server token per
repository, allowlisted per account. Execution: one branch, one commit, one pull
request; OpenRecord never merges or deploys. Evidence: pull request, head
commit, merge commit and the merged blob, read back from GitHub; then a
separate live-page observation. Measurement: none from GitHub; the site is
measured through GA4 or a booking system. Limit: only sites whose source lives
in a repository the agency controls.

**WordPress (self-hosted).** Authorization: a per-user Application Password
(core since WordPress 5.6), sent over HTTPS to the site's REST API; the
site owner can revoke it at any time from the user profile, and the user's own
role bounds what it can do. No platform-level app review. Execution: create or
update a post or page (`/wp/v2/posts`, `/wp/v2/pages`) as a draft or a
publication. Evidence: the REST response and a later read return the object's
`id`, `status`, `modified_gmt`, `link` and rendered content; the revisions
endpoint returns the stored revision, so the exact approved content can be
compared byte for byte, exactly as W7 compares a merged blob. A live-page
observation (W7's safe fetch) is a separate fact. Measurement: none from
WordPress itself; GA4 or a booking source. Limits: Application Passwords
require HTTPS by default and can be disabled by hosts or security plugins;
SEO plugins keep fields (for example meta descriptions) in post meta that is
not always exposed over REST; caching layers delay the live observation.
WordPress.com sites use a different OAuth API and are out of scope.

**Hosted builders (Wix, Squarespace, Webflow).** Each has its own OAuth app
model and marketplace review *(verify per platform)*. Webflow's CMS API can
publish items and read them back; Squarespace's public content APIs are narrow.
Not a near-term target.

## 2. Facebook Pages

Authorization: Facebook Login for Business; a Page access token obtained by a
user who can perform the `CREATE_CONTENT`, `MANAGE` and `MODERATE` tasks on the
Page. Posting needs `pages_manage_posts` together with `pages_read_engagement`
and related Page permissions. Execution: `POST /{page-id}/feed` (text, link),
photos and videos. Evidence: the returned post id, then `GET /{post-id}` gives
the message, `created_time` and `permalink_url` as Meta stores them, so the
published text can be compared with the approved text. Measurement: Page and
post insights are channel metrics (reach, engagement), not business outcomes.
Limits: Standard (now "Limited") access works only for people with a role on
the app; serving client Pages needs App Review for each permission and Business
Verification *(verify current wording)*. Tokens and Page roles change often;
expect re-authorization.

## 3. Instagram

Authorization: Instagram API with Instagram Login (professional accounts only,
no linked Facebook Page needed) with `instagram_business_basic` and
`instagram_business_content_publish`, or the Facebook-Login variant through a
linked Page. Execution: two-step publish: create a media container from a
**publicly hosted** media URL, then `media_publish`. Single images, videos and
carousels; current publishing docs exclude stories and some reel cases
*(verify; Meta's pages disagree)*. Evidence: the published media id, then the
media object (caption, `permalink`, `timestamp`) read back. Measurement: media
and account insights (channel metrics). Limits: 50 API-published posts per
account per rolling 24 hours (`content_publishing_limit`); App Review for
client accounts; Page Publishing Authorization can block publishing; media must
be hosted where Meta can fetch it, which OpenRecord would have to provide.

## 4. X

Authorization: OAuth 2.0 user context with PKCE (`tweet.write`, `tweet.read`,
`users.read`, `offline.access`). Execution: `POST /2/tweets`. Evidence: the
post id, then a read of the post returns its text and `created_at` as X stores
them. Measurement: public metrics on the post (channel metrics). Limits: since
February 2026 new developers are on pay-per-use pricing, with a per-post charge
that is reported to be much higher for posts containing links *(verify in the
X developer console; secondary sources only)*; per-user and per-app posting
rate limits apply. Pricing volatility makes it a poor first adapter for a small
agency.

## 5. Google Business Profile

Authorization: Google OAuth with the `business.manage` scope (classified as
sensitive, so the OAuth app needs Google verification). Execution: local posts
(updates, offers, events) through the older My Business v4 `localPosts`
surface; business information (hours, attributes) through the Business
Information API. Evidence: the created local post's resource name and state,
and the location's fields read back. Measurement: Business Profile Performance
API daily metrics (calls, direction requests, website clicks): useful, but
still channel metrics. Limits: API access must be applied for; projects start
with zero quota until approved, and reviewers reportedly expect a profile that
has been verified and active for 60 days *(verify)*. Very valuable for local
businesses, but the access gate is outside OpenRecord's control.

## 6. Paid media: Meta Ads and Google Ads

**Meta Marketing API.** `ads_management` / `ads_read`. Limited (formerly
Standard) access is for an app's own ad accounts and is heavily rate-limited;
managing clients' ad accounts needs Full (formerly Advanced) access through App
Review, with a usage threshold and Business Verification for users without an
app role. Execution: create and update campaigns, ad sets, ads, budgets.
Evidence: object ids and effective status read back. Measurement: the Insights
API (spend, impressions, clicks, platform-attributed conversions).

**Google Ads API.** OAuth (`adwords` scope) plus project-level API access;
Test access cannot touch production accounts, Basic access has a daily
operation cap, Standard access is unlimited. Google is moving access decisions
from developer tokens to the Cloud project during 2026 *(verify the current
policy page)*. Execution: mutate campaigns, ad groups, ads, budgets. Evidence:
resource names and fields read back with GAQL; change history. Measurement:
GAQL reporting.

Both: spending money is a different risk class from publishing content. A paid
adapter needs budget ceilings, spend authorization and reconciliation that W7
does not have. Platform-reported conversions are attributed by the platform's
own model and must never be presented as the business outcome. Not a near-term
target.

## 7. Email campaigns

**Mailchimp Marketing API.** OAuth 2 for third-party apps, or an account API
key; the OAuth grant is account-wide rather than scoped *(verify)*. Execution:
create a campaign, set content, schedule or send. Evidence: campaign id, status
(`sent`), `send_time`, recipient count and the stored content read back.
Measurement: campaign reports (opens, clicks, bounces): channel metrics, with
opens distorted by mail privacy protection.

**Klaviyo.** OAuth apps with granular scopes (for example campaign read and
write) *(verify)*. Similar execution and evidence.

Limits: sending to a list is irreversible and consent-sensitive; list hygiene
and sender reputation belong to the client. A send adapter would need a second,
explicit "send now" authorization beyond approving the content.

## 8. Measurement sources

**GA4 (W8, implemented read-only).** Google OAuth (`openid email
analytics.readonly`), state and PKCE, exact redirect URI. The Admin API lists
the properties the authorizing identity can read and their key events; the
Data API reports `keyEvents` per day in the property's time zone. A connection
records *who allowed read access*, not who owns the property. Limits:
`analytics.readonly` is a Google API scope that needs OAuth consent-screen
configuration and, for a public app, Google's verification (an unverified app
shows a warning and is capped at 100 new users); property token quotas; recent
days can be revised; thresholding and sampling can make a report inexact (W8
refuses sampled answers).

**Booking systems and CRMs.** The business outcome often lives here (a booking,
a qualified lead). Each has its own API (Calendly, Square Appointments,
HubSpot, Pipedrive). Until one is connected, the W3 operator CSV path carries
these outcomes; its provenance stays `OPERATOR_SUPPLIED_EXPORT`.

## 9. Comparison

| Channel | Authorization gate | Execution OpenRecord could do | Provider-verifiable evidence | Measurement | Main limit |
| --- | --- | --- | --- | --- | --- |
| GitHub site (W7) | Server token + allowlist | PR with exact change | PR, merge commit, merged blob | none (use GA4) | site must live in a repo |
| WordPress | Per-user Application Password | create/update post or page | object + revision read back, byte-comparable | none (use GA4) | HTTPS; plugins may disable |
| Facebook Page | App Review + Business Verification | post to feed | post id, message, permalink | Page insights | review gate, token churn |
| Instagram | App Review (professional accounts) | publish image/carousel | media id, caption, permalink | media insights | 50 posts/24 h, hosted media |
| X | Paid API, OAuth 2 PKCE | post | post id, text | public metrics | per-post pricing |
| Google Business Profile | API access application, sensitive scope | local post, business info | post resource, fields read back | Performance API | access approval, zero quota until approved |
| Meta / Google Ads | App Review / API access level | campaigns, budgets | object state, change history | platform reporting | spend risk |
| Email (Mailchimp/Klaviyo) | OAuth app | create, schedule, send | campaign status, send time, content | opens/clicks | irreversible send |

## 10. Decision: the next execution adapter

**WordPress page and post updates** should follow W8.

- **Agency fit.** Most small-business sites an agency maintains are
  WordPress; landing-page copy, service pages, offers and FAQs are the most
  common approved website changes. GitHub covers only the minority of sites
  kept in a repository.
- **Practical access.** An Application Password is created by the site's own
  administrator in minutes, is bounded by that user's role, and is revocable
  from the site. There is no platform app review, business verification or
  paid tier to clear, unlike Meta, X or Google Business Profile.
- **Independently verifiable.** WordPress returns the stored object and its
  revision, so OpenRecord can prove that exactly the approved content was
  saved (the W7 standard), and the existing safe live-page check can then
  observe it as a separate fact.
- **Measurable against business outcomes.** Website changes are measured by
  the W8 GA4 connection and booking/lead sources, with no reliance on platform
  vanity metrics.

It would reuse W7's operation lifecycle, authorization-by-hash, job table,
three facts and initiative hold, and supply its own exact-change builder
(content and status of one post or page), transport, read-back verification and
a receipt claim of its own (not `PR_MERGED`).

Second candidate: **Google Business Profile local posts**, once API access is
approved for the project. It is high value for local service businesses, but
the access gate cannot be planned around.

Not now: Meta Pages and Instagram (App Review and Business Verification before
any client use), X (pricing), paid media (spend risk), email sending
(irreversible).

## 11. No generic connector SDK yet

GitHub (execution) and GA4 (measurement) are genuinely different: one writes
an exact change and verifies it, the other reads aggregates and reconciles
revisions. What they share today is small and already shared in code: OAuth
or token storage under deployment-managed encryption (W8 cipher), durable
PostgreSQL jobs with leases and bounded retries, and append-only evidence. A
connector interface will be drawn after a second *execution* adapter
(WordPress) shows which parts of W7's lifecycle are truly provider-neutral.
