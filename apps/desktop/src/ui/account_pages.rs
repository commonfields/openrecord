//! The account menu's pages in the app: Usage, Businesses, and Clients and
//! products, laid out as the web lays them out.

use rune::{Cursor, El, col, el, row, text_input};

use crate::account::{ClientRow, Portfolio, Usage};
use crate::format;
use crate::icons;
use crate::insights::{PERIODS, int};
use crate::state::{App, Load, PortfolioSort};
use crate::theme::{Theme, shadows, type_};
use crate::ui::kit::{self, Column, column};
use crate::ui::widgets::{Variant, button, empty_state, failure, ico, label, page_header, skeleton, status_chip};

fn tokens(v: Option<f64>) -> String {
    match v {
        None => "—".into(),
        Some(x) if x >= 1_000_000.0 => format!("{:.1}M", x / 1_000_000.0),
        Some(x) if x >= 10_000.0 => format!("{:.0}k", x / 1000.0),
        Some(x) => int(x),
    }
}

fn usd(v: Option<f64>) -> String {
    match v {
        None => "—".into(),
        Some(x) if x > 0.0 && x < 0.01 => "<$0.01".into(),
        Some(x) => format!("${x:.2}"),
    }
}

fn head(t: &Theme, title: &str, description: &str, action: Option<El>) -> El {
    row().w_full().gap(16.0).items_start().child(col().grow(1.0).min_w(0.0).child(page_header(t, title, description))).children(action)
}

/// A search field over a list.
fn search(s: &App, t: &Theme, key: &str, placeholder: &str) -> El {
    let input = text_input(&s.list_query, type_::SM_13)
        .key(key.to_string())
        .placeholder(placeholder.to_string(), t.muted_foreground)
        .label(placeholder.to_string())
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.list_query);
    shadows(row().w_full().h(32.0).px(10.0).gap(8.0).radius(8.0).center_y().fill(t.control).child(ico(&icons::SEARCH, 14.0, t.muted_foreground)).child(input), &t.control_shadow)
}

fn matches(s: &App, text_: &str) -> bool {
    text_.to_lowercase().contains(s.list_query.text.trim().to_lowercase().as_str())
}

// ---- Usage -------------------------------------------------------------------------

