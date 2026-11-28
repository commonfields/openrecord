//! The Inbox: the decision in front as a card on a stack, with the business's
//! numbers it bears on, the ones behind it as rows, and the approved work under
//! way, each item a row that folds open to its steps.

use rune::{Color, Cursor, El, LineCap, ScrollSpec, Shadow, Shape, TextStyle, canvas, col, el, row, text_input};

use crate::api::Decision;
use crate::decisions::Act;
use crate::format;
use crate::icons;
use crate::insights::{Analytics, Initiative, Source, pct};
use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::pages::{self, ask};
use crate::ui::widgets::{CONTROL, Variant, button, ico, label, track_hover};

/// The column's width.
const WIDTH: f32 = 720.0;
const STRONG: TextStyle = TextStyle::new(15.0, 600.0).lh(20.0);
/// Space below the panel header before the decision stack starts.
const TOP_PAD: f32 = 56.0;

pub fn view(s: &App, t: &Theme, in_panel: bool) -> El {
    let split = if s.split_w > 0.0 { s.split_w } else { 1000.0 };
    let available = if in_panel {
        if s.side.wide { split } else { split * s.prefs.helper() / 100.0 }
    } else if s.side_shown() {
        split * (1.0 - s.prefs.helper() / 100.0)
    } else {
        split
    };
    let narrow = available < 600.0;

    let items = s.inbox();
    let open = s.open_decision();
    let at = open.and_then(|d| items.iter().position(|x| x.key == d.key)).unwrap_or(0);

    let mut page = col().key("inbox-column").w_full().max_w(WIDTH);
    match open {
        Some(d) => {
            page = page.child(section(t, "Only you can decide", None, 0.0)).child(stack(s, t, d, at, items.len(), narrow));
            if items.len() > 1 {
                let mut list = col().key("decision-list").w_full().gap(8.0);
                for (i, d) in items.iter().enumerate().filter(|(i, _)| *i != at) {
                    list = list.child(waiting_row(s, t, d, i));
                }
                page = page.child(section(t, "Also waiting", None, 32.0)).child(list);
            }
        }
        None => page = page.child(clear(t)),
    }
    if let Some(list) = working(s, t) {
        page = page.child(list);
    }

    col()
        .key("inbox")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(
            col()
                .key("inbox-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .child(col().w_full().px(if narrow { 16.0 } else { 32.0 }).pt(TOP_PAD).pb(48.0).items_center().child(page))
                .scroll(ScrollSpec { stick_bottom: false }),
        )
}

fn section(t: &Theme, name: &str, right: Option<El>, top: f32) -> El {
    row().w_full().px(6.0).pt(top).pb(12.0).gap(14.0).center_y()
        .child(label(name.to_string(), type_::SM_MEDIUM, t.foreground))
        .child(el().grow(1.0))
        .children(right)
}

/// The open decision over the lower edges of up to two more.
fn stack(s: &App, t: &Theme, d: &Decision, at: usize, count: usize, narrow: bool) -> El {
    const EDGE: f32 = 12.0;
    let behind = count.saturating_sub(1).min(2);
    let mut c = col().key("decision-stack").w_full().pb(behind as f32 * EDGE);
    for k in (1..=behind).rev() {
        let inset = k as f32 * 18.0;
        c = c.child(
            el().key(format!("decision-behind-{k}"))
                .pin(Some(inset), Some(60.0), Some(inset), Some((behind - k) as f32 * EDGE))
                .radius(24.0)
                .fill(t.accent.mix(t.background, 0.35 * k as f32))
                .border(1.0, t.border)
                .a11y_hidden(),
        );
    }
    c.child(front(s, t, d, at, count, narrow))
}

/// A grey tray with its heading, and a white sheet inside it.
fn tray(t: &Theme, head: El, sheet: Option<El>) -> El {
    let open = sheet.is_some();
    let c = col().w_full().radius(26.0).fill(t.accent).child(head);
    match sheet {
        Some(sheet) => c
            .px(7.0)
            .pb(7.0)
            .border(1.0, t.border)
            .child(shadows(sheet.w_full().radius(19.0).fill(t.control), &t.control_shadow)),
        None => c,
    }
    .key(if open { "tray-open" } else { "tray" })
}

pub(super) fn pill(t: &Theme, key: &str, text: &str, primary: bool, enabled: bool) -> El {
    let (fill, hover, ink) = if primary { (t.primary, t.primary.alpha(0.9), t.primary_foreground) } else { (t.control, t.control_hover, t.foreground) };
    let b = row()
        .key(key)
        .h(34.0)
        .px(15.0)
        .radius(17.0)
        .center()
        .role("button")
        .label(text.to_string())
        .focusable(enabled)
        .disabled(!enabled)
        .opacity(if enabled { 1.0 } else { 0.5 })
        .cursor(if enabled { Cursor::Pointer } else { Cursor::Default })
        .fill(fill)
        .hover(if enabled { hover } else { fill })
        .motion(CONTROL)
        .child(label(text.to_string(), TextStyle::new(13.0, 500.0).lh(18.0), ink));
    shadows(b, if primary { &t.primary_shadow } else { &t.control_shadow })
}

/// A borderless footer or header button: an icon and a word.
pub(super) fn quiet(t: &Theme, key: &str, icon: &'static rune::Icon, text: &str) -> El {
    row()
        .key(key)
        .h(30.0)
        .px(8.0)
        .gap(7.0)
        .radius(15.0)
        .center_y()
        .role("button")
        .label(text.to_string())
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .motion(CONTROL)
        .child(ico(icon, 14.0, t.muted_foreground))
        .child(label(text.to_string(), type_::SM_13, t.foreground))
}

fn front(s: &App, t: &Theme, d: &Decision, at: usize, count: usize, narrow: bool) -> El {
    let k = crate::ui::kit(t);
    let logo = pages::sender_logo(s, t, d, 22.0).unwrap_or_else(|| row().size(22.0, 22.0).center().child(ico(&icons::NAV_INBOX, 18.0, t.foreground)));
    let head = row()
        .key("decision-header")
        .w_full()
        .px(16.0)
        .py(16.0)
        .gap(12.0)
        .center_y()
        .child(logo)
        .child(
            row().w(0.0).grow(1.0).min_w(0.0).gap(8.0).center_y()
                .child(label(d.title.clone(), STRONG, t.foreground).wrap().max_lines(2).min_w(0.0).shrink().role("heading").help(d.title.clone()))
                .child(row().h(20.0).px(8.0).radius(10.0).center().fill(t.review_soft).child(label(d.label.clone(), type_::XS, t.review))),
        )
        .child(label(format!("{} of {count}", at + 1), type_::SM_13.features("'tnum' 1"), t.muted_foreground));

    let mut body = col().key("decision-document").w_full().gap(14.0);
    if !d.summary.is_empty() {
        body = body.child(label(d.summary.clone(), type_::SM.lh(22.0), t.foreground).wrap().selectable(true));
    }
    body = body.children(numbers(s, t, d, narrow));
    for (i, sec) in d.sections.iter().filter(|x| !x.text.is_empty() || x.before.is_some()).enumerate() {
        body = body.child(part(t, i, sec));
    }
    if let Some(text) = &d.body {
        body = body.child(long_text(t, text));
    }
    let mut extras = row().w_full().gap(8.0).flex_wrap();
    let mut any = false;
    if let Some(artifact) = d.artifact.clone() {
        any = true;
        extras = extras.child(pill(t, "publication-review-artifact", "Review saved artifact", false, true).on_press(move |s: &mut App| s.open_artifact(&artifact)));
    }
    if matches!(d.act, Act::Publication { .. }) {
        any = true;
        let (id, business) = (d.id.clone(), d.business_id.clone());
        extras = extras.child(pill(t, "publication-prelaunch-test", "Open prelaunch test", false, true).on_press(move |s: &mut App| s.net.campaign_publication(business.clone(), id.clone(), crate::net::PublicationAction::Test)));
    }
    body = body.children(any.then_some(extras));
    if d.act == Act::Check {
        body = body.child(pages::model_picker(s, t));
    }
    if let Some((_, err)) = s.decision_error.as_ref().filter(|(key, _)| key == &d.key) {
        body = body.child(label(err.clone(), type_::SM_13, t.wrong).wrap().key("decision-error").live_region(rune::LiveRegion::Polite));
    }
    // Asked for, the agent's own message takes the document's place, as it read in the chat.
    let message = d.agent.as_ref().map(|a| a.text.as_str()).filter(|m| s.inbox_message && !m.trim().is_empty());
    if let Some(m) = message {
        body = col().key("decision-document").w_full().child(crate::ui::agent::reply_body(s, t, &k, "decision-message", m));
    }
    // The document scrolls inside the card; the sender above it and the decision
    // below stay put, so every card is the same size whatever it says.
    let scroll = col()
        .key(format!("decision-scroll-{}{}", d.key, if message.is_some() { "-message" } else { "" }))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(col().w_full().px(18.0).pt(10.0).pb(16.0).child(body))
        .scroll(ScrollSpec { stick_bottom: false })
        .scroll_edge_fade(16.0);
    let sheet = col().key("decision-paragraphs").grow(1.0).min_h(0.0)
        .child(col().w_full().px(18.0).pt(12.0).child(sender_line(s, t, d, narrow)))
        .child(scroll)
        .child(col().w_full().px(18.0).pt(12.0).pb(14.0).child(footer(s, t, d, count, narrow)));
    let read_key = d.key.clone();
    tray(t, head, Some(sheet))
        .key(format!("decision-detail-{}", d.key))
        .h(card_height(s))
        .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: 0.0, color: Color::BLACK.alpha(0.06), inset: false })
        .on_layout(move |s: &mut App, _| s.mark_decision_opened(&read_key))
}

