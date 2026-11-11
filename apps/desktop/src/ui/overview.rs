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
            Section::Revenue => revenue(s, t, i),
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
    if parts.is_empty() { if v.total() > 0 { "Every rated answer was correct".into() } else { "No answers checked yet".into() } } else { parts.join(", ") }
}

fn note(t: &Theme, text_: &str) -> El {
    label(text_.to_string(), type_::SM_13, t.muted_foreground).wrap()
}

// ---- Dashboard parts ----------------------------------------------------------

/// A fixed-height card with its title and a short line under it; its body fills
/// the rest and scrolls inside, so a row of these always lines up.
fn board(t: &Theme, key: &str, title: &str, sub: Option<String>, height: f32, body: El) -> El {
    let mut head = col().w_full().gap(2.0).child(label(title.to_string(), type_::SM_MEDIUM, t.foreground).role("heading"));
    if let Some(d) = sub {
        head = head.child(label(d, type_::XS, t.muted_foreground).truncate());
    }
    card(t)
        .key(key.to_string())
        .w(0.0)
        .grow(1.0)
        .min_w(280.0)
        .h(height)
        .px(20.0)
        .py(18.0)
        .gap(14.0)
        .clip_rounded(12.0)
        .child(head)
        .child(col().key(format!("{key}-body")).w_full().grow(1.0).min_h(0.0).child(body).scroll(rune::ScrollSpec { stick_bottom: false }))
}

/// An existing panel held to the dashboard's card height, scrolling inside.
fn fixed(panel: El, key: &str) -> El {
    col().key(key.to_string()).w(0.0).grow(1.0).min_w(320.0).h(340.0).child(panel.w_full().h_full().clip_rounded(12.0).scroll(rune::ScrollSpec { stick_bottom: false }))
}

/// Cards side by side at equal widths, wrapping on narrow windows.
fn grid(cards: Vec<El>) -> El {
    let mut r = row().w_full().gap(16.0).items_stretch().flex_wrap();
    for c in cards {
        r = r.child(c);
    }
    r
}

/// A number from a formatted value ("1,284", "3%", "$1,204.50").
fn number(v: &str) -> Option<f64> {
    let clean: String = v.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    clean.parse().ok()
}

