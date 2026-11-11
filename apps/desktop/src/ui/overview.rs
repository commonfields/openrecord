//! The Overview and its sections (`routes/today.tsx`): Summary, Performance,
//! Revenue, Funnel, Events, Realtime and AI discovery.

use rune::{Color, Cursor, El, col, el, row};

use crate::format;
use crate::insights::{Analytics, Discovery, Goal, Insights, PERIODS, Report, Section, Source, Verdicts, int, pct};
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::{charts, discovery};
use crate::ui::widgets::{CONTROL, Variant, button, card, failure, label, skeleton};

pub fn view(s: &App, t: &Theme) -> El {
    let sec = s.section;
    let title = if sec == Section::Summary { s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "Overview".into()) } else { sec.label().to_string() };
    let mut head = row().w_full().gap(16.0).items_start().child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(4.0)
            .child(label(title, type_::TITLE, t.foreground).role("heading"))
            .child(label(sec.description(), type_::SM, t.muted_foreground).wrap()),
    );
    // The Summary keeps its range beside its chart, as Kobbe's overview does.
    if sec.has_period() && sec != Section::Summary {
        head = head.child(periods(s, t));
    }
    let body = match &s.insights {
        Load::Ready(i) => match sec {
            Section::Summary => summary(s, t, i),
            Section::Performance => performance(t, i),
            Section::Revenue => revenue(t, i),
            Section::Funnel => funnel(t, i),
            Section::Events => events(s, t, i),
            Section::Realtime => realtime(t),
            Section::Answers => answers(s, t, i),
        },
        Load::Failed(e) => failure(t, "insights-failed", e, |s: &mut App| s.refresh()),
        _ => col().w_full().gap(16.0).child(skeleton(t, 1)).child(skeleton(t, 2)),
    };
    col().key(format!("overview-{}", sec.key())).w_full().gap(24.0).child(head).child(body)
}

fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.new_chat();
        s.composer.replace_text(request);
    }
}

/// The 7, 30 and 90 day switch.
fn periods(s: &App, t: &Theme) -> El {
    // Kobbe's text tabs: plain labels, the chosen one on a soft pill.
    let mut r = row().h(28.0).gap(2.0).role("radiogroup").label("Time range");
    for d in PERIODS {
        let on = s.days == d;
        let mut chip = row()
            .key(format!("period-{d}"))
            .h_full()
            .px(10.0)
            .radius(6.0)
            .center()
            .role("radio")
            .label(format!("Last {d} days"))
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.set_days(d))
            .child(label(format!("{d} days"), type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }));
        chip = if on { chip.fill(t.accent) } else { chip.hover(t.hover_tint) };
        r = r.child(chip);
    }
    r
}

fn panel(t: &Theme, key: &str, title: &str, description: Option<String>) -> El {
    let mut head = col().w_full().gap(2.0).child(label(title, type_::SM_MEDIUM, t.foreground).role("heading"));
    if let Some(d) = description {
        head = head.child(label(d, type_::XS, t.muted_foreground).wrap());
    }
    card(t).key(key).px(20.0).py(18.0).gap(16.0).child(head)
}

fn tile(t: &Theme, key: &str, name: &str, value: String, hint: Option<String>, delta: Option<El>, tone: Option<Color>, open: Option<Page>) -> El {
    kpi(t, key, name, value, hint, delta, tone, false, open)
}