/// One size for every card: as tall as the window leaves room for, within reason,
/// so the rows waiting below it start in view.
fn card_height(s: &App) -> f32 {
    let window = if s.window.1 > 0.0 { s.window.1 / s.zoom().max(0.1) } else { 800.0 };
    (window - 270.0).clamp(400.0, 660.0)
}

/// A line of a numbered list with a tag, "3. [alternatives] What else is there?".
fn tagged(line: &str) -> Option<(&str, &str, &str)> {
    let (n, rest) = line.split_once(". ")?;
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (tag, text) = rest.strip_prefix('[')?.split_once("] ")?;
    Some((n, tag, text))
}

/// A draft's or plan's text: paragraphs, and a tagged list under its tags as headings.
fn long_text(t: &Theme, text: &str) -> El {
    let mut c = col().w_full().gap(10.0);
    let mut under: Option<&str> = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some((n, tag, words)) = tagged(line) else {
            under = None;
            c = c.child(label(line.to_string(), type_::SM.lh(22.0), t.foreground).wrap().selectable(true));
            continue;
        };
        if under != Some(tag) {
            let mut name = tag.chars();
            let name = name.next().map(|f| f.to_uppercase().collect::<String>() + name.as_str()).unwrap_or_default();
            c = c.child(label(name, type_::XS_MEDIUM, t.muted_foreground).pt(6.0));
            under = Some(tag);
        }
        c = c.child(
            row().w_full().gap(10.0).items_start()
                .child(label(n.to_string(), type_::SM.lh(20.0).features("'tnum' 1"), t.muted_foreground).w(20.0))
                .child(label(words.to_string(), type_::SM, t.foreground).wrap().selectable(true).w(0.0).grow(1.0)),
        );
    }
    c
}

