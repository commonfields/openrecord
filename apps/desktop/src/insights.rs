//! What the Overview shows for one business, read from the endpoints the web
//! Overview uses (`routes/today.tsx` and the panels it renders). Each part
//! loads on its own, so one missing account or failed call leaves the rest.

use serde_json::Value;

use crate::api::{ApiError, ApiResult, Client, enc};

/// The Overview's sections, in the web sidebar's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Summary,
    Performance,
    Revenue,
    Funnel,
    Events,
    Realtime,
    Answers,
}

impl Section {
    pub const ALL: [Section; 7] =
        [Section::Summary, Section::Performance, Section::Revenue, Section::Funnel, Section::Events, Section::Realtime, Section::Answers];

    pub fn label(self) -> &'static str {
        match self {
            Section::Summary => "Summary",
            Section::Performance => "Performance",
            Section::Revenue => "Revenue",
            Section::Funnel => "Funnel",
            Section::Events => "Events",
            Section::Realtime => "Realtime",
            Section::Answers => "AI discovery",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Section::Summary => "Your goal, work in progress, and decisions that need you.",
            Section::Performance => "Search, advertising and local listing results from connected accounts.",
            Section::Revenue => "Revenue and paying customers reported by Stripe.",
            Section::Funnel => "What you can measure across the customer journey, and what is still missing.",
            Section::Events => "Your saved goal event and its daily measurement history.",
            Section::Realtime => "Live measurement availability for this business.",
            Section::Answers => "What AI assistants say about you, and the visits they send.",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Section::Summary => "summary",
            Section::Performance => "performance",
            Section::Revenue => "revenue",
            Section::Funnel => "funnel",
            Section::Events => "events",
            Section::Realtime => "realtime",
            Section::Answers => "answers",
        }
    }

    /// Whether the period picker applies here, as on the web.
    pub fn has_period(self) -> bool {
        matches!(self, Section::Summary | Section::Events | Section::Answers | Section::Performance | Section::Revenue)
    }
}

/// The periods the web offers. Connected accounts report 28 days for 30.
pub const PERIODS: [u32; 3] = [7, 30, 90];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Verdicts {
    pub supported: i64,
    pub wrong: i64,
    pub partial: i64,
    pub unknown: i64,
    pub unreviewed: i64,
}

impl Verdicts {
    fn read(v: &Value) -> Verdicts {
        Verdicts { supported: n(v, "supported"), wrong: n(v, "wrong"), partial: n(v, "partial"), unknown: n(v, "unknown"), unreviewed: n(v, "unreviewed") }
    }

    pub fn total(&self) -> i64 {
        self.supported + self.wrong + self.partial + self.unknown + self.unreviewed
    }