/// One number in Kobbe's key-number strip: its name with the change on the
/// right, the value under it, and a short note. Frameless, split from its
/// neighbour by a hairline; the selected one is raised onto a card.
#[allow(clippy::too_many_arguments)]
fn kpi(t: &Theme, key: &str, name: &str, value: String, hint: Option<String>, delta: Option<El>, tone: Option<Color>, selected: bool, open: Option<Page>) -> El {
    let mut head = row().w_full().gap(6.0).center_y();
    if let Some(c) = tone {
        head = head.child(el().size(6.0, 6.0).radius(3.0).fill(c));
    }
    head = head.child(label(name, type_::SM_13, if selected { t.foreground } else { t.muted_foreground }).truncate().min_w(0.0)).child(el().grow(1.0));
    if let Some(d) = delta {
        head = head.child(d);
    }
    let mut c = col()
        .key(key)
        .w(0.0)
        .grow(1.0)
        .min_w(150.0)
        .px(16.0)
        .py(12.0)
        .gap(4.0)
        .radius(12.0)
        .child(head)
        .child(label(value, type_::TITLE.features("'tnum' 1"), if selected { t.foreground } else { t.foreground.alpha(0.85) }));
    if let Some(h) = hint {
        c = c.child(label(h, type_::XS, t.muted_foreground).truncate());
    }
    if let Some(p) = open {
        c = c.role("button").label(name).focusable(true).cursor(Cursor::Pointer).hover(t.hover_tint).motion(CONTROL).on_press(move |s: &mut App| s.show_page(p));
    }
    if selected {
        shadows(c.fill(t.card), &t.card_shadow)
    } else {
        // The hairline on its left, inset from top and bottom.
        c.child(el().pin(Some(0.0), Some(14.0), None, Some(14.0)).w(1.0).fill(t.border))
    }
}

/// A change against the period before: green when better, red when worse.
fn delta(t: &Theme, text_: String, better: Option<bool>) -> El {
    let ink = match better {
        Some(true) => t.supported,
        Some(false) => t.wrong,
        None => t.muted_foreground,
    };
    label(text_, type_::XS_MEDIUM.features("'tnum' 1"), ink)
}

fn change_text(d: f64) -> String {
    format!("{}{:.0}%", if d >= 0.0 { "+" } else { "" }, d * 100.0)
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{} {}", int(n as f64), if n == 1 { one } else { many })
}

fn verdict_hint(v: &Verdicts) -> String {
    let mut parts = Vec::new();
    if v.wrong > 0 {
        parts.push(format!("{} wrong", v.wrong));
    }
    if v.partial > 0 {
        parts.push(format!("{} partly right", v.partial));
    }
    if v.unknown > 0 {
        parts.push(format!("{} unclear", v.unknown));
    }
    if v.unreviewed > 0 {
        parts.push(format!("{} to review", v.unreviewed));
    }
    if parts.is_empty() { if v.total() > 0 { "Every judged answer was supported".into() } else { "No answers checked yet".into() } } else { parts.join(", ") }
}

fn note(t: &Theme, text_: &str) -> El {
    label(text_.to_string(), type_::SM_13, t.muted_foreground).wrap()
}

// ---- Summary ----------------------------------------------------------------

fn summary(s: &App, t: &Theme, i: &Insights) -> El {
    // Kobbe's overview: the key numbers in one frameless strip, the goal's tile
    // raised because it drives the chart under it, then the chart on the page
    // itself, then the panels.
    let mut c = col().w_full().gap(16.0);
    c = c.child(health(s, t, i));
    c = c.child(goal_card(s, t, i).mb(16.0));
    if !i.initiatives.is_empty() {
        c = c.child(initiatives(t, i));
    }
    if let Ok(a) = &i.analytics {
        let st = discovery::stats(a);
        c = c.child(row().w_full().gap(16.0).items_start().flex_wrap().child(questions(t, a, i.days)).child(discovery::accuracy_by_model(t, a, &st)));
    }
    c
}