/// Who asked, from which chat and when, with the way back to that chat.
fn sender_line(s: &App, t: &Theme, d: &Decision, narrow: bool) -> El {
    let when = format::relative(d.created_at.as_deref(), format::now());
    let (name, about) = pages::sender_words(s, d, &when);
    let mut r = row().w_full().min_h(30.0).gap(8.0).center_y()
        .child(label(name, type_::SM_13, t.foreground))
        .child(label(about, type_::SM_13, t.muted_foreground).truncate().grow(1.0).min_w(0.0));
    if let Some(chat) = d.conversation_id.clone() {
        let business = d.business_id.clone();
        r = r.child(quiet(t, "decision-chat", &icons::MESSAGE_SQUARE_QUOTE, if narrow { "Open" } else { "Open the conversation" }).on_press(move |s: &mut App| s.open_business_chat(&business, &chat)));
    }
    r
}

/// One part of the decision: its name and text, or what changes into what.
fn part(t: &Theme, i: usize, sec: &crate::decisions::Section) -> El {
    let cell = col().key(format!("section-{i}")).w_full().gap(5.0).child(label(sec.label.clone(), type_::XS_MEDIUM, t.muted_foreground));
    let Some(before) = &sec.before else {
        return cell.child(label(sec.text.clone(), type_::SM.lh(22.0), t.foreground).wrap().selectable(true));
    };
    let side = |name: &str, text: String, fill: Color, ink: Color| {
        col().grow(1.0).min_w(200.0).px(14.0).py(11.0).gap(4.0).radius(14.0).fill(fill)
            .child(label(name.to_string(), type_::XS11, t.muted_foreground))
            .child(label(text, type_::SM_13, ink).wrap().selectable(true))
    };
    cell.child(
        row().w_full().gap(8.0).flex_wrap().items_stretch()
            .child(side("Now", if before.is_empty() { "(empty)".into() } else { before.clone() }, t.foreground.alpha(0.05), t.muted_foreground))
            .child(side("After you approve", sec.text.clone(), t.supported_soft, t.foreground)),
    )
}

