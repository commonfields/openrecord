//! The Overview and its sections (`routes/today.tsx`): Summary, Performance,
//! Revenue, Funnel, Events, Realtime and AI discovery.

use rune::{Color, Cursor, El, col, el, row};

use crate::format;
use crate::insights::{Analytics, Discovery, Goal, Insights, PERIODS, Report, Section, Source, Verdicts, int, pct};
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::{charts, discovery, kit};
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
            Section::Performance => performance(s, t, i),
            Section::Revenue => revenue(s, t, i),
            Section::Funnel => funnel(s, t, i),
            Section::Events => events(s, t, i),
            Section::Realtime => realtime(s, t, i),
            Section::Answers => answers(s, t, i),
        },
        Load::Failed(e) => failure(t, "insights-failed", e, |s: &mut App| s.refresh()),
        _ => col().w_full().gap(16.0).child(skeleton(t, 1)).child(skeleton(t, 2)),
    };
    col().key(format!("overview-{}", sec.key())).w_full().gap(24.0).child(head).child(body)
}

fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(request);
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
    // A height of 0 lets the card follow its content.
    let c = card(t).key(key.to_string()).w(0.0).grow(1.0).min_w(280.0).px(20.0).py(18.0).gap(14.0).child(head);
    if height > 0.0 {
        c.h(height).clip_rounded(12.0).child(col().key(format!("{key}-body")).w_full().grow(1.0).min_h(0.0).child(body).scroll(rune::ScrollSpec { stick_bottom: false }))
    } else {
        c.child(col().key(format!("{key}-body")).w_full().child(body))
    }
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
pub fn number(v: &str) -> Option<f64> {
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
                .child(row().w_full().h(6.0).radius(3.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((v / max) as f32).h_full().radius(3.0).fill(t.chart.tone(k).alpha(0.9)))),
        );
    }
    c
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
        boards.push(questions(t, a, i.days, 340.0));
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
            // Other sections keep the range in the page header.
            .children((s.section == Section::Summary).then(|| periods(s, t)))
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
    let mut strip = row().key("kpis").w_full().gap(0.0).items_stretch().flex_wrap().role("group").label("Key numbers");
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
    for (k, x) in i.initiatives.iter().enumerate() {
        let (ink, soft, state) = match (x.status.as_str(), x.progress.as_str()) {
            ("APPROVED", "EXECUTED") => (t.supported, t.supported_soft, "Done, measuring"),
            ("APPROVED", _) => (t.review, t.review_soft, "Approved, to do"),
            ("PROPOSED", _) => (t.partial, t.partial_soft, "Needs your OK"),
            ("REVIEWED", _) => (t.supported, t.supported_soft, "Reviewed"),
            ("CANCELLED", _) => (t.muted_foreground, t.accent, "Declined"),
            _ => (t.muted_foreground, t.accent, "Idea"),
        };
        let r = row()
            .key(format!("initiative-{k}"))
            .w_full()
            .h(44.0)
            .gap(12.0)
            .center_y()
            .child(label(x.title.clone(), type_::SM_13, t.foreground).truncate().grow(1.0).min_w(0.0))
            .child(crate::ui::widgets::status_chip(t, state, ink, soft));
        list = list.child(r);
    }
    board(t, "initiatives", "Work in progress", Some("What you approved, what waits on you, and what is done".into()), 340.0, list)
}