/// The goal's chart, on the page without a frame: its name and range on the
/// left, the 7, 30 and 90 day switch on the right, the line, then its legend
/// with where the numbers came from.
fn goal_card(s: &App, t: &Theme, i: &Insights) -> El {
    let section = |title: String, sub: String| {
        row()
            .w_full()
            .gap(16.0)
            .items_start()
            .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(title, type_::SM_MEDIUM, t.foreground).role("heading")).child(label(sub, type_::XS, t.muted_foreground).wrap()))
            .child(periods(s, t))
    };
    match &i.goal {
        Ok(Some(g)) => {
            let sub = if g.statement.is_empty() { format!("Last {} days", i.days) } else { format!("{}. Last {} days", g.statement.trim_end_matches('.'), i.days) };
            let c = col().key("goal").w_full().gap(16.0).child(section(format!("{} over time", g.label), sub));
            let cut = format::iso_date(format::now() - i.days as i64 * 86_400);
            if !g.points.iter().any(|(d, _)| d.as_str() > cut.as_str()) {
                return c.child(note(t, "No daily values recorded for this period yet. Missing days are not zero."));
            }
            let from = match g.source.as_deref() {
                Some("GA4_AGGREGATE_EXPORT") => "Google Analytics",
                _ => "imported exports",
            };
            c.child(discovery::goal_trend(s, t, g, i.days, "goal-trend")).child(label(format!("From {from}. Missing days are not zero."), type_::XS, t.muted_foreground))
        }
        Ok(None) => col().key("goal").w_full().gap(12.0).child(section("No goal yet".into(), "Set the one result this business is working toward, and the agent measures progress against it.".into())).child(
            row().child(button(t, "ask-goal", "Set a goal with the agent", Variant::Outline).on_press(ask(
                "Help me set the main goal for this business: what we want more of, and how we'll measure it.",
            ))),
        ),
        Err(e) => col().key("goal").w_full().gap(12.0).child(section("Your goal could not load".into(), e.clone())),
    }
}

/// The goal's number for the strip: its total over the period and the change
/// against the period before.
fn goal_tile(t: &Theme, i: &Insights) -> Option<El> {
    let g = i.goal.as_ref().ok()?.as_ref()?;
    let cut = format::iso_date(format::now() - i.days as i64 * 86_400);
    let start = format::iso_date(format::now() - 2 * i.days as i64 * 86_400);
    let now: f64 = g.points.iter().filter(|(d, _)| d.as_str() > cut.as_str()).map(|p| p.1).sum();
    let before: f64 = g.points.iter().filter(|(d, _)| d.as_str() <= cut.as_str() && d.as_str() > start.as_str()).map(|p| p.1).sum();
    let d = (before > 0.0).then(|| (now - before) / before);
    Some(kpi(t, "health-goal", &g.label, charts::format_count(now), Some(format!("In the last {} days", i.days)), d.map(|d| delta(t, change_text(d), Some(d >= 0.0))), None, true, None))
}

fn health(_s: &App, t: &Theme, i: &Insights) -> El {
    let h = &i.health;
    let (acc_value, acc_delta, acc_hint, acc_tone) = match &i.analytics {
        Ok(a) => {
            let acc = a.current.accuracy();
            let prev = a.previous.accuracy();
            let d = acc.zip(prev).map(|(x, y)| ((x - y) * 100.0).round());
            (
                acc.map(pct).unwrap_or_else(|| "—".into()),
                d.map(|pts| delta(t, format!("{}{pts:.0} pts", if pts >= 0.0 { "+" } else { "" }), Some(pts >= 0.0))),
                Some(verdict_hint(&a.current)),
                (a.current.wrong > 0).then_some(t.wrong),
            )
        }
        Err(_) => ("—".into(), None, Some("Answer analytics could not load".into()), None),
    };
    let unreadable = h.sources.saturating_sub(h.in_sync + h.drift);
    let sources_hint = if h.sources == 0 {
        "No sources tracked yet".to_string()
    } else {
        let mut parts = Vec::new();
        if h.drift > 0 {
            parts.push(format!("{} out of date", h.drift));
        }
        if unreadable > 0 {
            parts.push(format!("{unreadable} unreadable"));
        }
        if parts.is_empty() { "All match your facts".into() } else { parts.join(", ") }
    };
    let mut strip = row().key("kpis").w_full().gap(0.0).items_stretch().role("group").label("Key numbers");
    if let Some(g) = goal_tile(t, i) {
        strip = strip.child(g);
    }
    strip
        .child(tile(t, "health-accuracy", "AI answers correct", acc_value, acc_hint, acc_delta, acc_tone, Some(Page::AiAnswers)))
        .child(tile(
            t,
            "health-sources",
            "Sources in sync",
            if h.sources > 0 { format!("{} of {}", h.in_sync, h.sources) } else { "—".into() },
            Some(sources_hint),
            None,
            if h.drift > 0 { Some(t.wrong) } else if unreadable > 0 { Some(t.unknown) } else { None },
            None,
        ))
        .child(tile(
            t,
            "health-website",
            "Website issues",
            if h.inspected { int(h.open_findings as f64) } else { "—".into() },
            Some(if h.inspected {
                format!("{} inspected, {} verified", plural(h.urls_inspected, "page", "pages"), plural(h.verified_fixes, "fix", "fixes"))
            } else {
                "Website not inspected yet".into()
            }),
            None,
            (h.open_findings > 0).then_some(t.partial),
            None,
        ))
}