fn footer(s: &App, t: &Theme, d: &Decision, count: usize, narrow: bool) -> El {
    let busy = s.deciding.as_deref() == Some(d.key.as_str());
    if s.declining {
        let input = text_input(&s.decline_reason, type_::SM)
            .key("decline-reason")
            .placeholder("Why not? Optional, the agent reads it", t.muted_foreground)
            .label("Reason for declining")
            .w_full()
            .color(t.foreground)
            .on_edit(|s: &mut App| &mut s.decline_reason)
            .on_submit(|s: &mut App, _| s.confirm_decline());
        let field = shadows(row().grow(1.0).min_w(0.0).h(34.0).px(14.0).radius(17.0).center_y().fill(t.control).child(input), &t.control_shadow);
        let mut confirm = pill(t, "decline-confirm", if busy { "Declining…" } else { d.decline.as_str() }, true, !busy);
        if !busy {
            confirm = confirm.on_press(|s: &mut App| s.confirm_decline());
        }
        return row().key("decision-footer").w_full().gap(8.0).center_y()
            .child(field)
            .child(pill(t, "decline-cancel", "Cancel", false, true).on_press(|s: &mut App| s.cancel_decline()))
            .child(confirm);
    }
    let blocked = d.blocked(s.model.as_deref());
    let note = blocked.map(str::to_string).or_else(|| d.note.clone());
    let ready = !busy && blocked.is_none();
    let mut yes = pill(t, "approve", if busy { "Working…" } else { d.approve.as_str() }, true, ready);
    if ready {
        yes = yes.on_press(|s: &mut App| s.approve_decision());
    }
    let mut no = pill(t, "decline", d.decline.as_str(), false, !busy);
    if !busy {
        no = no.on_press_tx(|s: &mut App, tx| s.start_decline(tx));
    }
    let later = (count > 1).then(|| quiet(t, "later", &icons::CALENDAR_CLOCK, "Later").ml(-8.0).on_press(|s: &mut App| s.later_decision()));
    let message = d.agent.as_ref().filter(|a| !a.text.trim().is_empty()).map(|_| {
        let open = s.inbox_message;
        let name = match (open, narrow) {
            (true, false) => "Back to the decision",
            (true, true) => "Back",
            (false, false) => "Read the agent's message",
            (false, true) => "Message",
        };
        quiet(t, "decision-message-toggle", if open { &icons::ARROW_LEFT } else { &icons::FILE_TEXT }, name).on_press(|s: &mut App| s.inbox_message = !s.inbox_message)
    });
    // In a narrow pane the quiet buttons take a line of their own.
    let buttons = if narrow {
        col().w_full().gap(8.0)
            .child(row().w_full().gap(8.0).center_y().children(later).children(message))
            .child(row().w_full().gap(8.0).center_y().justify_end().child(no).child(yes))
    } else {
        row().w_full().gap(8.0).center_y().children(later).children(message).child(el().grow(1.0)).child(no).child(yes)
    };
    col().key("decision-footer").w_full().gap(12.0)
        .children(note.map(|n| label(n, type_::XS, t.muted_foreground).wrap().w_full()))
        .child(buttons)
}

/// One of the business's numbers: what it is, where it stands, and its days.
pub(crate) struct Number {
    pub name: String,
    pub value: String,
    pub delta: Option<String>,
    pub better: bool,
    pub days: Vec<f64>,
}