    /// Supported answers among the judged ones (`accuracy` on the web), if any were judged.
    pub fn accuracy(&self) -> Option<f64> {
        let judged = self.supported + self.wrong + self.partial + self.unknown;
        (judged > 0).then(|| self.supported as f64 / judged as f64)
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Day {
    pub date: String,
    pub checks: i64,
    pub v: Verdicts,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Provider {
    pub name: String,
    pub answers: i64,
    pub prev_answers: i64,
    pub v: Verdicts,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub prompt: String,
    pub checks: i64,
    pub last_checked: Option<String>,
    pub v: Verdicts,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FactRow {
    pub predicate: String,
    pub value: String,
    pub v: Verdicts,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Analytics {
    pub checks: i64,
    pub answers: i64,
    pub failed: i64,
    pub current: Verdicts,
    pub previous: Verdicts,
    pub prev_answers: i64,
    pub daily: Vec<Day>,
    pub providers: Vec<Provider>,
    /// (date, provider, answers) for each provider that answered that day.
    pub provider_daily: Vec<(String, String, i64)>,
    pub questions: Vec<Question>,
    pub facts: Vec<FactRow>,
    pub citations: i64,
    pub attributed: i64,
    pub prev_citations: i64,
    /// Citations per day, aligned with `daily` by date.
    pub citation_days: Vec<(String, i64, i64)>,
}

impl Analytics {
    fn read(v: &Value) -> Analytics {
        let cur = v.get("current").cloned().unwrap_or(Value::Null);
        let prev = v.get("previous").cloned().unwrap_or(Value::Null);
        let arr = |k: &str| v.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        let cit = v.get("citations").cloned().unwrap_or(Value::Null);
        Analytics {
            checks: n(&cur, "checks"),
            answers: n(&cur, "answers"),
            failed: n(&cur, "failed"),
            current: Verdicts::read(&cur),
            previous: Verdicts::read(&prev),
            prev_answers: n(&prev, "answers"),
            daily: arr("daily").iter().map(|d| Day { date: s(d, "date"), checks: n(d, "checks"), v: Verdicts::read(d) }).collect(),
            providers: arr("providers")
                .iter()
                .map(|p| Provider { name: s(p, "provider"), answers: n(p, "answers"), prev_answers: n(p, "prev_answers"), v: Verdicts::read(p) })
                .collect(),
            provider_daily: arr("providerDaily").iter().map(|d| (s(d, "date"), s(d, "provider"), n(d, "answers"))).collect(),
            questions: arr("questions")
                .iter()
                .map(|q| Question {
                    prompt: { let l = s(q, "label"); if l.is_empty() { s(q, "prompt") } else { l } },
                    checks: n(q, "checks"),
                    last_checked: o(q, "last_checked_at"),
                    v: Verdicts::read(q),
                })
                .collect(),
            facts: arr("facts").iter().map(|f| FactRow { predicate: s(f, "predicate"), value: s(f, "value_text"), v: Verdicts::read(f) }).collect(),
            citations: n(&cit, "total"),
            attributed: n(&cit, "attributed"),
            prev_citations: n(&cit, "prevTotal"),
            citation_days: cit
                .get("daily")
                .and_then(Value::as_array)
                .map(|d| d.iter().map(|x| (s(x, "date"), n(x, "citations"), n(x, "attributed"))).collect())
                .unwrap_or_default(),
        }
    }
}

/// The business's saved goal and its daily history.
#[derive(Debug, Clone, PartialEq)]
pub struct Goal {
    pub statement: String,
    pub label: String,
    pub event_name: Option<String>,
    pub counting: String,
    pub time_zone: Option<String>,
    /// (date, value) for the current period then the one before it; missing days are absent, not zero.
    pub points: Vec<(String, f64)>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Initiative {
    pub title: String,
    pub status: String,
    pub progress: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Health {
    pub sources: usize,
    pub in_sync: usize,
    pub drift: usize,
    pub inspected: bool,
    pub open_findings: i64,
    pub urls_inspected: i64,
    pub verified_fixes: i64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Discovery {
    /// The latest measured period: surface, reviewed, mention and owned-citation rates as "n of d".
    pub period: Option<(String, String, String, String, String)>,
    /// The latest GA4 import: AI sessions, total sessions, its dates, and signups when measured.
    pub referral: Option<(f64, f64, String, Option<f64>)>,
    pub limitations: Vec<String>,
}

/// One connected account's numbers for the period, as label/value pairs, with what changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Metric {
    pub label: String,
    pub value: String,
    pub delta: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub title: String,
    pub subtitle: String,
    pub metrics: Vec<Metric>,
    /// A ranked table: header, then rows of (name, value columns).
    pub table: Option<(Vec<String>, Vec<Vec<String>>)>,
    pub note: Option<String>,
}

/// A source the Performance or Revenue section reads: connected with numbers, or why not.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    NotConnected(String),
    Reports(Vec<Report>),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Insights {
    pub days: u32,
    pub analytics: Result<Analytics, String>,
    pub goal: Result<Option<Goal>, String>,
    pub initiatives: Vec<Initiative>,
    pub health: Health,
    pub discovery: Result<Option<Discovery>, String>,
    pub search: Source,
    pub ads: Source,
    pub local: Source,
    pub revenue: Source,
    /// Stripe's numbers, read for the Revenue section's own charts.
    pub revenue_data: Option<RevenueData>,
}

/// One period of revenue in the main currency, and the period before.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RevenueData {
    pub account: String,
    pub subtitle: String,
    pub currency: String,
    /// (this period, the period before)
    pub net: (f64, f64),
    pub gross: (f64, f64),
    pub refunded: (f64, f64),
    pub orders: (f64, f64),
    pub average: (Option<f64>, Option<f64>),
    pub paying: (f64, f64),
    pub new_customers: (Option<f64>, Option<f64>),
    /// Each day: its date and net revenue; and the period before, day by day.
    pub daily: Vec<(String, f64)>,
    pub before: Vec<f64>,
    pub note: Option<String>,
}

fn revenue_data_of(v: &Value) -> Option<RevenueData> {
    let (c, p) = (totals(v, "current"), totals(v, "previous"));
    let first = |t: &Value| t.get("byCurrency").and_then(Value::as_array).and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
    let (cc, pc) = (first(&c), first(&p));
    let currency = s(&cc, "currency");
    let pc = if s(&pc, "currency") == currency { pc } else { Value::Null };
    let pair = |a: &Value, b: &Value, k: &str| (f(a, k).unwrap_or(0.0), f(b, k).unwrap_or(0.0));
    let days = |t: &Value| t.get("daily").and_then(Value::as_array).cloned().unwrap_or_default();
    let daily: Vec<(String, f64)> = days(&c).iter().map(|d| (s(d, "day"), f(d, "net").unwrap_or(0.0))).collect();
    if daily.is_empty() && currency.is_empty() {
        return None;
    }
    Some(RevenueData {
        account: s(v, "accountName"),
        subtitle: format!("{}{}", window(v), if v.get("livemode").and_then(Value::as_bool) == Some(false) { ", test mode" } else { "" }),
        currency: currency.to_uppercase(),
        net: pair(&cc, &pc, "net"),
        gross: pair(&cc, &pc, "gross"),
        refunded: pair(&cc, &pc, "refunded"),
        orders: pair(&cc, &pc, "orders"),
        average: (f(&cc, "averageOrder"), f(&pc, "averageOrder")),
        paying: pair(&c, &p, "payingCustomers"),
        new_customers: (f(&c, "newCustomers"), f(&p, "newCustomers")),
        daily,
        before: days(&p).iter().map(|d| f(d, "net").unwrap_or(0.0)).collect(),
        note: c.get("truncated").and_then(Value::as_bool).filter(|t| *t).map(|_| "More charges than OpenRecord reads at once; totals cover the first 3,000.".to_string()),
    })
}

fn n(v: &Value, k: &str) -> i64 {
    match v.get(k) {
        Some(Value::Number(x)) => x.as_i64().unwrap_or_else(|| x.as_f64().unwrap_or(0.0) as i64),
        Some(Value::String(x)) => x.parse().unwrap_or(0),
        _ => 0,
    }
}

fn f(v: &Value, k: &str) -> Option<f64> {
    match v.get(k)? {
        Value::Number(x) => x.as_f64(),
        Value::String(x) => x.parse().ok(),
        _ => None,
    }
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(x)) => x.to_string(),
        _ => String::new(),
    }
}

fn o(v: &Value, k: &str) -> Option<String> {
    let x = s(v, k);
    (!x.is_empty()).then_some(x)
}

/// A whole number with thousands separators.
pub fn int(x: f64) -> String {
    let neg = x < 0.0;
    let digits = format!("{:.0}", x.abs());
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if neg { format!("-{out}") } else { out }
}

pub fn money(x: f64, currency: &str) -> String {
    let sym = match currency.to_uppercase().as_str() {
        "USD" | "" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        _ => "",
    };
    let whole = int(x.trunc());
    let cents = ((x.abs().fract()) * 100.0).round() as i64 % 100;
    if sym.is_empty() { format!("{whole}.{cents:02} {}", currency.to_uppercase()) } else { format!("{sym}{whole}.{cents:02}") }
}

pub fn pct(x: f64) -> String {
    format!("{:.0}%", x * 100.0)
}

fn change(cur: f64, prev: f64) -> Option<f64> {
    (prev > 0.0).then(|| (cur - prev) / prev)
}

/// Connected accounts report fixed windows: 30 days is read as their 28.
fn account_days(days: u32) -> u32 {
    if days == 30 { 28 } else { days }
}

fn iso_day(days_ago: i64) -> String {
    crate::format::iso_date(crate::format::now() - days_ago * 86_400)
}

impl Client {
    /// Everything the Overview shows for a business, over `days`.
    pub fn insights(&self, business: &str, days: u32) -> ApiResult<Insights> {
        let b = enc(business);
        let quiet = |r: ApiResult<Value>| match r {
            Err(ApiError::Unauthorized) => Err(ApiError::Unauthorized),
            other => Ok(other),
        };
        let analytics = quiet(self.get::<Value>(&format!("/api/businesses/{b}/analytics?days={days}")))?
            .map(|v| Analytics::read(v.get("analytics").unwrap_or(&Value::Null)))
            .map_err(|e| e.message());
        let goal = match quiet(self.get::<Value>(&format!("/api/growth/clients/{b}")))? {
            Ok(v) => Ok(self.goal(&b, &v, days)),
            Err(ApiError::Status(404, _)) => Ok(None),
            Err(e) => Err(e.message()),
        };
        let initiatives = quiet(self.get::<Value>(&format!("/api/growth/clients/{b}/opportunities")))?
            .ok()
            .and_then(|v| v.get("opportunities").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .map(|x| Initiative { title: s(x, "title"), status: s(x, "status"), progress: s(x, "progress") })
            .collect();
        let mut health = Health::default();
        if let Ok(v) = quiet(self.get::<Value>(&format!("/api/businesses/{b}/representations")))? {
            let reps = v.get("representations").and_then(Value::as_array).cloned().unwrap_or_default();
            let state = |r: &Value| r.get("finding").map(|f| s(f, "state")).unwrap_or_default();
            health.sources = reps.len();
            health.in_sync = reps.iter().filter(|r| state(r) == "IN_SYNC").count();
            health.drift = reps.iter().filter(|r| state(r) == "DRIFT").count();
        }
        if let Ok(v) = quiet(self.get::<Value>(&format!("/api/businesses/{b}/search/overview")))? {
            let ov = v.get("overview").cloned().unwrap_or(Value::Null);
            health.inspected = ov.get("lastInspection").is_some_and(|x| !x.is_null());
            health.open_findings = n(&ov, "openFindings");
            health.urls_inspected = n(&ov, "urlsInspected");
            health.verified_fixes = n(&ov, "verifiedFixes");
        }
        let discovery = match quiet(self.get::<Value>(&format!("/api/acquisition/clients/{b}/report")))? {
            Ok(v) => Ok(v.get("report").map(discovery)),
            Err(ApiError::Status(404, _)) => Ok(None),
            Err(e) => Err(e.message()),
        };
        let ad = account_days(days);
        let search = match quiet(self.get::<Value>(&format!("/api/growth/clients/{b}/search-console/performance?days={ad}")))? {
            Ok(v) => Source::Reports(v.get("performance").map(search_report).into_iter().collect()),
            Err(ApiError::Status(409, body)) if body.contains("NotBound") || body.contains("NotConnected") => {
                Source::NotConnected("Connect Google Search Console on the web to see clicks, impressions and the queries that find you.".into())
            }
            Err(e) => Source::Failed(e.message()),
        };
        let ads = match quiet(self.get::<Value>(&format!("/api/ads/clients/{b}/performance?days={ad}")))? {
            Ok(v) => {
                let list: Vec<Report> = v.get("accounts").and_then(Value::as_array).map(|a| a.iter().map(ad_report).collect()).unwrap_or_default();
                if list.is_empty() { Source::NotConnected("Connect Google Ads or Meta on the web to see spend, clicks and conversions.".into()) } else { Source::Reports(list) }
            }
            Err(e) => Source::Failed(e.message()),
        };
        let local = match quiet(self.get::<Value>(&format!("/api/ads/clients/{b}/local?days={ad}")))? {
            Ok(v) => {
                let list: Vec<Report> = v.get("locations").and_then(Value::as_array).map(|a| a.iter().map(local_report).collect()).unwrap_or_default();
                if list.is_empty() { Source::NotConnected("Connect a Google Business Profile on the web to see calls, direction requests and reviews.".into()) } else { Source::Reports(list) }
            }
            Err(e) => Source::Failed(e.message()),
        };
        let mut revenue_data = None;
        let revenue = match quiet(self.get::<Value>(&format!("/api/revenue/clients/{b}/performance?days={ad}")))? {
            Ok(v) => match v.get("revenue").filter(|x| !x.is_null()) {
                Some(r) => {
                    revenue_data = revenue_data_of(r);
                    Source::Reports(vec![revenue_report(r)])
                }
                None => Source::NotConnected("Connect Stripe on the web to see paid orders, refunds and paying customers.".into()),
            },
            Err(e) => Source::Failed(e.message()),
        };
        Ok(Insights { days, analytics, goal, initiatives, health, discovery, search, ads, local, revenue, revenue_data })
    }

    fn goal(&self, b: &str, profile: &Value, days: u32) -> Option<Goal> {
        let p = profile.get("profile")?;
        let g = p.get("primaryGoal")?;
        let m = g.get("metricDefinition")?;
        let id = s(m, "id");
        let mut goal = Goal {
            statement: s(g, "statement"),
            label: s(m, "label"),
            event_name: o(m, "eventName"),
            counting: s(m, "countingSemantics"),
            time_zone: o(m, "reportingTimeZone"),
            points: Vec::new(),
            source: None,
        };
        if !id.is_empty() {
            let path = format!(
                "/api/growth/clients/{b}/metrics/{}/series?start={}&end={}",
                enc(&id),
                iso_day(days as i64 * 2),
                iso_day(1)
            );
            if let Ok(v) = self.get::<Value>(&path) {
                let series = v.get("series").cloned().unwrap_or(Value::Null);
                goal.source = o(&series, "sourceKind");
                let pts = series.get("points").or_else(|| series.get("days")).and_then(Value::as_array).cloned().unwrap_or_default();
                goal.points = pts
                    .iter()
                    .filter_map(|x| Some((o(x, "date").or_else(|| o(x, "day"))?, f(x, "value")?)))
                    .collect();
            }
        }
        Some(goal)
    }
}

fn rate(v: Option<&Value>) -> String {
    let Some(v) = v else { return "not measured".into() };
    let (num, den) = (n(v, "n"), n(v, "d"));
    if den > 0 { format!("{num} of {den}") } else { "not measured".into() }
}

fn discovery(r: &Value) -> Discovery {
    let period = r.get("periods").and_then(Value::as_array).and_then(|p| p.last()).map(|p| {
        let m = p.get("metrics").cloned().unwrap_or(Value::Null);
        let range = format!(
            "{} to {}",
            o(p, "collectedFrom").map(|d| d.chars().take(10).collect()).unwrap_or_else(|| "date unavailable".to_string()),
            o(p, "collectedTo").map(|d| d.chars().take(10).collect()).unwrap_or_else(|| "date unavailable".to_string())
        );
        (s(p, "surface"), rate(m.get("reviewed")), rate(m.get("mentionRate")), rate(m.get("ownedCitationRate")), range)
    });
    let referral = r
        .get("referrals")
        .and_then(|x| x.get("imports"))
        .and_then(Value::as_array)
        .and_then(|imports| imports.iter().max_by_key(|i| s(i, "importedAt")))
        .map(|i| (f(i, "aiSessions").unwrap_or(0.0), f(i, "totalSessions").unwrap_or(0.0), format!("{} to {}", s(i, "dateStart"), s(i, "dateEnd")), f(i, "signups")));
    let limitations = r.get("limitations").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    Discovery { period, referral, limitations }
}

fn totals(v: &Value, side: &str) -> Value {
    v.get(side).and_then(|x| x.get("totals")).cloned().unwrap_or(Value::Null)
}

fn window(v: &Value) -> String {
    let c = v.get("current").cloned().unwrap_or(Value::Null);
    format!("{} to {}", s(&c, "start"), s(&c, "end"))
}

fn metric(label: &str, cur: &Value, prev: &Value, k: &str, fmt: impl Fn(f64) -> String) -> Metric {
    let a = f(cur, k).unwrap_or(0.0);
    Metric { label: label.into(), value: fmt(a), delta: f(prev, k).and_then(|b| change(a, b)) }
}

fn search_report(v: &Value) -> Report {
    let (c, p) = (totals(v, "current"), totals(v, "previous"));
    let rows = v
        .get("topQueries")
        .and_then(Value::as_array)
        .map(|q| {
            q.iter()
                .take(10)
                .map(|r| vec![s(r, "key"), int(f(r, "clicks").unwrap_or(0.0)), int(f(r, "impressions").unwrap_or(0.0)), pct(f(r, "ctr").unwrap_or(0.0))])
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Report {
        title: "Google Search".into(),
        subtitle: format!("{}, {}", s(v, "siteUrl"), window(v)),
        metrics: vec![
            metric("Clicks", &c, &p, "clicks", int),
            metric("Impressions", &c, &p, "impressions", int),
            metric("Click-through rate", &c, &p, "ctr", pct),
            Metric { label: "Average position".into(), value: f(&c, "position").map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into()), delta: None },
        ],
        table: (!rows.is_empty()).then(|| (vec!["Top queries".into(), "Clicks".into(), "Impressions".into(), "CTR".into()], rows)),
        note: None,
    }
}

fn ad_report(v: &Value) -> Report {
    let (c, p) = (totals(v, "current"), totals(v, "previous"));
    let cur = s(v, "currency");
    let provider = match s(v, "provider").as_str() {
        "google_ads" => "Google Ads",
        "meta" => "Meta ads",
        other => other,
    }
    .to_string();
    let rows = v
        .get("topCampaigns")
        .and_then(Value::as_array)
        .map(|q| {
            q.iter()
                .take(10)
                .map(|r| vec![s(r, "name"), money(f(r, "spend").unwrap_or(0.0), &cur), int(f(r, "clicks").unwrap_or(0.0)), format!("{:.1}", f(r, "conversions").unwrap_or(0.0))])
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let m = |x: f64| money(x, &cur);
    Report {
        title: format!("{provider}: {}", s(v, "accountName")),
        subtitle: window(v),
        metrics: vec![
            metric("Spend", &c, &p, "spend", m),
            metric("Clicks", &c, &p, "clicks", int),
            metric("Conversions", &c, &p, "conversions", |x| format!("{x:.1}")),
            metric("Cost per conversion", &c, &p, "costPerConversion", m),
        ],
        table: (!rows.is_empty()).then(|| (vec!["Campaigns".into(), "Spend".into(), "Clicks".into(), "Conversions".into()], rows)),
        note: o(v, "conversionDefinition").map(|d| format!("Conversions as this platform counts them: {d}")),
    }
}

fn local_report(v: &Value) -> Report {
    let (c, p) = (totals(v, "current"), totals(v, "previous"));
    let reviews = v.get("reviews").filter(|x| !x.is_null());
    let note = reviews.map(|r| {
        format!(
            "{} reviews, average {}, {} unanswered.",
            n(r, "total"),
            f(r, "averageRating").map(|x| format!("{x:.1}")).unwrap_or_else(|| "not available".into()),
            n(r, "unanswered")
        )
    });
    Report {
        title: format!("Google Business Profile: {}", s(v, "locationName")),
        subtitle: window(v),
        metrics: vec![
            metric("Calls", &c, &p, "calls", int),
            metric("Website clicks", &c, &p, "websiteClicks", int),
            metric("Direction requests", &c, &p, "directionRequests", int),
            metric("Profile views", &c, &p, "impressions", int),
        ],
        table: None,
        note,
    }
}

fn revenue_report(v: &Value) -> Report {
    let (c, p) = (totals(v, "current"), totals(v, "previous"));
    let mut metrics = Vec::new();
    let prev_by = p.get("byCurrency").and_then(Value::as_array).cloned().unwrap_or_default();
    for cur in c.get("byCurrency").and_then(Value::as_array).cloned().unwrap_or_default() {
        let code = s(&cur, "currency");
        let before = prev_by.iter().find(|x| s(x, "currency") == code).cloned().unwrap_or(Value::Null);
        let key = if cur.get("net").is_some() { "net" } else { "gross" };
        metrics.push(metric(&format!("Revenue ({})", code.to_uppercase()), &cur, &before, key, |x| money(x, &code)));
    }
    metrics.push(metric("Paying customers", &c, &p, "payingCustomers", int));
    if c.get("newCustomers").is_some_and(|x| !x.is_null()) {
        metrics.push(metric("New customers", &c, &p, "newCustomers", int));
    }
    Report {
        title: format!("Stripe: {}", s(v, "accountName")),
        subtitle: format!("{}{}", window(v), if v.get("livemode").and_then(Value::as_bool) == Some(false) { ", test mode" } else { "" }),
        metrics,
        table: None,
        note: c.get("truncated").and_then(Value::as_bool).filter(|t| *t).map(|_| "More charges than OpenRecord reads at once; totals cover the first 3,000.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_analytics() {
        let a = Analytics::read(&json!({
            "current": { "checks": 7, "answers": 6, "failed": 0, "supported": 3, "wrong": 2, "partial": 0, "unknown": 2, "unreviewed": 0 },
            "previous": { "checks": 0, "answers": 0, "supported": 0 },
            "daily": [{ "date": "2026-11-10", "checks": 1, "supported": 1 }],
            "providers": [{ "provider": "mock", "answers": 4, "prev_answers": 0, "supported": 3, "wrong": 2 }],
            "questions": [{ "prompt": "How much?", "label": null, "checks": 1, "wrong": 1 }],
            "facts": [], "citations": { "total": 1, "attributed": 1, "prevTotal": 0, "daily": [] }
        }));
        assert_eq!((a.checks, a.current.total(), a.daily.len(), a.providers[0].name.as_str()), (7, 7, 1, "mock"));
        assert_eq!(a.current.accuracy().map(|x| (x * 100.0).round()), Some(43.0));
        assert_eq!(a.questions[0].prompt, "How much?");
    }

    #[test]
    fn formats_numbers() {
        assert_eq!(int(1234567.0), "1,234,567");
        assert_eq!(money(1234.5, "usd"), "$1,234.50");
        assert_eq!(money(10.0, "SEK"), "10.00 SEK");
        assert_eq!(pct(0.4286), "43%");
        assert_eq!(account_days(30), 28);
    }

    #[test]
    fn reads_reports() {
        let r = search_report(&json!({ "siteUrl": "sc-domain:x.com", "current": { "start": "a", "end": "b", "totals": { "clicks": 120, "impressions": 4000, "ctr": 0.03, "position": 8.24 } },
            "previous": { "totals": { "clicks": 100, "impressions": 3000, "ctr": 0.033, "position": 9.0 } }, "topQueries": [{ "key": "pricing", "clicks": 10, "impressions": 100, "ctr": 0.1 }] }));
        assert_eq!(r.metrics[0].delta.map(|d| (d * 100.0).round()), Some(20.0));
        assert_eq!(r.metrics[3].value, "8.2");
        assert_eq!(r.table.unwrap().1[0][0], "pricing");
    }
}