fn initiatives(t: &Theme, i: &Insights) -> El {
    let mut p = panel(t, "initiatives", "Work in progress", Some("Ideas you approved or that wait on you, and whether the work was done.".into()));
    let mut list = col().w_full();
    let n = i.initiatives.len();
    for (k, x) in i.initiatives.iter().enumerate() {
        let (ink, soft, state) = match (x.status.as_str(), x.progress.as_str()) {
            ("APPROVED", "EXECUTED") => (t.supported, t.supported_soft, "Done, measuring"),
            ("APPROVED", _) => (t.review, t.review_soft, "Approved, not done yet"),
            ("PROPOSED", _) => (t.partial, t.partial_soft, "Waiting for your decision"),
            ("REVIEWED", _) => (t.supported, t.supported_soft, "Reviewed"),
            ("CANCELLED", _) => (t.muted_foreground, t.accent, "Declined"),
            _ => (t.muted_foreground, t.accent, "Discovered"),
        };
        let mut r = row()
            .key(format!("initiative-{k}"))
            .w_full()
            .py(10.0)
            .gap(12.0)
            .center_y()
            .child(label(x.title.clone(), type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0))
            .child(crate::ui::widgets::status_chip(state, ink, soft));
        if k + 1 < n {
            r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
        }
        list = list.child(r);
    }
    p = p.child(list);
    p
}