pub(crate) fn accuracy(a: &Analytics, days: u32) -> Option<Number> {
    let now = a.current.accuracy()?;
    let change = a.previous.accuracy().map(|b| ((now - b) * 100.0).round()).filter(|c| *c != 0.0);
    let daily: Vec<Option<f64>> = a.daily.iter().map(|d| d.v.accuracy()).collect();
    Some(Number {
        name: format!("Correct AI answers, last {days} days"),
        value: pct(now),
        delta: change.map(|c| format!("{}{} points", if c > 0.0 { "+" } else { "−" }, c.abs())),
        better: change.is_some_and(|c| c > 0.0),
        days: crate::ui::charts::trailing(&daily, crate::ui::charts::window(days)).into_iter().flatten().collect(),
    })
}

/// The number a decision bears on: search for a change to the site, else what AI answers say.
fn number(s: &App, d: &Decision) -> Option<Number> {
    if s.active.as_deref() != Some(d.business_id.as_str()) {
        return None;
    }
    let i = s.insights.ready()?;
    let site = matches!(d.act, Act::WordPress | Act::Webflow | Act::Publication { .. });
    if let (true, Source::Reports(list)) = (site, &i.search) {
        if let Some((r, m)) = list.first().and_then(|r| r.metrics.first().map(|m| (r, m))) {
            return Some(Number {
                name: format!("{} {}", r.title, m.label.to_lowercase()),
                value: m.value.clone(),
                delta: m.delta.map(|x| format!("{}{}", if x < 0.0 { "−" } else { "+" }, pct(x.abs()))),
                better: m.delta.is_some_and(|x| (x >= 0.0) != m.lower_better),
                days: m.days.as_ref().map(|x| x.now.iter().flatten().copied().collect()).unwrap_or_default(),
            });
        }
    }
    accuracy(i.analytics.as_ref().ok()?, i.days)
}

/// The grey tile in the card; pressing it opens Analytics.
fn numbers(s: &App, t: &Theme, d: &Decision, narrow: bool) -> Option<El> {
    let n = number(s, d)?;
    let tone = match (&n.delta, n.better) {
        (None, _) => t.chart.primary,
        (_, true) => t.supported,
        (_, false) => t.wrong,
    };
    let figures = row().gap(8.0).items_end()
        .child(label(n.value, TextStyle::new(22.0, 600.0).lh(28.0).features("'tnum' 1"), t.foreground))
        .children(n.delta.map(|x| label(x, TextStyle::new(13.0, 500.0).lh(24.0).features("'tnum' 1"), tone)));
    Some(
        row()
            .key("decision-numbers")
            .w_full()
            .h(84.0)
            .px(18.0)
            .gap(16.0)
            .radius(16.0)
            .center_y()
            .fill(t.foreground.alpha(0.05))
            .role("button")
            .label(format!("{}, open Analytics", n.name))
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.foreground.alpha(0.08))
            .on_press(|s: &mut App| s.show_page(crate::state::Page::Overview))
            .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(n.name, type_::XS, t.muted_foreground).truncate()).child(figures))
            .children((n.days.len() > 1 && !narrow).then(|| sparkline(&n.days, tone, 160.0, 44.0))),
    )
}

/// The days as one line between their lowest and highest, the latest marked with a dot.
pub(crate) fn sparkline(values: &[f64], color: Color, w: f32, h: f32) -> El {
    const PAD: f32 = 4.0;
    let lo = values.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let span = hi - lo;
    let last = (values.len() - 1).max(1) as f32;
    let pts: Vec<[f32; 2]> = values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let up = if span > 0.0 { ((v - lo) / span) as f32 } else { 0.5 };
            [PAD + (w - 2.0 * PAD) * i as f32 / last, h - PAD - (h - 2.0 * PAD) * up]
        })
        .collect();
    let end = pts[pts.len() - 1];
    let shape = Shape::new()
        .stroke_with(pts, false, 1.75, LineCap::Round, color)
        .stroke_with(vec![end, [end[0] + 0.01, end[1]]], false, 6.0, LineCap::Round, color);
    canvas(shape).size(w, h).a11y_hidden()
}

fn disc(fill: Color, icon: &'static rune::Icon, ink: Color) -> El {
    row().size(26.0, 26.0).radius(13.0).center().fill(fill).child(ico(icon, 14.0, ink))
}