pub fn usage(s: &App, t: &Theme) -> El {
    let periods = kit::text_tabs(
        t,
        "usage-days",
        PERIODS.iter().map(|d| {
            let d = *d;
            (format!("{d} days"), s.usage_days == d, Box::new(move |s: &mut App| s.set_usage_days(d)) as Box<dyn Fn(&mut App)>)
        }).collect(),
    );
    let top = head(t, "Usage", "What the agent, research providers and AI answer checks used across your account. Token counts are as each provider reported them.", Some(periods));
    let u = match &s.usage {
        Load::Ready(u) => u,
        Load::Failed(e) => return col().w_full().gap(24.0).child(top).child(failure(t, "usage-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(24.0).child(top).child(skeleton(t, 3)),
    };
    col().w_full().gap(16.0).child(top).child(usage_body(t, u))
}

fn usage_body(t: &Theme, u: &Usage) -> El {
    let strip = kit::cols(vec![
        kit::tile(t, "u-turns", "Agent turns", int(u.turns), None, Some(format!("{} tool calls, {} model steps", int(u.tool_calls), int(u.model_steps)))),
        kit::tile(
            t,
            "u-tokens",
            "Tokens",
            tokens(u.tokens),
            None,
            Some(if u.without_counts > 0.0 { format!("{} turns reported none", int(u.without_counts)) } else { format!("{} in, {} out", tokens(u.tokens_in), tokens(u.tokens_out)) }),
        ),
        kit::tile(t, "u-cost", "Estimated model cost", usd(u.usd), None, Some(if u.unpriced > 0.0 { format!("{} turns on unpriced models", int(u.unpriced)) } else { "At this server's prices".into() })),
        kit::tile(t, "u-research", "Research charged", usd(Some(u.research_usd)), None, Some(format!("{} provider calls", int(u.research_calls)))),
        kit::tile(t, "u-answers", "AI answers collected", int(u.answers), None, Some(format!("{} {}", u.checks.len(), if u.checks.len() == 1 { "provider" } else { "providers" }))),
    ]);
    // Agent turns per day, as columns.
    let peak = u.daily.iter().map(|d| d.1).fold(0.0, f64::max).max(1.0);
    let mut bars = row().key("u-daily").w_full().h(160.0).gap(3.0).items_end();
    for (k, (date, n)) in u.daily.iter().enumerate() {
        bars = bars.child(el().key(format!("u-day-{k}")).w(0.0).grow(1.0).h(((n / peak) * 160.0).max(2.0) as f32).radius(3.0).fill(t.chart.primary.alpha(if *n > 0.0 { 0.85 } else { 0.2 })).help(format!("{}: {} {}", format::short_day(date), int(*n), if *n == 1.0 { "turn" } else { "turns" })));
    }
    let axis = row()
        .w_full()
        .child(label(u.daily.first().map(|d| format::short_day(&d.0)).unwrap_or_default(), type_::AXIS, t.chart.axis))
        .child(el().grow(1.0))
        .child(label(u.daily.last().map(|d| format::short_day(&d.0)).unwrap_or_default(), type_::AXIS, t.chart.axis));
    let daily = kit::panel(t, "u-daily-card", "Agent turns per day", Some(format!("Last {} days, peak {}", u.days, int(peak))), None, 0.0, col().w_full().gap(8.0).child(bars).child(axis));

    let nothing = |rows: &Vec<Vec<El>>| rows.is_empty();
    const MODEL: [Column; 5] = [column("Model", 0.0, false), column("Turns", 56.0, true), column("Tokens in", 80.0, true), column("Tokens out", 80.0, true), column("Est. cost", 80.0, true)];
    let rows: Vec<Vec<El>> = u
        .by_model
        .iter()
        .map(|m| {
            vec![
                row()
                    .w_full()
                    .gap(10.0)
                    .center_y()
                    .child(crate::brands::logo(t, &crate::brands::model_brand(&m.model, &m.provider), 22.0))
                    .child(col().min_w(0.0).gap(0.0).child(label(m.model.clone(), type_::SM_MEDIUM, t.foreground).truncate()).child(label(crate::brands::brand(&m.provider).0, type_::XS11, t.muted_foreground))),
                kit::faint(t, int(m.turns)),
                kit::faint(t, tokens(m.tokens_in)),
                kit::faint(t, tokens(m.tokens_out)),
                if m.priced { kit::num(t, usd(m.usd)) } else { kit::faint(t, "Not priced") },
            ]
        })
        .collect();
    let table = |key: &str, cols: &[Column], rows: Vec<Vec<El>>| if nothing(&rows) { kit::note(t, "Nothing in this period.") } else { kit::table(t, key, cols, rows) };
    let by_model = kit::panel(t, "u-models", "By model", Some("Estimated cost only where this server has the model's prices".into()), None, 0.0, table("u-model-table", &MODEL, rows));
    const BIZ: [Column; 4] = [column("Business", 0.0, false), column("Turns", 56.0, true), column("Tokens", 72.0, true), column("Tool calls", 80.0, true)];
    let rows = u.by_business.iter().map(|b| vec![kit::text(t, b.0.clone()), kit::faint(t, int(b.1)), kit::faint(t, tokens(b.2)), kit::faint(t, int(b.3))]).collect();
    let by_business = kit::panel(t, "u-business", "By business", None, None, 0.0, table("u-biz-table", &BIZ, rows));
    const RES: [Column; 4] = [column("Provider", 0.0, false), column("Calls", 56.0, true), column("Failed", 56.0, true), column("Charged", 72.0, true)];
    let rows = u.research.iter().map(|r| vec![kit::text(t, r.0.clone()), kit::faint(t, int(r.1)), kit::faint(t, int(r.2)), kit::num(t, if r.3 > 0.0 { usd(Some(r.4)) } else { "—".into() })]).collect();
    let research = kit::panel(t, "u-research-card", "Research providers", Some("Calls on your own connections and public sources are never charged".into()), None, 0.0, table("u-res-table", &RES, rows));
    // Each assistant with its logo and a bar for its share of the busiest.
    let most = u.checks.iter().map(|c| c.1).fold(0.0, f64::max).max(1.0);
    let mut list = col().w_full().gap(12.0);
    for (k, (provider, n)) in u.checks.iter().enumerate() {
        list = list.child(
            row()
                .key(format!("u-check-{k}"))
                .w_full()
                .gap(10.0)
                .center_y()
                .child(crate::brands::logo(t, &provider.to_lowercase(), 22.0))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(5.0)
                        .child(row().w_full().gap(8.0).child(label(crate::brands::brand(&provider.to_lowercase()).0, type_::XS_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0)).child(label(format!("{} answers", int(*n)), type_::XS.features("'tnum' 1"), t.muted_foreground)))
                        .child(row().w_full().h(6.0).radius(3.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((n / most) as f32).h_full().radius(3.0).fill(t.chart.primary.alpha(0.9)))),
                ),
        );
    }
    let checks = kit::panel(
        t,
        "u-checks",
        "AI answers collected",
        Some("Answers saved from AI answer checks, by assistant".into()),
        None,
        0.0,
        if u.checks.is_empty() { kit::note(t, "Nothing in this period.") } else { list },
    );
    col()
        .w_full()
        .gap(16.0)
        .child(strip)
        .child(daily)
        .child(kit::cols(vec![by_model, by_business]))
        .child(kit::cols(vec![research, checks]))
        .children((!u.note.is_empty()).then(|| label(u.note.clone(), type_::XS, t.muted_foreground).wrap()))
}

// ---- Businesses ----------------------------------------------------------------------

fn accuracy(p: &Portfolio) -> Option<f64> {
    p.verdicts.as_ref().and_then(|v| v.accuracy())
}

fn attention(p: &Portfolio) -> i64 {
    p.overview.as_ref().map(|o| o.needs_attention + o.unreviewed).unwrap_or(-1)
}

pub fn businesses(s: &App, t: &Theme) -> El {
    let new_business = button(t, "new-business", "+ New business", Variant::Primary).on_press(|s: &mut App| s.open_add_business(None));
    let top = head(t, "Businesses", "See your businesses and what needs attention, then open one to see the agent's work and results.", Some(new_business));
    if s.businesses.is_empty() {
        return col().w_full().gap(24.0).child(top).child(empty_state(
            t,
            "businesses-empty",
            &icons::BUILDING,
            "Add your first business",
            "Start with a website. Your agent will read it and prepare a brief for you to review.",
            None,
        ));
    }
    let list = match &s.portfolio {
        Load::Ready(l) => l,
        Load::Failed(e) => return col().w_full().gap(24.0).child(top).child(failure(t, "portfolio-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(24.0).child(top).child(skeleton(t, 3)),
    };
    let sum = |f: fn(&crate::api::Overview) -> i64| list.iter().filter_map(|p| p.overview.as_ref()).map(f).sum::<i64>();
    let never = list.iter().filter(|p| p.overview.as_ref().is_none_or(|o| o.last_checked.is_none())).count();
    let strip = kit::cols(vec![
        kit::tile(t, "b-n", "Businesses", list.len().to_string(), None, Some("In this account".into())),
        kit::tile(t, "b-attention", "Need attention", int(sum(|o| o.needs_attention) as f64), None, Some("Wrong or partial claims".into())),
        kit::tile(t, "b-review", "Needs review", int(sum(|o| o.unreviewed) as f64), None, Some("Answers needing a verdict".into())),
        kit::tile(t, "b-never", "Never checked", never.to_string(), None, Some("Run a first check".into())),
    ]);
    let sort = s.portfolio_sort;
    let tab = |name: &str, v: PortfolioSort| (name.to_string(), sort == v, Box::new(move |s: &mut App| s.portfolio_sort = v) as Box<dyn Fn(&mut App)>);
    let sorts = kit::text_tabs(t, "b-sort", vec![tab("Most attention", PortfolioSort::Attention), tab("Lowest correct share", PortfolioSort::Accuracy), tab("Recently checked", PortfolioSort::Recent), tab("Name", PortfolioSort::Name)]);
    let mut shown: Vec<&Portfolio> = list.iter().filter(|p| matches(s, &p.name)).collect();
    shown.sort_by(|a, b| match sort {
        PortfolioSort::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        PortfolioSort::Accuracy => accuracy(a).unwrap_or(2.0).total_cmp(&accuracy(b).unwrap_or(2.0)),
        PortfolioSort::Recent => b.overview.as_ref().and_then(|o| o.last_checked.clone()).cmp(&a.overview.as_ref().and_then(|o| o.last_checked.clone())),
        PortfolioSort::Attention => attention(b).cmp(&attention(a)),
    });
    const COLS: [Column; 6] = [column("Business", 0.0, false), column("Correct, 30 days", 150.0, false), column("Answers per day", 150.0, false), column("Need attention", 104.0, true), column("Needs review", 96.0, true), column("Last checked", 104.0, true)];
    let now = format::now();
    let rows: Vec<Vec<El>> = shown
        .iter()
        .map(|p| {
            let id = p.id.clone();
            let o = p.overview.as_ref();
            let spark = {
                let peak = p.per_day.iter().copied().fold(0.0, f64::max).max(1.0);
                let mut r = row().w_full().h(20.0).gap(1.0).items_end();
                for (k, v) in p.per_day.iter().enumerate() {
                    r = r.child(el().key(format!("b-spark-{}-{k}", p.id)).w(0.0).grow(1.0).h(((v / peak) * 20.0).max(1.0) as f32).radius(1.0).fill(t.chart.primary.alpha(if *v > 0.0 { 0.7 } else { 0.15 })));
                }
                r
            };
            vec![
                row()
                    .w_full()
                    .gap(10.0)
                    .center_y()
                    .role("button")
                    .label(format!("Open {}", p.name))
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut App| s.open_business(&id))
                    .child(crate::ui::widgets::business_mark(t, Some(&p.name), 24.0, 6.0))
                    .child(label(p.name.clone(), type_::SM_MEDIUM, t.foreground).truncate().min_w(0.0)),
                match &p.verdicts {
                    Some(v) if v.total() > 0 => row().w_full().gap(8.0).center_y().child(col().grow(1.0).min_w(0.0).child(crate::ui::charts::verdict_bar_fill(t, v))).child(label(v.accuracy().map(crate::insights::pct).unwrap_or_else(|| "—".into()), type_::XS_MEDIUM.features("'tnum' 1"), t.foreground)),
                    _ => kit::faint(t, "No answers"),
                },
                spark,
                label(o.map(|o| int(o.needs_attention as f64)).unwrap_or_else(|| "—".into()), kit::NUM, if o.is_some_and(|o| o.needs_attention > 0) { t.wrong } else { t.muted_foreground }),
                label(o.map(|o| int(o.unreviewed as f64)).unwrap_or_else(|| "—".into()), kit::NUM, if o.is_some_and(|o| o.unreviewed > 0) { t.review } else { t.muted_foreground }),
                kit::faint(t, o.and_then(|o| o.last_checked.as_deref()).map(|d| format::relative(Some(d), now)).unwrap_or_else(|| "Never".into())),
            ]
        })
        .collect();
    let body = if rows.is_empty() { kit::note(t, format!("No business matches \"{}\".", s.list_query.text.trim())) } else { kit::table(t, "b-table", &COLS, rows) };
    let panel = kit::panel(t, "b-list", "Portfolio", Some("Open a business for its Overview".into()), Some(sorts), 0.0, col().w_full().gap(12.0).child(search(s, t, "b-search", "Search businesses")).child(body));
    col().w_full().gap(16.0).child(top).child(strip).child(panel)
}

// ---- Clients ---------------------------------------------------------------------------

pub fn clients(s: &App, t: &Theme) -> El {
    // The web's "Add business" menu: a client's business, or our own.
    let add = row()
        .gap(8.0)
        .child(button(t, "add-client", "+ Client business", Variant::Primary).on_press(|s: &mut App| s.open_add_business(Some("CLIENT"))))
        .child(button(t, "add-own", "Our business or product", Variant::Outline).on_press(|s: &mut App| s.open_add_business(Some("DOGFOOD"))));
    let top = head(t, "Clients", "Open a client or product to work with its agent and see its progress.", Some(add));
    let list = match &s.client_rows {
        Load::Ready(l) => l,
        Load::Failed(e) => return col().w_full().gap(24.0).child(top).child(failure(t, "clients-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(24.0).child(top).child(skeleton(t, 3)),
    };
    if list.is_empty() {
        return col().w_full().gap(24.0).child(top).child(empty_state(
            t,
            "clients-empty",
            &icons::BRIEFCASE,
            "Add your first business",
            "Add a website to start working with your agent, for a client or your own business.",
            None,
        ));
    }
    let all_known = list.iter().all(|c| c.known);
    let known = |v: usize| if all_known { v.to_string() } else { "—".into() };
    let strip = kit::cols(vec![
        kit::tile(t, "c-all", "Clients and products", list.len().to_string(), None, Some("Records you operate".into())),
        kit::tile(t, "c-goal", "With a marketing goal", known(list.iter().filter(|c| c.goal.is_some()).count()), None, Some("Goal and metric defined".into())),
        kit::tile(t, "c-approved", "Approved initiatives", known(list.iter().map(|c| c.approved).sum()), None, Some("Human-approved, across all clients".into())),
        kit::tile(t, "c-shared", "Shared", list.iter().filter(|c| c.shared).count().to_string(), None, Some("Active record share link".into())),
    ]);
    const COLS: [Column; 4] = [column("Client", 0.0, false), column("Marketing progress", 0.0, false), column("Initiatives", 120.0, false), column("Share", 96.0, true)];
    let rows: Vec<Vec<El>> = list
        .iter()
        .filter(|c| matches(s, &format!("{} {}", c.name, c.website)))
        .map(|c: &ClientRow| {
            let id = c.id.clone();
            let share = if c.ideas > 0 { c.approved as f32 / c.ideas as f32 } else { 0.0 };
            vec![
                row()
                    .w_full()
                    .gap(10.0)
                    .center_y()
                    .role("button")
                    .label(format!("Open {}", c.name))
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut App| s.open_business(&id))
                    .child(crate::ui::widgets::business_mark(t, Some(&c.name), 24.0, 6.0))
                    .child(col().min_w(0.0).child(label(c.name.clone(), type_::SM_MEDIUM, t.foreground).truncate()).child(label(c.website.trim_start_matches("https://").trim_start_matches("http://").to_string(), type_::XS11, t.muted_foreground).truncate())),
                col().w_full().gap(0.0).child(label(c.progress(), type_::SM_13, if c.known { t.foreground } else { t.muted_foreground }).truncate()).children(c.metric.clone().map(|m| label(format!("Measured by {m}"), type_::XS11, t.muted_foreground).truncate())),
                row().w_full().gap(8.0).center_y().child(row().grow(1.0).h(6.0).radius(3.0).fill(t.foreground.alpha(0.06)).child(el().w_frac(share).h_full().radius(3.0).fill(t.supported))).child(label(format!("{}/{}", c.approved, c.ideas), type_::XS.features("'tnum' 1"), t.muted_foreground)),
                if c.shared { status_chip(t, "Shared", t.supported, t.supported_soft) } else { kit::faint(t, "Private") },
            ]
        })
        .collect();
    let body = if rows.is_empty() { kit::note(t, format!("No client matches \"{}\".", s.list_query.text.trim())) } else { kit::table(t, "c-table", &COLS, rows) };
    let panel = kit::panel(t, "c-list", "Clients and products", None, None, 0.0, col().w_full().gap(12.0).child(search(s, t, "c-search", "Search clients")).child(body));
    col().w_full().gap(16.0).child(top).child(strip).child(panel)
}

/// "Add a business" (the web's `CreateBusinessDialog` with its `SetupStartForm`):
/// the website and the goal in one line, sent with Return or the round button.
pub fn add_business_dialog(s: &App, t: &Theme, k: &rune_kit::Kit, a: &crate::state::AddBusiness, layer: &mut Vec<El>) {
    let input = text_input(&a.text, type_::SM)
        .key("add-business-input")
        .placeholder("acme.com, we want more booked appointments", t.muted_foreground)
        .label("Your website and what you want to achieve")
        .w_full()
        .max_h(192.0)
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.add_business.as_mut().expect("dialog open").text)
        .on_submit(|s: &mut App, _tx| s.submit_add_business())
        .autofocus();
    let has_text = !a.text.text.trim().is_empty();
    let send = shadows(
        row()
            .key("add-business-send")
            .size(32.0, 32.0)
            .radius(16.0)
            .center()
            .fill(t.primary)
            .role("button")
            .label("Start setup")
            .cursor(Cursor::Pointer)
            .opacity(if a.busy { 0.5 } else { 1.0 })
            .on_press(|s: &mut App| s.submit_add_business())
            .child(if a.busy { ico(&icons::LOADER, 16.0, t.primary_foreground).looping(rune::LoopSpec::rotation(1.0)) } else { ico(&icons::ARROW_UP, 16.0, t.primary_foreground) }),
        &t.primary_shadow,
    );
    let field = shadows(
        row().w_full().min_h(48.0).px(12.0).py(8.0).gap(12.0).radius(10.0).items_end().fill(t.card).child(col().grow(1.0).min_w(0.0).py(4.0).child(input)).children((has_text || a.busy).then_some(send)),
        &t.control_shadow,
    );
    let mut content = col().w_full().px(24.0).pb(20.0).gap(8.0).child(field);
    if let Some(e) = &a.error {
        content = content.child(label(e.clone(), type_::XS, t.wrong).wrap());
    }
    let (title, description) = match a.engagement {
        Some("CLIENT") => ("Add a client business", "Enter the client's website and, if you like, what they want to achieve."),
        Some(_) => ("Add your business or product", "Enter your website and, if you like, what you want to achieve."),
        None => ("Add a business", "Enter a website and optionally a goal to start setup."),
    };
    let _ = s;
    rune_kit::Dialog::new("add-business", title)
        .description(description)
        .width(560.0)
        .fit()
        .open(true)
        .child(content)
        .on_close(|s: &mut App| s.add_business = None)
        .build(k, layer);
}