fn questions(t: &Theme, a: &Analytics, days: u32) -> El {
    let p = panel(t, "questions", "Buyer questions", Some(format!("What buyers ask AI assistants, and how the answers held up. Last {days} days.")));
    if a.questions.is_empty() {
        return p.child(note(t, "No questions were checked in this period."));
    }
    let now = format::now();
    let mut list = col().w_full().gap(12.0);
    for (k, q) in a.questions.iter().take(8).enumerate() {
        list = list.child(
            col()
                .key(format!("question-{k}"))
                .w_full()
                .gap(6.0)
                .child(label(q.prompt.clone(), type_::SM, t.foreground).wrap())
                .child(
                    row()
                        .w_full()
                        .gap(10.0)
                        .center_y()
                        .child(charts::verdict_bar(t, &q.v, 120.0))
                        .child(label(verdict_hint(&q.v), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                        .child(label(format!("{}, {}", plural(q.checks, "check", "checks"), format::relative(q.last_checked.as_deref(), now)), type_::XS, t.muted_foreground)),
                ),
        );
    }
    p.grow(1.0).min_w(360.0).child(list)
}

// ---- AI discovery -----------------------------------------------------------

fn answers(s: &App, t: &Theme, i: &Insights) -> El {
    let mut c = col().w_full().gap(24.0);
    c = c.child(discovery_panel(t, &i.discovery));
    match &i.analytics {
        Ok(a) => {
            let st = discovery::stats(a);
            c = c.child(discovery::hero(s, t, i, a, &st));
            c = c.child(
                col()
                    .w_full()
                    .gap(12.0)
                    .child(
                        col()
                            .gap(2.0)
                            .child(label("AI answer details", type_::SM_MEDIUM, t.foreground).role("heading"))
                            .child(label(format!("Which providers answered, what buyers asked, and the sources they cited, last {} days", i.days), type_::XS, t.muted_foreground)),
                    )
                    .child(row().w_full().gap(16.0).items_start().flex_wrap().child(discovery::answer_collection(t, &st, i.days)).child(discovery::accuracy_by_model(t, a, &st)))
                    .child(row().w_full().gap(16.0).items_start().flex_wrap().child(questions(t, a, i.days)).child(discovery::citations(s, t, a, i.days)))
                    .child(row().w_full().gap(16.0).items_start().flex_wrap().child(facts(t, a))),
            );
        }
        Err(e) => c = c.child(panel(t, "answers-failed", "Answer analytics could not load", Some(e.clone()))),
    }
    c
}

fn discovery_panel(t: &Theme, d: &Result<Option<Discovery>, String>) -> El {
    let p = panel(t, "discovery", "AI discovery and referrals", Some("What sampled AI answers say, and separately, visits attributed to AI assistants.".into()));
    match d {
        Err(_) => p.child(note(t, "AI discovery evidence is unavailable. This does not mean there are no results.")),
        Ok(None) => p.child(note(t, "AI answer discovery: not measured yet. AI-attributed website sessions and signups: not measured.")),
        Ok(Some(d)) => {
            let mut c = col().w_full().gap(12.0);
            c = c.child(match &d.period {
                Some((surface, reviewed, mentions, owned, range)) => col()
                    .gap(4.0)
                    .child(label(format!("AI answers on {surface}"), type_::SM_MEDIUM, t.foreground))
                    .child(note(t, &format!("Reviewed: {reviewed} successful samples. Confirmed mentions: {mentions} clear mention reviews. Owned-site citations: {owned} successful samples.")))
                    .child(label(format!("{range}. Citations are reported by the provider, not verified support."), type_::XS, t.muted_foreground).wrap()),
                None => note(t, "AI answer discovery: not measured yet."),
            });
            c = c.child(match &d.referral {
                Some(r) => col()
                    .gap(4.0)
                    .child(label("AI-attributed website sessions, from a GA4 export", type_::SM_MEDIUM, t.foreground))
                    .child(note(t, r))
                    .child(label("A separate data source: it does not show that a sampled AI answer caused a visit or signup.", type_::XS, t.muted_foreground).wrap()),
                None => note(t, "AI-attributed website sessions and signups: not measured."),
            });
            p.child(c)
        }
    }
}

fn facts(t: &Theme, a: &Analytics) -> El {
    let p = panel(t, "facts", "Your facts in AI answers", Some("How answers held up against each approved fact.".into()));
    if a.facts.is_empty() {
        return p.grow(1.0).min_w(360.0).child(note(t, "No approved fact was tested in this period."));
    }
    let mut list = col().w_full().gap(10.0);
    for (k, f) in a.facts.iter().take(10).enumerate() {
        list = list.child(
            row()
                .key(format!("fact-{k}"))
                .w_full()
                .gap(12.0)
                .center_y()
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(label(f.value.clone(), type_::SM, t.foreground).truncate())
                        .child(label(f.predicate.replace('_', " "), type_::XS, t.muted_foreground)),
                )
                .child(charts::verdict_bar(t, &f.v, 120.0)),
        );
    }
    p.grow(1.0).min_w(360.0).child(list)
}

// ---- Performance and revenue ------------------------------------------------

fn report(t: &Theme, key: &str, r: &Report) -> El {
    let mut p = panel(t, key, &r.title, Some(r.subtitle.clone()));
    let mut tiles = row().w_full().gap(12.0).flex_wrap();
    for (k, m) in r.metrics.iter().enumerate() {
        let mut c = col().key(format!("{key}-metric-{k}")).grow(1.0).min_w(150.0).px(14.0).py(12.0).gap(4.0).radius(10.0).fill(t.accent.alpha(0.5)).child(label(m.label.clone(), type_::XS, t.muted_foreground));
        let mut v = row().gap(8.0).items_end().child(label(m.value.clone(), type_::BASE_MEDIUM.features("'tnum' 1"), t.foreground));
        if let Some(d) = m.delta {
            v = v.child(delta(t, change_text(d), None));
        }
        c = c.child(v);
        tiles = tiles.child(c);
    }
    p = p.child(tiles);
    if let Some((head, rows)) = &r.table {
        let mut table = col().w_full();
        let cells = |cols: &Vec<String>, style: rune::TextStyle, ink: Color| {
            let mut r = row().w_full().py(8.0).gap(12.0).center_y();
            for (i, c) in cols.iter().enumerate() {
                let cell = label(c.clone(), style, ink).truncate();
                r = r.child(if i == 0 { cell.grow(1.0).min_w(0.0) } else { cell.w(96.0) });
            }
            r
        };
        table = table.child(cells(head, type_::XS_MEDIUM, t.muted_foreground).border_sides([0.0, 0.0, 1.0, 0.0], t.border));
        for row_ in rows {
            table = table.child(cells(row_, type_::SM_13, t.foreground).border_sides([0.0, 0.0, 1.0, 0.0], t.border.alpha(0.6)));
        }
        p = p.child(table);
    }
    if let Some(n) = &r.note {
        p = p.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    p
}

fn source(t: &Theme, key: &str, title: &str, src: &Source) -> El {
    match src {
        Source::Reports(list) => {
            let mut c = col().w_full().gap(16.0);
            for (k, r) in list.iter().enumerate() {
                c = c.child(report(t, &format!("{key}-{k}"), r));
            }
            c
        }
        Source::NotConnected(why) => panel(t, key, title, None).child(
            row()
                .w_full()
                .gap(12.0)
                .center_y()
                .child(label("Not connected", type_::XS_MEDIUM, t.muted_foreground).px(8.0).py(2.0).radius(10.0).fill(t.accent))
                .child(label(why.clone(), type_::SM_13, t.muted_foreground).wrap().grow(1.0).min_w(0.0)),
        ),
        Source::Failed(e) => panel(t, key, title, Some(e.clone())),
    }
}

fn performance(t: &Theme, i: &Insights) -> El {
    col()
        .w_full()
        .gap(16.0)
        .child(intro(t, "Each source below has its own date range and attribution. Results appear when its account is connected. Platform conversions are kept separate."))
        .child(source(t, "search", "Google Search", &i.search))
        .child(source(t, "ads", "Advertising", &i.ads))
        .child(source(t, "local", "Google Business Profile", &i.local))
}

fn revenue(t: &Theme, i: &Insights) -> El {
    col()
        .w_full()
        .gap(16.0)
        .child(intro(t, "Revenue appears when Stripe is connected. Orders and refunds are reported separately from marketing attribution."))
        .child(source(t, "revenue", "Stripe", &i.revenue))
}

fn intro(t: &Theme, text_: &str) -> El {
    card(t)
        .px(20.0)
        .py(16.0)
        .gap(12.0)
        .child(note(t, text_))
        .child(row().child(button(t, "manage-accounts", "Manage accounts", Variant::Outline).on_press(|s: &mut App| s.show_page(Page::Channels))))
}

// ---- Funnel, events, realtime -----------------------------------------------

fn funnel(t: &Theme, i: &Insights) -> El {
    let goal = i.goal.as_ref().ok().and_then(Option::as_ref);
    let rows: [(&str, String, Section, &str); 3] = [
        ("Discovery", "Search visibility, ad performance and AI answer evidence.".into(), Section::Performance, "View performance"),
        (
            "Goal action",
            match goal {
                Some(g) => format!("{}. {}", g.label, g.event_name.as_ref().map(|e| format!("Configured event: {e}.")).unwrap_or_else(|| "No event name saved.".into())),
                None => "No goal event has been defined yet.".into(),
            },
            Section::Events,
            "View events",
        ),
        ("Revenue", "Paid orders, refunds and customers from Stripe, kept separate by currency.".into(), Section::Revenue, "View revenue"),
    ];
    let mut list = col().w_full();
    for (k, (title, detail, sec, link)) in rows.into_iter().enumerate() {
        let mut r = row()
            .key(format!("funnel-{k}"))
            .w_full()
            .py(14.0)
            .gap(12.0)
            .center_y()
            .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(title, type_::SM_MEDIUM, t.foreground)).child(label(detail, type_::XS, t.muted_foreground).wrap()))
            .child(button(t, &format!("funnel-open-{k}"), link, Variant::Outline).on_press(move |s: &mut App| s.show_section(sec)));
        if k < 2 {
            r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
        }
        list = list.child(r);
    }
    col()
        .w_full()
        .gap(16.0)
        .child(
            panel(t, "funnel-intro", "Build a funnel you can trust", None)
                .child(note(t, "A funnel follows the same people through defined steps. OpenRecord currently reads separate source totals, so a connected conversion funnel and drop-off rates are not available yet."))
                .child(note(t, "Search clicks, ad conversions and paying customers can overlap or cover different dates. They are not added together or treated as consecutive funnel steps.")),
        )
        .child(panel(t, "funnel-coverage", "Measurement coverage", Some("Where to find each part of the journey. These are separate reports, not a measured funnel.".into())).child(list))
}