/// A decision behind the one in front; pressing it brings it forward.
fn waiting_row(s: &App, t: &Theme, d: &Decision, index: usize) -> El {
    let key = d.key.clone();
    let read = s.decision_opened(d);
    let stuck = d.blocked(Some("")).is_some();
    let icon = if stuck { disc(t.partial, &icons::TRIANGLE_ALERT, t.control) } else { pages::sender_logo(s, t, d, 26.0).unwrap_or_else(|| disc(t.foreground.alpha(0.08), &icons::NAV_INBOX, t.foreground)) };
    let hover_key = format!("inbox:{}", d.key);
    let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
    row()
        .key(format!("decision-{}", d.key))
        .w_full()
        .h(58.0)
        .px(20.0)
        .gap(14.0)
        .radius(24.0)
        .center_y()
        .fill(if hovered { t.accent.mix(t.foreground, 0.04) } else { t.accent })
        .role("button")
        .label(d.title.clone())
        .focusable(true)
        .cursor(Cursor::Pointer)
        .motion(CONTROL)
        .on_hover_change(track_hover(hover_key))
        .on_press(move |s: &mut App| s.select_decision(&key))
        .child(icon)
        .child(label(d.title.clone(), TextStyle::new(14.0, if read { 500.0 } else { 600.0 }).lh(20.0), t.foreground).truncate().grow(1.0).min_w(0.0))
        .child(label(if stuck { "Blocked".to_string() } else { d.label.clone() }, type_::SM_13, t.muted_foreground))
        .child(label(format!("{}", index + 1), type_::SM_13.features("'tnum' 1"), t.muted_foreground.alpha(0.7)))
        .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground))
}

fn clear(t: &Theme) -> El {
    col().key("inbox-clear").w_full().px(6.0).pt(20.0).child(
        button(t, "ask-next", "Ask the agent what to do next", Variant::Outline)
            .self_start()
            .on_press(ask("What should we work on next? Check our results and channels and propose the most useful next step for me to approve.")),
    )
}