/// One key number on a fixed-height card: its name, the value, the change, and
/// a pair of bars for this period against the one before.
fn stat_tile(t: &Theme, key: &str, name: &str, value: &str, change: Option<f64>, better_up: bool) -> El {
    let mut head = row().w_full().gap(6.0).center_y().child(label(name.to_string(), type_::XS_MEDIUM, t.muted_foreground).truncate().grow(1.0).min_w(0.0));
    if let Some(d) = change {
        let good = (d >= 0.0) == better_up;
        let (ink, soft) = if d.abs() < 0.005 { (t.muted_foreground, t.accent) } else if good { (t.supported, t.supported_soft) } else { (t.wrong, t.wrong_soft) };
        head = head.child(row().h(20.0).px(6.0).radius(5.0).center().fill(soft).child(label(change_text(d), type_::XS_MEDIUM.features("'tnum' 1"), ink)));
    }
    let mut c = card(t)
        .key(key.to_string())
        .w(0.0)
        .grow(1.0)
        .min_w(170.0)
        .h(128.0)
        .px(18.0)
        .py(16.0)
        .gap(6.0)
        .child(head)
        .child(label(value.to_string(), rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1"), t.foreground).truncate());
    // This period against the one before, as two bars on one scale.
    if let (Some(d), Some(now)) = (change, number(value)) {
        let before = if (1.0 + d).abs() > f64::EPSILON { now / (1.0 + d) } else { now };
        let max = now.max(before).max(f64::EPSILON);
        let bar = |frac: f64, ink: Color, name: &str| {
            row().w_full().h(10.0).gap(8.0).center_y()
                .child(row().grow(1.0).h(4.0).radius(2.0).fill(t.foreground.alpha(0.06)).child(el().w_frac((frac / max) as f32).h_full().radius(2.0).fill(ink)))
                .child(label(name.to_string(), type_::XS2.lh(10.0), t.muted_foreground).w(44.0))
        };
        c = c.child(el().grow(1.0)).child(col().w_full().gap(4.0).child(bar(now, t.primary_ink, "now")).child(bar(before, t.muted_foreground.alpha(0.5), "before")));
    }
    c
}

/// A ranked list drawn as bars: each row's name over a bar sized to its share
/// of the largest value, the value on the right.
fn bar_list(t: &Theme, key: &str, rows: &[(String, f64, String)]) -> El {
    let max = rows.iter().map(|r| r.1).fold(0.0, f64::max).max(f64::EPSILON);
    let mut c = col().key(key.to_string()).w_full().gap(10.0);
    for (k, (name, v, shown)) in rows.iter().enumerate() {
        c = c.child(
            col().key(format!("{key}-{k}")).w_full().gap(4.0)
                .child(row().w_full().gap(8.0).center_y()
                    .child(label(name.clone(), type_::XS, t.foreground).truncate().grow(1.0).min_w(0.0))
                    .child(label(shown.clone(), type_::XS.features("'tnum' 1"), t.muted_foreground)))
                .child(row().w_full().h(6.0).radius(3.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((v / max) as f32).h_full().radius(3.0).fill(t.primary_ink.alpha(0.85)))),
        );
    }
    c
}

/// Every number of a report against the period before, as paired bars.
fn compare_list(t: &Theme, key: &str, r: &Report) -> El {
    let mut c = col().key(key.to_string()).w_full().gap(14.0);
    for (k, m) in r.metrics.iter().enumerate() {
        let (Some(now), Some(d)) = (number(&m.value), m.delta) else { continue };
        let before = if (1.0 + d).abs() > f64::EPSILON { now / (1.0 + d) } else { now };
        let max = now.max(before).max(f64::EPSILON);
        let line = |v: f64, ink: Color| row().w_full().h(8.0).radius(4.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((v / max) as f32).h_full().radius(4.0).fill(ink));
        c = c.child(
            col().key(format!("{key}-{k}")).w_full().gap(5.0)
                .child(row().w_full().gap(8.0).center_y()
                    .child(label(m.label.clone(), type_::XS, t.foreground).grow(1.0).min_w(0.0))
                    .child(label(change_text(d), type_::XS_MEDIUM.features("'tnum' 1"), if d >= 0.0 { t.supported } else { t.wrong })))
                .child(line(now, t.primary_ink))
                .child(line(before, t.muted_foreground.alpha(0.45))),
        );
    }
    c.child(row().gap(14.0).pt(2.0)
        .child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(2.0).fill(t.primary_ink)).child(label("This period", type_::XS2, t.muted_foreground)))
        .child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(2.0).fill(t.muted_foreground.alpha(0.45))).child(label("Period before", type_::XS2, t.muted_foreground))))
}

// ---- Summary ----------------------------------------------------------------