fn events(s: &App, t: &Theme, i: &Insights) -> El {
    let goal: Option<&Goal> = i.goal.as_ref().ok().and_then(Option::as_ref);
    if let Err(e) = &i.goal {
        return panel(t, "events", "Your saved goal could not load", Some(e.clone()));
    }
    let field = |name: &str, value: String| col().grow(1.0).min_w(180.0).gap(4.0).child(label(name, type_::XS, t.muted_foreground)).child(label(value, type_::SM, t.foreground).wrap());
    let counting = match goal.map(|g| g.counting.as_str()) {
        Some("EVENT_COUNT") => "Event occurrences, not distinct people",
        Some("SUM") => "Sum of values in the source report",
        _ => "See the saved metric definition",
    };
    let p = panel(t, "events", goal.map(|g| g.label.as_str()).unwrap_or("No goal event configured"), None)
        .child(
            row()
                .w_full()
                .gap(16.0)
                .flex_wrap()
                .child(field("Event name", goal.and_then(|g| g.event_name.clone()).unwrap_or_else(|| "Not configured".into())))
                .child(field("Counting method", counting.into()))
                .child(field("Reporting timezone", goal.and_then(|g| g.time_zone.clone()).unwrap_or_else(|| "Not configured".into()))),
        )
        .child(label("This is the daily history of the saved goal metric. A list of individual events, custom event exploration and live event delivery are not available. Missing days are not zero.", type_::XS, t.muted_foreground).wrap())
        .child(row().child(button(t, "events-accounts", "Manage measurement accounts", Variant::Outline).on_press(|s: &mut App| s.show_page(Page::Channels))));
    col().w_full().gap(16.0).child(p).children(goal.map(|_| goal_card(s, t, i)))
}

fn realtime(t: &Theme) -> El {
    panel(t, "realtime", "Live visitor tracking is not available yet", None)
        .child(note(t, "OpenRecord does not currently receive a live visitor or event stream. There is no active-user count to display. Daily reports and imported website logs are historical observations."))
        .child(note(t, "Connecting a log feed collects AI crawler and referral counts. It does not enable live visitor analytics."))
        .child(row().child(button(t, "realtime-events", "View recorded goal events", Variant::Outline).on_press(|s: &mut App| s.show_section(Section::Events))))
}