/// How far along an approved piece of work is: the steps done, of four.
fn steps_done(x: &Initiative) -> usize {
    match (x.status.as_str(), x.progress.as_str()) {
        ("REVIEWED", _) => 4,
        (_, "EXECUTED") => 3,
        _ => 2,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Step {
    Done,
    Now,
    Next,
}

fn step_of(k: usize, done: usize) -> Step {
    match k.cmp(&done) {
        std::cmp::Ordering::Less => Step::Done,
        std::cmp::Ordering::Equal => Step::Now,
        std::cmp::Ordering::Greater => Step::Next,
    }
}

/// The approved work, each a row that folds open to its four steps.
fn working(s: &App, t: &Theme) -> Option<El> {
    let i = s.insights.ready()?;
    let list: Vec<&Initiative> = i.initiatives.iter().filter(|x| matches!(x.status.as_str(), "APPROVED" | "REVIEWED")).take(8).collect();
    if list.is_empty() {
        return None;
    }
    let mut rows = col().key("inbox-working").w_full().gap(8.0);
    for (k, x) in list.into_iter().enumerate() {
        rows = rows.child(work(s, t, x, k));
    }
    Some(
        col().w_full()
            .child(section(t, "Working on it", Some(label("What you approved", type_::XS, t.muted_foreground)), 32.0))
            .child(rows)
            .child(label("Each piece of work takes the same steps: proposed, approved, done, then reviewed.", type_::XS, t.muted_foreground).wrap().px(6.0).pt(12.0)),
    )
}

fn work(s: &App, t: &Theme, x: &Initiative, k: usize) -> El {
    let done = steps_done(x);
    let open = s.inbox_work.as_deref() == Some(x.title.as_str());
    let (icon, text) = match done {
        4 => (disc(t.supported, &icons::CHECK, t.control), "Reviewed"),
        3 => (ring(t, 26.0), "Done, measuring"),
        _ => (disc(t.partial, &icons::CIRCLE_DASHED, t.control), "To do"),
    };
    let mut dashes = row().gap(4.0).center_y().a11y_hidden();
    for j in 0..4 {
        dashes = dashes.child(el().size(13.0, 5.0).radius(2.5).fill(match step_of(j, done) {
            Step::Done => t.supported,
            Step::Now => t.foreground,
            Step::Next => t.foreground.alpha(0.12),
        }));
    }
    let title = x.title.clone();
    let hover_key = format!("inbox-work:{k}");
    let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
    let head = row()
        .key(format!("work-{k}"))
        .w_full()
        .h(58.0)
        .px(if open { 13.0 } else { 20.0 })
        .gap(14.0)
        .radius(24.0)
        .center_y()
        .role("button")
        .label(format!("{}, {text}", x.title))
        .expanded(open)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .motion(CONTROL)
        .fill(if hovered && !open { t.foreground.alpha(0.04) } else { Color::TRANSPARENT })
        .on_hover_change(track_hover(hover_key))
        .on_press(move |s: &mut App| s.inbox_work = if s.inbox_work.as_deref() == Some(title.as_str()) { None } else { Some(title.clone()) })
        .child(icon)
        .child(label(x.title.clone(), TextStyle::new(14.0, 600.0).lh(20.0), t.foreground).truncate().grow(1.0).min_w(0.0))
        .child(dashes)
        .child(label(text, type_::SM_13, t.muted_foreground))
        .child(ico(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 14.0, t.muted_foreground));
    let sheet = open.then(|| {
        let words = [
            ("The agent proposed it", "Propose"),
            ("You approved it", "Approve"),
            (if done > 2 { "The work is done" } else { "The work is still to do" }, "Do"),
            (if done > 3 { "The result was reviewed" } else if done == 3 { "Measuring what changed" } else { "Review the result once it is done" }, "Review"),
        ];
        let mut c = col().px(18.0).py(8.0);
        for (j, (what, name)) in words.into_iter().enumerate() {
            let st = step_of(j, done);
            let mark = match st {
                Step::Done => disc_small(t),
                Step::Now => ring(t, 22.0),
                Step::Next => row().size(22.0, 22.0).radius(11.0).border(1.5, t.muted_foreground.alpha(0.45)).border_dash(3.0, 3.0),
            };
            let quiet = if st == Step::Next { 0.65 } else { 1.0 };
            c = c.child(
                row().w_full().h(40.0).gap(14.0).center_y()
                    .child(mark)
                    .child(label(what, type_::SM, if st == Step::Next { t.muted_foreground } else { t.foreground }).truncate().grow(1.0).min_w(0.0))
                    .child(label(name, type_::SM_13, t.muted_foreground.alpha(quiet))),
            );
            if j < 3 {
                c = c.child(row().pl(10.25).child(el().size(1.5, 8.0).fill(if st == Step::Done && step_of(j + 1, done) != Step::Next { t.supported.alpha(0.6) } else { t.foreground.alpha(0.12) })));
            }
        }
        c
    });
    tray(t, head, sheet).key(format!("work-tray-{k}"))
}

fn disc_small(t: &Theme) -> El {
    row().size(22.0, 22.0).radius(11.0).center().fill(t.supported_soft).child(ico(&icons::CHECK, 12.0, t.supported))
}

/// The step under way: a ring drawn a third of the way round.
fn ring(t: &Theme, size: f32) -> El {
    let (c, r) = (size / 2.0, size / 2.0 - 1.5);
    let arc = |from: f32, to: f32| -> Vec<[f32; 2]> {
        (0..=24).map(|i| { let a = from + (to - from) * i as f32 / 24.0; [c + r * a.cos(), c + r * a.sin()] }).collect()
    };
    let tau = std::f32::consts::TAU;
    let shape = Shape::new()
        .stroke_with(arc(0.0, tau / 2.0), false, 2.0, LineCap::Round, t.foreground.alpha(0.14))
        .stroke_with(arc(tau / 2.0, tau), false, 2.0, LineCap::Round, t.foreground.alpha(0.14))
        .stroke_with(arc(tau * 0.25, tau * 0.55), false, 2.25, LineCap::Round, t.foreground);
    canvas(shape).size(size, size).a11y_hidden()
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_numbered_tagged_lines_become_list_rows() {
        assert_eq!(super::tagged("12. [integration needs] Is there a tool?"), Some(("12", "integration needs", "Is there a tool?")));
        assert_eq!(super::tagged("1. Plain item"), None);
        assert_eq!(super::tagged("Compare [a] with b. [c] d"), None);
    }
}