fn summary(s: &App, t: &Theme, i: &Insights) -> El {
    // Kobbe's overview: the key numbers in one frameless strip, the goal's tile
    // raised because it drives the chart under it, then the chart on the page
    // itself, then the panels.
    let mut c = col().w_full().gap(16.0);
    c = c.child(health(s, t, i));
    c = c.child(card(t).key("goal-card").h(420.0).px(24.0).py(20.0).clip_rounded(12.0).child(goal_card(s, t, i)));
    let mut boards = Vec::new();
    if !i.initiatives.is_empty() {
        boards.push(initiatives(t, i));
    }
    if let Ok(a) = &i.analytics {
        boards.push(questions(t, a, i.days));
    }
    if !boards.is_empty() {
        c = c.child(grid(boards));
    }
    if let Ok(a) = &i.analytics {
        let st = discovery::stats(a);
        c = c.child(discovery::accuracy_by_model(t, a, &st));
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
            "Pages that match your facts",
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
    let mut list = col().w_full();
    let n = i.initiatives.len();
    for (k, x) in i.initiatives.iter().enumerate() {
        let (ink, soft, state) = match (x.status.as_str(), x.progress.as_str()) {
            ("APPROVED", "EXECUTED") => (t.supported, t.supported_soft, "Done, measuring"),
            ("APPROVED", _) => (t.review, t.review_soft, "Approved, to do"),
            ("PROPOSED", _) => (t.partial, t.partial_soft, "Needs your OK"),
            ("REVIEWED", _) => (t.supported, t.supported_soft, "Reviewed"),
            ("CANCELLED", _) => (t.muted_foreground, t.accent, "Declined"),
            _ => (t.muted_foreground, t.accent, "Idea"),
        };
        let mut r = row()
            .key(format!("initiative-{k}"))
            .w_full()
            .h(44.0)
            .gap(12.0)
            .center_y()
            .child(label(x.title.clone(), type_::SM_13, t.foreground).truncate().grow(1.0).min_w(0.0))
            .child(crate::ui::widgets::status_chip(state, ink, soft));
        if k + 1 < n {
            r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
        }
        list = list.child(r);
    }
    board(t, "initiatives", "Work in progress", Some("What you approved, what waits on you, and what is done".into()), 340.0, list)
}

fn questions(t: &Theme, a: &Analytics, days: u32) -> El {
    if a.questions.is_empty() {
        return board(t, "questions", "Buyer questions", Some(format!("Last {days} days")), 340.0, note(t, "No questions were asked in this period."));
    }
    let mut list = col().w_full().gap(14.0);
    for (k, q) in a.questions.iter().take(12).enumerate() {
        list = list.child(
            col()
                .key(format!("question-{k}"))
                .w_full()
                .gap(6.0)
                .child(row().w_full().gap(8.0).center_y()
                    .child(label(q.prompt.clone(), type_::SM_13, t.foreground).truncate().grow(1.0).min_w(0.0))
                    .child(label(plural(q.checks, "answer", "answers"), type_::XS.features("'tnum' 1"), t.muted_foreground)))
                .child(charts::verdict_bar_fill(t, &q.v).w_full().h(6.0)),
        );
    }
    board(t, "questions", "Buyer questions", Some(format!("How assistants answered each one, last {days} days")), 340.0, list)
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
                    .child(grid(vec![fixed(discovery::answer_collection(t, &st, i.days), "fx-collection"), fixed(discovery::accuracy_by_model(t, a, &st), "fx-models")]))
                    .child(grid(vec![questions(t, a, i.days), fixed(discovery::citations(s, t, a, i.days), "fx-citations")]))
                    .child(grid(vec![fixed(facts(t, a), "fx-facts")])),
            );
        }
        Err(e) => c = c.child(panel(t, "answers-failed", "Answer analytics could not load", Some(e.clone()))),
    }
    c
}