fn questions(t: &Theme, a: &Analytics, days: u32, height: f32) -> El {
    if a.questions.is_empty() {
        return board(t, "questions", "Buyer questions", Some(format!("Last {days} days")), height, note(t, "No questions were asked in this period."));
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
    board(t, "questions", "Buyer questions", Some(format!("How assistants answered each one, last {days} days")), height, list)
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
                    .child(kit::cols(vec![discovery::answer_collection(t, &st, i.days), discovery::accuracy_by_model(t, a, &st)]))
                    .child(kit::cols(vec![questions(t, a, i.days, 0.0), discovery::citations(s, t, a, i.days)]))
                    .child(kit::cols(vec![ratings(t, a, i.days), facts(t, a)])),
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

/// How every answer of the period was rated, against the period before.
fn ratings(t: &Theme, a: &Analytics, days: u32) -> El {
    let (v, p) = (&a.current, &a.previous);
    let c = &t.chart;
    let part = |name: &str, now: i64, before: i64, ink: Color| (name.to_string(), now as f64, ink, if before > 0 || p.total() > 0 { format!("{} ({}{})", int(now as f64), if now >= before { "+" } else { "" }, now - before) } else { int(now as f64) });
    let parts = vec![
        part("Correct", v.supported, p.supported, c.supported),
        part("Partly right", v.partial, p.partial, c.partial),
        part("Wrong", v.wrong, p.wrong, c.wrong),
        part("Can't tell", v.unknown, p.unknown, c.unknown),
        part("Not checked yet", v.unreviewed, p.unreviewed, c.unreviewed),
    ];
    let shift = v.accuracy().zip(p.accuracy()).map(|(x, y)| (x - y) * 100.0);
    let sub = match (v.accuracy(), shift) {
        (Some(x), Some(d)) => format!("{} correct, {}{d:.0} points against the {days} days before", pct(x), if d >= 0.0 { "+" } else { "" }),
        (Some(x), None) => format!("{} correct in the last {days} days", pct(x)),
        _ => "Nothing rated yet".into(),
    };
    let body = if v.total() == 0 { note(t, "No answers were rated in this period.") } else { kit::split(t, "ratings-split", &parts) };
    panel(t, "ratings", "How answers were rated", Some(sub)).child(body).child(label("Counts of rated answers; the change in brackets is against the period before.", type_::XS, t.muted_foreground).wrap())
}

fn facts(t: &Theme, a: &Analytics) -> El {
    let p = panel(t, "facts", "Your facts in AI answers", Some("How answers held up against each approved fact.".into()));
    if a.facts.is_empty() {
        return p.child(note(t, "No approved fact was tested in this period."));
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
    p.child(list)
}

// ---- Performance and revenue ------------------------------------------------

/// One metric as an analytics card: its value and change, and every day of the
/// period as a line over the same day of the period before (dashed).
fn metric_chart(s: &App, t: &Theme, key: &str, m: &crate::insights::Metric, tone: Color) -> El {
    let mut head = row().w_full().gap(8.0).center_y().child(label(m.label.clone(), type_::SM_MEDIUM, t.muted_foreground).grow(1.0).min_w(0.0).truncate());
    if let Some(d) = m.delta {
        let good = (d >= 0.0) != m.lower_better;
        let (ink, soft) = if d.abs() < 0.005 { (t.muted_foreground, t.accent) } else if good { (t.supported, t.supported_soft) } else { (t.wrong, t.wrong_soft) };
        head = head.child(row().h(22.0).px(8.0).radius(6.0).center().fill(soft).child(label(change_text(d), type_::XS_MEDIUM.features("'tnum' 1"), ink)));
    }
    let mut c = card(t).key(key.to_string()).w(0.0).grow(1.0).min_w(360.0).h(318.0).px(22.0).py(18.0).gap(4.0)
        .child(head)
        .child(label(m.value.clone(), rune::TextStyle::new(26.0, 600.0).lh(34.0).features("'tnum' 1"), t.foreground));
    if let Some(d) = &m.days {
        let mut tr = charts::Trend::new(key, &m.label, &d.dates, &d.now, tone).compare(&d.before, "Period before".into()).height(176.0).width_hint(520.0);
        if m.percent {
            tr = tr.percent();
        }
        c = c.child(el().h(8.0)).child(charts::area_trend(s, t, tr));
    }
    c
}

/// One connected account: a chart per key number, this period over the one
/// before, then what the source sends beyond them (its queries, campaigns or
/// profile actions).
fn report(s: &App, t: &Theme, key: &str, r: &Report) -> El {
    use crate::insights::Detail;
    let charted = r.metrics.iter().any(|m| m.days.is_some());
    let mut c = col().key(key.to_string()).w_full().gap(16.0)
        .child(row().w_full().gap(10.0).center_y()
            .child(el().size(8.0, 8.0).radius(4.0).fill(t.supported))
            .child(label(r.title.clone(), type_::BASE_MEDIUM, t.foreground).role("heading"))
            .child(label(r.subtitle.clone(), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
            .children(charted.then(|| row().gap(14.0).center_y()
                .child(row().gap(6.0).center_y().child(el().w(14.0).h(2.0).radius(1.0).fill(t.muted_foreground)).child(label("This period", type_::XS11, t.muted_foreground)))
                .child(charts::dotted_label(t, "Period before")))));
    if charted {
        let cards: Vec<El> = r.metrics.iter().take(4).enumerate().map(|(k, m)| metric_chart(s, t, &format!("{key}-chart-{k}"), m, t.chart.tone(k))).collect();
        let mut it = cards.into_iter();
        while let Some(a) = it.next() {
            let mut pair = vec![a];
            if let Some(b) = it.next() {
                pair.push(b);
            }
            // Wraps to one per row when the window is too narrow for two charts.
            c = c.child(grid(pair));
        }
    } else if !matches!(r.detail, Detail::Local(_)) {
        let tiles: Vec<El> = r.metrics.iter().take(4).enumerate().map(|(k, m)| stat_tile(t, &format!("{key}-metric-{k}"), &m.label, &m.value, m.delta, !m.lower_better)).collect();
        c = c.child(kit::cols(tiles));
    }
    match &r.detail {
        Detail::Search { queries, pages } => c = c.child(crate::ui::sources::search(s, t, key, queries, pages)),
        Detail::Ads(d) => c = c.child(crate::ui::sources::ads(t, key, d)),
        Detail::Local(d) => c = c.child(crate::ui::sources::local(t, key, d)),
        Detail::None => {
            if let Some((head, rows)) = &r.table {
                let mut ranked: Vec<(String, f64, String)> = rows.iter().filter_map(|row_| {
                    let v = row_.get(1)?;
                    Some((row_.first()?.clone(), number(v)?, format!("{} {}", v, head.get(1).map(|h| h.to_lowercase()).unwrap_or_default())))
                }).collect();
                if !ranked.is_empty() {
                    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                    c = c.child(board(t, &format!("{key}-top"), head.first().map(String::as_str).unwrap_or("Top"), Some(format!("Ranked by {}", head.get(1).map(|h| h.to_lowercase()).unwrap_or_default())), 0.0, bar_list(t, &format!("{key}-bars"), &ranked)));
                }
            }
        }
    }
    // A profile's note repeats its reviews, which the detail already shows.
    if let Some(n) = r.note.as_ref().filter(|_| !matches!(r.detail, Detail::Local(_))) {
        c = c.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    c
}

/// A source that isn't connected yet: one quiet row with the way to connect it.
fn source(s: &App, t: &Theme, key: &str, title: &str, src: &Source) -> El {
    match src {
        Source::Reports(list) => {
            let mut c = col().w_full().gap(40.0);
            for (k, r) in list.iter().enumerate() {
                c = c.child(report(s, t, &format!("{key}-{k}"), r));
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

fn performance(s: &App, t: &Theme, i: &Insights) -> El {
    col()
        .w_full()
        .gap(40.0)
        .child(coverage(t, i))
        .child(source(s, t, "search", "Google Search", &i.search))
        .child(source(s, t, "ads", "Ads", &i.ads))
        .child(source(s, t, "local", "Google Business Profile", &i.local))
        .child(label("Each source counts in its own way and over its own dates, so their numbers are never added together.", type_::XS, t.muted_foreground).wrap())
}

/// Which sources report into this page, as a row of small chips, so a gap is visible before scrolling.
fn coverage(t: &Theme, i: &Insights) -> El {
    let chip = |name: &str, src: &Source| {
        let (dot, state) = match src {
            Source::Reports(_) => (t.supported, "Connected"),
            Source::NotConnected(_) => (t.muted_foreground.alpha(0.5), "Not connected"),
            Source::Failed(_) => (t.wrong, "Could not load"),
        };
        row().gap(8.0).px(12.0).h(32.0).radius(8.0).center_y().fill(t.card)
            .child(el().size(7.0, 7.0).radius(4.0).fill(dot))
            .child(label(name.to_string(), type_::XS_MEDIUM, t.foreground))
            .child(label(state, type_::XS, t.muted_foreground))
    };
    let mut r = row().key("perf-coverage").w_full().gap(8.0).flex_wrap().center_y()
        .child(chip("Google Search", &i.search))
        .child(chip("Ads", &i.ads))
        .child(chip("Google Business Profile", &i.local));
    if i.realtime.is_some() {
        r = r.child(row().gap(8.0).px(12.0).h(32.0).radius(8.0).center_y().fill(t.card).child(el().size(7.0, 7.0).radius(4.0).fill(t.supported)).child(label("Google Analytics", type_::XS_MEDIUM, t.foreground)).child(label("Connected", type_::XS, t.muted_foreground)));
    }
    r
}

fn revenue(s: &App, t: &Theme, i: &Insights) -> El {
    let Some(r) = &i.revenue_data else {
        return col().w_full().gap(24.0).child(source(s, t, "revenue", "Stripe", &i.revenue));
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
        .child(charts::area_trend(s, t, charts::Trend::new("revenue-daily", "Net revenue", &dates, &values, t.chart.tone(1)).compare(&before, "Period before".into()).height(220.0).width_hint(760.0)))
        .child(row().gap(16.0).pt(4.0)
            .child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(2.0).fill(t.chart.tone(1))).child(label("Each day", type_::XS11, t.muted_foreground)))
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
    c = c.child(crate::ui::sources::revenue(s, t, i, r));
    c.child(label(format!("{}. Sales come straight from Stripe: what was paid, not which marketing brought it in.", r.subtitle), type_::XS, t.muted_foreground).wrap().pt(8.0))
}

// ---- Funnel, events, realtime -----------------------------------------------

/// The journey as a funnel: seen in search, clicked, the goal, paid. Each
/// step is a band narrowing to the next, with its count, its change and the
/// share that reached the next step.
fn funnel(s: &App, t: &Theme, i: &Insights) -> El {
    let metric = |src: &Source, name: &str| match src {
        Source::Reports(list) => list.first().and_then(|r| r.metrics.iter().find(|m| m.label == name)).and_then(|m| number(&m.value).map(|v| (v, m.delta))),
        _ => None,
    };
    let goal = i.goal.as_ref().ok().and_then(Option::as_ref);
    let goal_step = goal.map(|g| {
        let cut = format::iso_date(format::now() - i.days as i64 * 86_400);
        let start = format::iso_date(format::now() - 2 * i.days as i64 * 86_400);
        let now: f64 = g.points.iter().filter(|(d, _)| d.as_str() > cut.as_str()).map(|p| p.1).sum();
        let before: f64 = g.points.iter().filter(|(d, _)| d.as_str() <= cut.as_str() && d.as_str() > start.as_str()).map(|p| p.1).sum();
        (g.label.clone(), now, (before > 0.0).then(|| (now - before) / before))
    });
    let mut steps: Vec<(String, f64, Option<f64>, &str)> = Vec::new();
    if let Some((v, d)) = metric(&i.search, "Impressions") {
        steps.push(("Saw you in Google".into(), v, d, "Search Console"));
    }
    if let Some((v, d)) = metric(&i.search, "Clicks") {
        steps.push(("Clicked through".into(), v, d, "Search Console"));
    }
    if let Some((label, v, d)) = goal_step {
        steps.push((label, v, d, "Your goal"));
    }
    if let Some(r) = &i.revenue_data {
        steps.push(("Paid".into(), r.paying.0, (r.paying.1 > 0.0).then(|| (r.paying.0 - r.paying.1) / r.paying.1), "Stripe"));
    }
    if steps.len() < 2 {
        return panel(t, "funnel", "Not enough connected yet to draw the journey", None)
            .child(note(t, "The funnel needs at least two steps: Search Console for how people find you, a goal for what they do, and Stripe for who pays."))
            .child(row().child(button(t, "funnel-connect", "Connect on the Channels page", Variant::Outline).on_press(|s: &mut App| s.show_page(Page::Channels))));
    }
    // Widths on a log scale so a step a hundred times smaller still shows.
    let top = steps[0].1.max(1.0).ln();
    let width = |v: f64| (0.22 + 0.78 * (v.max(1.0).ln() / top.max(0.001))).clamp(0.22, 1.0) as f32;
    let (w_px, band, gap) = (420.0f32, 70.0f32, 24.0f32);
    let n = steps.len();
    let h = n as f32 * band + (n - 1) as f32 * gap;
    let mut sh = rune::Shape::new();
    for (k, st) in steps.iter().enumerate() {
        let y0 = k as f32 * (band + gap);
        let (a, b) = (width(st.1), steps.get(k + 1).map(|x| width(x.1)).unwrap_or(width(st.1) * 0.9));
        let (l0, r0) = (w_px * (1.0 - a) / 2.0, w_px * (1.0 + a) / 2.0);
        let (l1, r1) = (w_px * (1.0 - b) / 2.0, w_px * (1.0 + b) / 2.0);
        let shade = t.chart.tone(k).alpha(0.82);
        sh = sh.fill(vec![[l0, y0], [r0, y0], [r0 - (r0 - r1) * 0.25, y0 + band], [l0 + (l1 - l0) * 0.25, y0 + band]], shade);
        if k + 1 < n {
            // The narrowing to the next step, faint.
            sh = sh.fill(vec![[l0 + (l1 - l0) * 0.25, y0 + band], [r0 - (r0 - r1) * 0.25, y0 + band], [r1, y0 + band + gap], [l1, y0 + band + gap]], t.chart.tone(k).alpha(0.1));
        }
    }
    let shape = rune::canvas(sh.view_box(w_px, h)).size(w_px, h).a11y_hidden();
    let mut labels = col().w(180.0).gap(gap);
    let mut values = col().w(220.0).gap(gap);
    for (k, (name, v, d, src)) in steps.iter().enumerate() {
        labels = labels.child(col().h(band).justify_center().gap(2.0).child(label(name.clone(), type_::SM_MEDIUM, t.foreground)).child(label(src.to_string(), type_::XS, t.muted_foreground)));
        let mut right = col().h(band).justify_center().gap(2.0).child(row().gap(8.0).center_y()
            .child(label(crate::insights::int(*v), rune::TextStyle::new(20.0, 600.0).lh(26.0).features("'tnum' 1"), t.foreground))
            .children(d.map(|d| label(change_text(d), type_::XS_MEDIUM.features("'tnum' 1"), if d >= 0.0 { t.supported } else { t.wrong }))));
        if let Some(next) = steps.get(k + 1) {
            if *v > 0.0 {
                right = right.child(label(format!("{:.1}% reached the next step", next.1 / v * 100.0), type_::XS, t.muted_foreground).truncate());
            }
        }
        values = values.child(right);
    }
    col().w_full().gap(16.0)
        .child(card(t).key("funnel").w_full().px(28.0).py(28.0).gap(20.0)
            .child(col().gap(2.0).child(label(format!("The last {} days", i.days), type_::SM_MEDIUM, t.foreground).role("heading")).child(label("From being seen to paying, step by step", type_::XS, t.muted_foreground)))
            .child(row().w_full().gap(20.0).items_start().justify_center().child(labels.child(el())).child(shape).child(values)))
        .child(label("Each step comes from its own source and counts in its own way, so the steps are not the same people followed through. Read the rates as a guide, not an exact conversion rate.", type_::XS, t.muted_foreground).wrap())
        .child(crate::ui::sources::funnel(s, t, i, &steps))
}

fn events(s: &App, t: &Theme, i: &Insights) -> El {
    let goal: Option<&Goal> = i.goal.as_ref().ok().and_then(Option::as_ref);
    let mut c = col().w_full().gap(16.0);
    match (&i.goal, goal) {
        (Err(e), _) => c = c.child(panel(t, "events", "Your saved goal could not load", Some(e.clone()))),
        (_, None) => {
            c = c.child(panel(t, "events", "No goal event configured", Some("Choose the one action that matters most, such as a sign-up or a booking, and it is tracked here day by day.".into())).child(
                row().child(button(t, "ask-goal-event", "Set a goal with the agent", Variant::Outline).on_press(ask(
                    "Help me set the main goal for this business: what we want more of, and the event that measures it.",
                ))),
            ))
        }
        (_, Some(g)) => {
            let chart = card(t).key("goal-card").h(420.0).px(24.0).py(20.0).clip_rounded(12.0).child(goal_card(s, t, i));
            c = c.child(crate::ui::sources::events(s, t, i, g, chart));
        }
    }
    c.child(crate::ui::sources::other_actions(t, i))
}

/// A country's flag (its emoji), or its code on a small tile when the code is not a country.
fn flag(t: &Theme, code: &str) -> El {
    let up = code.to_uppercase();
    if up.len() == 2 && up.chars().all(|c| c.is_ascii_uppercase()) {
        let emoji: String = up.chars().map(|c| char::from_u32(0x1F1E6 + (c as u32 - 'A' as u32)).unwrap_or(c)).collect();
        return row().w(28.0).h(20.0).center().help(up).child(rune::text(emoji).font(rune::TextStyle::new(17.0, 400.0).lh(20.0)));
    }
    row().h(18.0).w(28.0).radius(4.0).center().fill(t.accent).child(label(up, type_::XS2.lh(14.0), t.muted_foreground))
}

/// Who is on the site now: the key numbers, a world map of where people are
/// (zoom and pan), then the latest activity and the countries ranked.
fn realtime(s: &App, t: &Theme, i: &Insights) -> El {
    let Some(r) = &i.realtime else {
        return panel(t, "realtime", "Connect Google Analytics to see who is on your site now", None)
            .child(note(t, "Realtime reads your Google Analytics property: people on the site in the last 30 minutes, where they are and what they read."))
            .child(row().child(button(t, "realtime-connect", "Connect on the Channels page", Variant::Outline).on_press(|s: &mut App| s.show_page(Page::Channels))));
    };
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    let pulse = (0.55 + 0.45 * (now_ms / 600.0).sin().abs()) as f32;
    let opt = |x: Option<f64>| x.map(crate::insights::int).unwrap_or_else(|| "—".into());
    let live = row().gap(6.0).center_y().child(el().size(7.0, 7.0).radius(4.0).fill(t.chart.primary.alpha(pulse))).child(label("Live", type_::XS11, t.muted_foreground));
    let thirty = || label("30 min", type_::XS11, t.muted_foreground);
    let strip = row()
        .key("rt-kpis")
        .w_full()
        .gap(0.0)
        .items_stretch()
        .flex_wrap()
        .child(kpi(t, "rt-online", "Online now", crate::insights::int(r.active), None, Some(live), None, false, None))
        .child(kpi(t, "rt-visitors", "Visitors", opt(r.visitors), None, Some(thirty()), None, false, None))
        .child(kpi(t, "rt-views", "Views", opt(r.views), None, Some(thirty()), None, false, None))
        .child(kpi(t, "rt-events", "Events", opt(r.events), None, Some(thirty()), None, false, None));
    let located = r.countries.iter().filter(|c| crate::ui::world::centre(&c.0).is_some()).count();
    let map = card(t)
        .key("realtime-map")
        .w_full()
        .px(16.0)
        .pt(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .px(4.0)
                .gap(8.0)
                .center_y()
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(label("Online visitors", type_::SM_MEDIUM, t.foreground).role("heading"))
                        .child(label(format!("{} online now, last 30 minutes, {located} {}", crate::insights::int(r.active), if located == 1 { "location" } else { "locations" }), type_::XS, t.muted_foreground)),
                )
                .child(label("Pinch or ⌘ and scroll to zoom, drag to move", type_::XS11, t.muted_foreground)),
        )
        .child(crate::ui::world::view(s, t, 520.0, &r.countries));

    // The latest events, when the source reports them; otherwise the pages being read.
    let activity = if r.activity.is_empty() {
        let pages: Vec<(String, f64, String)> = r.pages.iter().map(|p| (p.0.clone(), p.1, format!("{} reading", crate::insights::int(p.1)))).collect();
        kit::panel(t, "rt-activity", "What they are reading", Some("Last 30 minutes".into()), None, 340.0, if pages.is_empty() { note(t, "No pages reported yet.") } else { kit::bars(t, "rt-pages", &pages, Some(t.chart.primary)) })
    } else {
        const COLS: [kit::Column; 3] = [kit::column("Event", 0.0, false), kit::column("Page", 0.0, false), kit::column("Time", 84.0, true)];
        let rows: Vec<Vec<El>> = r
            .activity
            .iter()
            .map(|(e, p, m)| vec![label(e.clone(), type_::SM_13, t.foreground).truncate(), kit::faint(t, p.clone()).truncate(), kit::faint(t, if *m < 1.0 { "Just now".to_string() } else { format!("{m:.0} min ago") })])
            .collect();
        kit::panel(t, "rt-activity", "Activity", Some("Last 30 minutes, newest first".into()), None, 340.0, kit::table(t, "rt-activity-table", &COLS, rows))
    };
    let most = r.countries.iter().map(|c| c.2).fold(1.0, f64::max);
    let mut list = col().w_full().gap(6.0);
    for (k, (code, name, users)) in r.countries.iter().take(20).enumerate() {
        list = list.child(
            row()
                .key(format!("rt-country-{k}"))
                .w_full()
                .h(28.0)
                .gap(10.0)
                .center_y()
                .child(
                    // The bar sits behind the flag and name, as long as the country's share of the busiest.
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .h_full()
                        .px(6.0)
                        .gap(8.0)
                        .center_y()
                        .child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w_frac((users / most) as f32).radius(5.0).fill(t.chart.primary.alpha(0.16)))
                        .child(flag(t, code))
                        .child(label(name.clone(), type_::XS_MEDIUM, t.foreground).truncate().min_w(0.0)),
                )
                .child(label(crate::insights::int(*users), type_::XS.features("'tnum' 1"), t.muted_foreground).w(32.0)),
        );
    }
    let countries = kit::panel(t, "rt-countries", "Countries", Some("Last 30 minutes".into()), None, 340.0, list);
    // The last 30 minutes as columns, newest on the right.
    let peak = r.per_minute.iter().copied().fold(1.0, f64::max);
    let mut minutes = row().w_full().h(120.0).gap(3.0).items_end();
    for (k, v) in r.per_minute.iter().enumerate() {
        let last = k + 1 == r.per_minute.len();
        minutes = minutes.child(el().key(format!("rt-min-{k}")).grow(1.0).h((v / peak * 120.0).max(2.0) as f32).radius(2.0).fill(if last { t.chart.primary } else { t.chart.primary.alpha(0.45) }).help(format!("{} minutes ago: {}", r.per_minute.len() - 1 - k, crate::insights::int(*v))));
    }
    let minutes_card = kit::panel(t, "rt-minutes", "Each minute", Some("Active people, the last 30 minutes, newest on the right".into()), None, 0.0,
        col().w_full().gap(8.0).child(minutes).child(row().w_full().child(label("30 min ago", type_::AXIS, t.chart.axis)).child(el().grow(1.0)).child(label("now", type_::AXIS, t.chart.axis))));
    col().w_full().gap(16.0).child(strip).child(map).child(kit::cols(vec![activity, countries])).child(minutes_card)
}
