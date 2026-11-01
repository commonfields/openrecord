# Market research v1

OpenRecord's agent researches other companies and AI answers with its own code. It uses no outside research service. Every source is one of these:

- public websites, read through the agent's SSRF-safe fetcher where robots.txt allows OpenRecord's agent;
- documented public endpoints on a fixed host allow-list (the public web archive, domain registries located through IANA's RDAP bootstrap, public feeds and public job boards);
- public DNS;
- OpenRecord's own page snapshots;
- the business's own connected accounts (Meta, for the ad library) and the AI subscriptions its team connected through the bridge;
- server logs the team uploads.

## Agent tools

| Tool | Effect | What it does |
|---|---|---|
| `cross_source_marketing_investigation` | read | Shows which capabilities are available now and why any are not, the research already saved, the internal evidence to read, and the method. The method is competing explanations, SEEN/ESTIMATED/INFERRED labels, then propose, ask, keep investigating or recommend no action. |
| `find_research_capabilities` | read | Finds capabilities for a need, with each one's input schema and availability. |
| `run_research` | record, deduplicated | Runs one capability for a stated question and saves the result as a research observation. |
| `read_research_evidence` | read | Saved research, listed or one observation. |
| `research_timeline` | read | Every dated event saved for a company, merged in date order. |

## Capabilities

| Area | Capability ids |
|---|---|
| Website | `site.profile`, `site.technologies` (including advertising pixels and the channels they imply), `site.content`, `site.keywords`, `site.pricing`, `site.partners`, `site.growth_signals` |
| History | `page.snapshot`, `page.changes`, `site.history`, `archive.compare` |
| Company | `domain.registration`, `domain.dns`, `company.jobs` |
| Social and community | `social.youtube`, `social.bluesky`, `community.hackernews` |
| Advertising and search | `ads.meta_library` (business's own Meta connection), `search.results` (the server's configured web search) |
| AI visibility | `ai.answers` (the team's own subscriptions), `ai.visibility`, `ai.citations`, `ai.fact_check`, `ai.traffic` (uploaded logs) |

The catalog (`apps/api/src/research/catalog.ts`) is closed: `run_research` runs only these ids, and each capability decodes its own input with excess properties refused.

## Endpoint catalog (official and public APIs)

`apps/api/src/research/endpoints/` describes read-only calls to documented official and public APIs as data: a provider (hosts, authentication) and endpoints (typed input, request, parser). One executor runs every endpoint the same way:
- a pinned SSRF-safe connection to the provider's own hosts only, with no redirects followed and a size cap;
- the credential injected on the server and scrubbed from anything returned;
- stable failure reasons;
- a saved research observation.

Endpoints join the same closed catalog as the native capabilities and run through `run_research`.

| Access | Providers |
|---|---|
| Public | App Store and podcasts; GitHub; npm; PyPI; Docker Hub; Wikipedia pageviews and summaries; Wikidata facts; SEC EDGAR filings and reported revenue (needs `RESEARCH_CONTACT`) |
| The business's own account, connected on Channels | Google Cloud key (YouTube Data, Chrome real-user metrics); PageSpeed (optional key); Reddit (its own app); Product Hunt (its own token); Bing Webmaster (its own site); GitHub token (optional) |
| The business's own paid account, off until connected | SEO data: ranked keywords, search volume, keyword ideas, results pages, backlinks, referring domains, competing domains, estimated traffic history, domain overviews |

Credentials live in `research_connections` (migration 0062):
- encrypted with the deployment's token cipher and bound to the business and provider;
- checked for format on save;
- never returned;
- cleared on revoke.

Platforms with no official public API (private app interfaces of social networks, ad libraries without an API, consumer AI apps) are not wrapped.

## Scheduled tracking and uploads

- `ai_answer_schedules` (migration 0061): a person approves the cadence (daily or weekly), up to three connected models, and the exact number of questions per run (at most 8). The questions come from the latest question set.
  - The API's scheduler runs due schedules as the approving person, through `run_research` with `ai.answers`.
  - If the models or the question count no longer match the approval, the schedule pauses until a person approves again.
  - If the share of answers naming the business drops by at least the approved number of points, with four or more answers on each side, an investigation opens under the business's growth goal.
  - Routes: `GET`, `PUT /api/businesses/:id/ai-answer-schedule` and `POST .../enabled`. Approval is on the Channels page.
- `POST /api/businesses/:id/ai-traffic-logs` accepts a server access log in common, combined or JSON-lines format, up to 25 MB.
  - Only aggregates are saved, as an `ai.traffic_log` observation, which `ai.traffic` reads.
  - Upload is on the Channels page.

## Evidence and limits

- One row in `research_observations` per run. It holds the capability, subject, the question that justified it, normalized input, status, findings, coverage and observation time.
- The request key is derived from the business, capability, normalized input and UTC day. A repeat on the same day reuses the saved row. A PENDING row blocks a duplicate run for five minutes.
- Runs are capped per business per UTC day (`RESEARCH_DAILY_RUNS`, default 300) and serialized with an advisory lock.
- Public page reads are cached for ten minutes in the API process, so one investigation does not fetch a page once per capability.
- Findings are labelled:
  - SEEN: listed or published on a date.
  - ESTIMATED: a model's number.
  - INFERRED: OpenRecord's reading of seen evidence.
- Not observed, refused and not available read as unknown, never zero.
- Third-party text is shortened, stripped of control characters and returned as quoted data. It never changes what the agent may do.
- Credentials never leave the server. The Meta token is removed from ad snapshot links. Uploaded logs keep only aggregates, with no IP address, raw line or query string.

## What it cannot see

Search volume, a competitor's rankings at scale, its traffic and its backlink totals come from commercial search indexes. OpenRecord reports these as unknown for other companies, and reads the business's own search data through Search Console.

Other limits:
- The ad library API covers EU-delivered and political or issue ads.
- YouTube and job-board feeds show recent items only.
- AI answers are what the team's connected models say through the bridge, not what every assistant user sees.