/// A share as a tile: the percentage, what it is out of, and a bar.
fn share_tile(t: &Theme, key: &str, name: &str, part: Option<(f64, f64)>, of: &str) -> El {
    let (value, sub, frac) = match part {
        Some((n, d)) if d > 0.0 => (format!("{:.0}%", n / d * 100.0), format!("{} of {} {of}", int(n), int(d)), (n / d) as f32),
        _ => ("No data".into(), "Not measured yet".into(), 0.0),
    };
    card(t).key(key.to_string()).w(0.0).grow(1.0).min_w(170.0).h(128.0).px(18.0).py(16.0).gap(6.0)
        .child(label(name.to_string(), type_::XS_MEDIUM, t.muted_foreground).truncate())
        .child(label(value, rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1"), t.foreground))
        .child(el().grow(1.0))
        .child(row().w_full().h(4.0).radius(2.0).fill(t.foreground.alpha(0.06)).child(el().w_frac(frac.clamp(0.0, 1.0)).h_full().radius(2.0).fill(t.primary_ink)))
        .child(label(sub, type_::XS.features("'tnum' 1"), t.muted_foreground).truncate())
}

/// "n of d" back into numbers.
fn of_pair(s: &str) -> Option<(f64, f64)> {
    let (n, d) = s.split_once(" of ")?;
    Some((n.trim().replace(',', "").parse().ok()?, d.trim().replace(',', "").parse().ok()?))
}

/// What AI assistants say about you, and visits they sent, as four tiles.
fn discovery_panel(t: &Theme, d: &Result<Option<Discovery>, String>) -> El {
    let d = match d {
        Ok(Some(d)) => d,
        Ok(None) => return label("Nothing measured yet. Answers and visits from AI assistants show here once they are checked.", type_::SM_13, t.muted_foreground).wrap(),
        Err(_) => return label("This could not load right now. That does not mean there is nothing to show.", type_::SM_13, t.muted_foreground).wrap(),
    };
    let (surface, range) = d.period.as_ref().map(|p| (p.0.clone(), p.4.clone())).unwrap_or_default();
    let mentions = d.period.as_ref().and_then(|p| of_pair(&p.2));
    let cited = d.period.as_ref().and_then(|p| of_pair(&p.3));
    let visits = d.referral.as_ref().map(|r| (r.0, r.1));
    let signups = d.referral.as_ref().and_then(|r| r.3);
    if mentions.is_none() && cited.is_none() && visits.is_none() && signups.is_none() {
        return label("Mentions, links and visits from AI assistants show here once they are measured. Ask the agent to set this up.", type_::SM_13, t.muted_foreground).wrap();
    }
    let signup_tile = card(t).key("ai-signups").w(0.0).grow(1.0).min_w(170.0).h(128.0).px(18.0).py(16.0).gap(6.0)
        .child(label("Sign-ups after those visits", type_::XS_MEDIUM, t.muted_foreground).truncate())
        .child(label(signups.map(int).unwrap_or_else(|| "No data".into()), rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1"), t.foreground))
        .child(el().grow(1.0))
        .child(label(d.referral.as_ref().map(|r| r.2.clone()).unwrap_or_else(|| "Not measured yet".into()), type_::XS, t.muted_foreground).truncate());
    col().key("discovery").w_full().gap(10.0)
        .child(row().w_full().gap(16.0).flex_wrap()
            .child(share_tile(t, "ai-mentions", "Answers that mention you", mentions, "answers"))
            .child(share_tile(t, "ai-cited", "Answers that link to your site", cited, "answers"))
            .child(share_tile(t, "ai-visits", "Visits from AI assistants", visits, "visits"))
            .child(signup_tile))
        .child(label(
            if surface.is_empty() { "Visits come from your Google Analytics export and are counted separately from the answers.".to_string() } else { format!("Answers from {surface}, {range}. Visits come from your Google Analytics export and are counted separately.") },
            type_::XS, t.muted_foreground).wrap())
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

/// One connected account: its key numbers as tiles, then its top rows as bars
/// beside every number against the period before.
fn report(t: &Theme, key: &str, r: &Report) -> El {
    let mut tiles = row().w_full().gap(16.0).flex_wrap();
    for (k, m) in r.metrics.iter().take(4).enumerate() {
        let lower_is_better = m.label.to_lowercase().contains("position") || m.label.to_lowercase().contains("cost per") || m.label.to_lowercase().contains("refund");
        tiles = tiles.child(stat_tile(t, &format!("{key}-metric-{k}"), &m.label, &m.value, m.delta, !lower_is_better));
    }
    let mut boards = Vec::new();
    if let Some((head, rows)) = &r.table {
        let ranked: Vec<(String, f64, String)> = rows.iter().filter_map(|row_| {
            let v = row_.get(1)?;
            Some((row_.first()?.clone(), number(v)?, format!("{} {}", v, head.get(1).map(|h| h.to_lowercase()).unwrap_or_default())))
        }).collect();
        if !ranked.is_empty() {
            boards.push(board(t, &format!("{key}-top"), head.first().map(String::as_str).unwrap_or("Top"), Some(format!("Ranked by {}", head.get(1).map(|h| h.to_lowercase()).unwrap_or_default())), 340.0, bar_list(t, &format!("{key}-bars"), &ranked)));
        }
    }
    if r.metrics.iter().any(|m| m.delta.is_some()) {
        boards.push(board(t, &format!("{key}-compare"), "Against the period before", Some("Same length, just before this one".into()), 340.0, compare_list(t, &format!("{key}-cmp"), r)));
    }
    let mut c = col().key(key.to_string()).w_full().gap(16.0)
        .child(row().w_full().gap(10.0).center_y()
            .child(el().size(8.0, 8.0).radius(4.0).fill(t.supported))
            .child(label(r.title.clone(), type_::BASE_MEDIUM, t.foreground).role("heading"))
            .child(label(r.subtitle.clone(), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0)))
        .child(tiles);
    if !boards.is_empty() {
        c = c.child(grid(boards));
    }
    if let Some(n) = &r.note {
        c = c.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    c
}

/// A source that isn't connected yet: one quiet row with the way to connect it.
fn source(t: &Theme, key: &str, title: &str, src: &Source) -> El {
    match src {
        Source::Reports(list) => {
            let mut c = col().w_full().gap(40.0);
            for (k, r) in list.iter().enumerate() {
                c = c.child(report(t, &format!("{key}-{k}"), r));
            }
            c
        }
        Source::NotConnected(why) => shadows(row().key(key.to_string()).w_full().h(76.0).px(20.0).radius(12.0).fill(t.card).gap(14.0).center_y(), &t.card_shadow)
            .child(el().size(8.0, 8.0).radius(4.0).fill(t.muted_foreground.alpha(0.5)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(title.to_string(), type_::SM_MEDIUM, t.foreground)).child(label(why.clone(), type_::XS, t.muted_foreground).truncate()))
            .child(button(t, &format!("{key}-connect"), "Connect", Variant::Outline).on_press(|s: &mut App| s.show_page(Page::Channels))),
        Source::Failed(e) => shadows(row().key(key.to_string()).w_full().h(76.0).px(20.0).radius(12.0).fill(t.card).gap(14.0).center_y(), &t.card_shadow)
            .child(el().size(8.0, 8.0).radius(4.0).fill(t.wrong))
            .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(format!("{title} could not load"), type_::SM_MEDIUM, t.foreground)).child(label(e.clone(), type_::XS, t.muted_foreground).truncate())),
    }
}

fn performance(t: &Theme, i: &Insights) -> El {
    col()
        .w_full()
        .gap(40.0)
        .child(source(t, "search", "Google Search", &i.search))
        .child(source(t, "ads", "Ads", &i.ads))
        .child(source(t, "local", "Google Business Profile", &i.local))
        .child(label("Each source counts in its own way and over its own dates, so their numbers are never added together.", type_::XS, t.muted_foreground).wrap())
}

fn revenue(s: &App, t: &Theme, i: &Insights) -> El {
    let Some(r) = &i.revenue_data else {
        return col().w_full().gap(24.0).child(source(t, "revenue", "Stripe", &i.revenue));
    };
    let cur = r.currency.as_str();
    let change = |now: f64, before: f64| (before > 0.0).then(|| (now - before) / before);
    let money = |x: f64| crate::insights::money(x, cur);
    // The hero: net revenue, its change, and every day of the period as a
    // column with the period before as a dotted line behind it.
    let dates: Vec<String> = r.daily.iter().map(|d| d.0.clone()).collect();
    let values: Vec<Option<f64>> = r.daily.iter().map(|d| Some(d.1)).collect();
    let before: Vec<Option<f64>> = (0..values.len()).map(|k| r.before.get(k).copied()).collect();
    let d = change(r.net.0, r.net.1);
    let mut pill = row().gap(8.0).center_y();
    if let Some(d) = d {
        let (ink, soft) = if d >= 0.0 { (t.supported, t.supported_soft) } else { (t.wrong, t.wrong_soft) };
        pill = pill.child(row().h(22.0).px(8.0).radius(6.0).center().fill(soft).child(label(change_text(d), type_::XS_MEDIUM.features("'tnum' 1"), ink)));
    }
    pill = pill.child(label(format!("vs {} the period before", money(r.net.1)), type_::XS, t.muted_foreground));
    let hero = card(t)
        .key("revenue-hero")
        .w(0.0)
        .grow(2.0)
        .min_w(420.0)
        .h(432.0)
        .px(24.0)
        .py(20.0)
        .gap(6.0)
        .child(row().w_full().gap(8.0).center_y()
            .child(label("Net revenue", type_::SM_MEDIUM, t.muted_foreground))
            .child(el().grow(1.0))
            .child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(4.0).fill(t.supported)).child(label(format!("Stripe, {}", r.account), type_::XS, t.muted_foreground))))
        .child(label(money(r.net.0), rune::TextStyle::new(34.0, 600.0).lh(42.0).features("'tnum' 1"), t.foreground))
        .child(pill)
        .child(el().h(10.0))
        .child(charts::area_trend(s, t, charts::Trend::new("revenue-daily", "Net revenue", &dates, &values, t.chart.primary).compare(&before, "Period before".into()).height(220.0).width_hint(760.0)))
        .child(row().gap(16.0).pt(4.0)
            .child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(2.0).fill(t.chart.primary)).child(label("Each day", type_::XS11, t.muted_foreground)))
            .child(charts::dotted_label(t, "Same day, period before")));

    // Where the money went: gross, refunds and what was kept, as one bar.
    let kept = if r.gross.0 > 0.0 { (r.net.0 / r.gross.0) as f32 } else { 1.0 };
    let line = |name: &str, value: String, dot: Color| row().w_full().h(30.0).gap(10.0).center_y()
        .child(el().size(8.0, 8.0).radius(2.0).fill(dot))
        .child(label(name.to_string(), type_::SM_13, t.muted_foreground).grow(1.0))
        .child(label(value, type_::SM_13.features("'tnum' 1"), t.foreground));
    let split = card(t)
        .key("revenue-split")
        .w(0.0)
        .grow(1.0)
        .min_w(300.0)
        .h(432.0)
        .px(24.0)
        .py(20.0)
        .gap(14.0)
        .child(col().gap(2.0).child(label("Where it went", type_::SM_MEDIUM, t.foreground).role("heading")).child(label("From what was charged to what you kept", type_::XS, t.muted_foreground)))
        .child(row().w_full().h(14.0).radius(7.0).clip_rounded(7.0).gap(2.0)
            .child(el().h_full().grow(kept.max(0.001)).fill(t.chart.supported))
            .child(el().h_full().grow((1.0 - kept).max(0.001)).fill(t.chart.wrong)))
        .child(col().w_full()
            .child(line("Charged", money(r.gross.0), t.foreground.alpha(0.25)))
            .child(line("Refunded", format!("−{}", money(r.refunded.0)), t.chart.wrong))
            .child(line("Kept", money(r.net.0), t.chart.supported)))
        .child(el().grow(1.0))
        .child(col().w_full().gap(4.0).pt(12.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border)
            .child(label("Refund rate", type_::XS, t.muted_foreground))
            .child(label(if r.gross.0 > 0.0 { format!("{:.1}%", r.refunded.0 / r.gross.0 * 100.0) } else { "—".into() }, rune::TextStyle::new(22.0, 600.0).lh(28.0).features("'tnum' 1"), t.foreground)));

    let opt = |x: Option<f64>| x.unwrap_or(0.0);
    let tiles = row().w_full().gap(16.0).flex_wrap()
        .child(stat_tile(t, "rev-orders", "Orders", &crate::insights::int(r.orders.0), change(r.orders.0, r.orders.1), true))
        .child(stat_tile(t, "rev-average", "Average order", &r.average.0.map(money).unwrap_or_else(|| "—".into()), r.average.0.zip(r.average.1).and_then(|(a, b)| change(a, b)), true))
        .child(stat_tile(t, "rev-paying", "Paying customers", &crate::insights::int(r.paying.0), change(r.paying.0, r.paying.1), true))
        .child(stat_tile(t, "rev-new", "New customers", &r.new_customers.0.map(crate::insights::int).unwrap_or_else(|| "—".into()), change(opt(r.new_customers.0), opt(r.new_customers.1)), true));
    let mut c = col().w_full().gap(16.0).child(row().w_full().gap(16.0).items_stretch().flex_wrap().child(hero).child(split)).child(tiles);
    if let Some(n) = &r.note {
        c = c.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    c.child(label(format!("{}. Sales come straight from Stripe: what was paid, not which marketing brought it in.", r.subtitle), type_::XS, t.muted_foreground).wrap().pt(8.0))
}

// ---- Funnel, events, realtime -----------------------------------------------

fn funnel(t: &Theme, i: &Insights) -> El {
    let goal = i.goal.as_ref().ok().and_then(Option::as_ref);
    let rows: [(&str, String, Section, &str); 3] = [
        ("Discovery", "Search, ads and what AI assistants say.".into(), Section::Performance, "View performance"),
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
