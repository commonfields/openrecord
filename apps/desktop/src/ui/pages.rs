//! The workspace pages the sidebar opens: Inbox, Overview, Campaigns,
//! AI answers and Channels, read from the same endpoints the web pages use.

use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text_input};

const XS11_MEDIUM: rune::TextStyle = rune::TextStyle::new(11.0, 500.0).lh(16.0);

use crate::api::Decision;
use crate::decisions::Act;
use crate::format;
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, card, empty_state_panel, label};

pub fn view(s: &App, t: &Theme) -> El {
    view_page(s, t, s.page)
}

pub fn view_page(s: &App, t: &Theme, page: Page) -> El {
    let body = match page {
        Page::Inbox => inbox(s, t),
        Page::Overview => crate::ui::overview::view(s, t, false),
        Page::Campaigns => crate::ui::campaigns::view(s, t),
        Page::AiAnswers => ai_answers(s, t),
        Page::Channels => crate::ui::channels::view(s, t),
        Page::Usage => crate::ui::account_pages::usage(s, t),
        Page::Businesses => crate::ui::account_pages::businesses(s, t),
        Page::Clients => crate::ui::account_pages::clients(s, t),
    };
    body.key(format!("page-{}", page.key()))
}


/// Opens the agent with a request typed in the composer, ready to send.
fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(request);
    }
}

/// The inbox, as the web's `DecisionInbox`: a scrollable list at the left and a
/// single detail column at the right with its header fixed above the proposal.
pub fn inbox(s: &App, t: &Theme) -> El {
    inbox_at(s, t, false)
}

pub fn inbox_panel(s: &App, t: &Theme) -> El {
    inbox_at(s, t, true)
}

fn inbox_at(s: &App, t: &Theme, in_panel: bool) -> El {
    let split = if s.split_w > 0.0 { s.split_w } else { 1000.0 };
    let available = if in_panel {
        if s.side.wide { split } else { split * s.prefs.helper() / 100.0 }
    } else if s.side_shown() { split * (1.0 - s.prefs.helper() / 100.0) } else { split };
    let room = (available - 24.0).max(0.0);
    let stacked = room < 560.0;
    let max_width = (room - 286.0).clamp(crate::prefs::INBOX_MIN, crate::prefs::INBOX_MAX);
    let items = s.inbox();
    let now = format::now();
    let open = s.open_decision().map(|d| d.key.clone());

    let list_header = row()
        .w_full()
        .px(10.0)
        .py(12.0)
        .center_y()
        .child(label("Inbox", type_::SM_MEDIUM, t.foreground).role("heading"));

    let mut list = col().key("decision-list").w_full().padding(8.0).gap(2.0);
    for d in &items {
        let on = open.as_deref() == Some(d.key.as_str());
        let key = d.key.clone();
        let read = s.decision_opened(d);
        let indicator = el().key(format!("inbox-read-{}", d.key)).size(6.0, 6.0).radius(3.0)
            .role("img").label(if read { "Read" } else { "Unread" })
            .fill(if read { Color::TRANSPARENT } else { t.chart.primary })
            .border(1.0, if read { t.muted_foreground.alpha(0.5) } else { t.chart.primary });
        let mut r = col()
            .key(format!("decision-{}", d.key))
            .w_full()
            .px(8.0)
            .py(10.0)
            .gap(4.0)
            .radius(8.0)
            .role("button")
            .label(d.title.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(if on { t.accent } else { t.accent.alpha(0.6) })
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.select_decision(&key))
            .child(row().w_full().gap(6.0).center_y()
                .children(sender(s, d).and_then(|f| f.provider.or(f.model.clone()).map(|p| crate::brands::mark(t, &crate::brands::model_brand(f.model.as_deref().unwrap_or_default(), &p), 12.0))))
                .child(label(d.business_name.clone(), XS11_MEDIUM, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                .child(indicator))
            .child(label(d.title.clone(), rune::TextStyle::new(14.0, if read { 400.0 } else { 600.0 }).lh(20.0), t.foreground).wrap().max_lines(2));
        if on {
            r = shadows(r.fill(t.accent), &t.control_shadow);
        }
        list = list.child(r);
    }

    let list_body = col()
        .key("inbox-scroll")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(list)
        .scroll(ScrollSpec { stick_bottom: false });

    let left = card(t)
        .key("inbox-list")
        .min_w(0.0)
        .grow(0.0)
        .clip_rounded(12.0)
        .child(list_header)
        .child(list_body);

    let right = match s.open_decision() {
        Some(d) => {
            // The detail's own width decides how roomy its header and footer can be.
            let list_w = if stacked { 0.0 } else { s.prefs.inbox().min(max_width) + 6.0 };
            decision_detail(s, t, d, now, room - list_w < 560.0)
        }
        None => shadows(
            col()
                .key("inbox-empty-detail")
                .grow(1.0)
                .min_w(0.0)
                .h_full()
                .radius(12.0)
                .fill(t.card)
                .clip_rounded(12.0)
                .child(empty_state_panel(
                    "inbox-empty-shell",
                    t,
                    "inbox-clear",
                    "Nothing is waiting on you",
                    "When the agent needs your decision, it shows up here.",
                    Some(
                        button(t, "ask-next", "Ask the agent what to do next", Variant::Outline)
                            .self_start()
                            .on_press(ask(
                                "What should we work on next? Check our results and channels and propose the most useful next step for me to approve.",
                            )),
                    ),
                )),
            &t.card_shadow,
        ),
    };

    if stacked {
        col().key("inbox").w_full().h_full().px(12.0).pb(12.0).pt(0.0).gap(6.0)
            .child(left.w_full().h(240.0))
            .child(right.w_full().h(0.0).grow(1.0).min_h(0.0))
    } else {
        row().key("inbox").w_full().h_full().px(12.0).pb(12.0).pt(0.0)
            .child(left.w(s.prefs.inbox().min(max_width)).min_w(s.prefs.inbox().min(max_width)).h_full())
            .child(inbox_resize_edge(max_width))
            .child(right.w(0.0).grow(1.0))
    }
}

fn inbox_resize_edge(max_width: f32) -> El {
    use crate::prefs::{INBOX_DEFAULT, INBOX_MIN};
    el().key("inbox-edge").w(6.0).h_full()
        .role("separator").label("Resize Inbox sidebar")
        .focusable(true).cursor(Cursor::ResizeColumn)
        .on_drag(move |s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            match d.phase {
                rune::Phase::Down => {
                    d.data = s.prefs.inbox();
                    s.resizing = Some(crate::ui::Resize::Inbox);
                }
                rune::Phase::Move => s.prefs.inbox_width = (d.data.min(max_width) + d.dx / s.zoom()).clamp(INBOX_MIN, max_width).round(),
                rune::Phase::Up => {
                    if d.cancelled() { s.prefs.inbox_width = d.data; }
                    s.resizing = None;
                    s.prefs.save();
                }
            }
        })
        .on_double_press(|s: &mut App| {
            s.prefs.inbox_width = INBOX_DEFAULT;
            s.prefs.save();
        })
        .on_key(move |s: &mut App, ev: &rune::KeyEvent, tx: &mut rune::Tx| {
            let delta = match ev.key {
                rune::Key::Left => -16.0,
                rune::Key::Right => 16.0,
                _ => return false,
            };
            tx.instant();
            s.prefs.inbox_width = (s.prefs.inbox().min(max_width) + delta).clamp(INBOX_MIN, max_width);
            s.prefs.save();
            true
        })
}

/// Who sent a decision: the agent message that saved it, else the chat it came
/// from in the chat list. Provider, model and the chat's title, any of which may be missing.
struct From {
    provider: Option<String>,
    model: Option<String>,
    session: Option<String>,
}

/// The logo of the provider that asked for a decision, `size` points square, if it is known.
pub fn sender_logo(s: &App, t: &Theme, d: &Decision, size: f32) -> Option<El> {
    let f = sender(s, d)?;
    let provider = f.provider.clone().unwrap_or_default();
    if provider.is_empty() && f.model.is_none() {
        return None;
    }
    let brand = crate::brands::model_brand(f.model.as_deref().unwrap_or_default(), &provider);
    Some(crate::brands::logo(t, &brand, size))
}

fn sender(s: &App, d: &Decision) -> Option<From> {
    let chat = d.conversation_id.as_deref().and_then(|id| s.chats.iter().find(|c| c.id == id));
    let from_chat = chat.map(|c| From { provider: c.providers.last().cloned(), model: None, session: c.title.clone().filter(|t| !t.is_empty()) });
    match (&d.agent, from_chat) {
        (Some(a), chat) => Some(From {
            provider: a.provider.clone().or_else(|| chat.as_ref().and_then(|c| c.provider.clone())),
            model: a.model.clone(),
            session: a.session.clone().or_else(|| chat.and_then(|c| c.session)),
        }),
        (None, chat) => chat,
    }
}

/// A model id as people say it: the catalog's name when it lists the model,
/// else its words capitalised with version numbers joined ("claude-sonnet-5-5" as "Claude Sonnet 5.5").
fn model_name(s: &App, model: &str) -> String {
    if let Load::Ready(list) = &s.catalog {
        if let Some(o) = list.iter().find(|o| o.value == model || o.value.ends_with(&format!(":{model}"))) {
            return o.name.clone();
        }
    }
    let bare = model.rsplit('/').next().unwrap_or(model);
    let mut words: Vec<String> = Vec::new();
    for part in bare.split(['-', '_']).filter(|p| !p.is_empty()) {
        let numeric = part.chars().all(|c| c.is_ascii_digit() || c == '.');
        match words.last_mut() {
            Some(last) if numeric && last.chars().all(|c| c.is_ascii_digit() || c == '.') => {
                last.push('.');
                last.push_str(part);
            }
            _ if part.eq_ignore_ascii_case("gpt") => words.push("GPT".into()),
            _ => {
                let mut c = part.chars();
                words.push(c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default());
            }
        }
    }
    words.join(" ")
}

/// The detail's top line, as the AI answer popup's: the sender's logo, its
/// brand and model, the chat it came from and when, and a way back to that chat.
fn decision_header(s: &App, t: &Theme, d: &Decision, now: i64, narrow: bool) -> El {
    let from = sender(s, d);
    let when = format::relative(d.created_at.as_deref(), now);
    let (badge, name, sub) = match &from {
        Some(f) => {
            let provider = f.provider.clone().unwrap_or_default();
            let brand = crate::brands::model_brand(f.model.as_deref().unwrap_or_default(), &provider);
            let badge = crate::brands::logo(t, &brand, 28.0);
            // The model's name says the brand already ("Claude Sonnet 5.5"); the brand alone when the model is unknown.
            let brand_name = crate::brands::brand(&brand).0;
            let title = match f.model.as_deref().map(|m| model_name(s, m)) {
                // A bare family name ("sonnet") reads better with its maker in front.
                Some(n) if !n.chars().any(|c| c.is_ascii_digit()) && !n.to_lowercase().contains(&brand_name.to_lowercase()) => format!("{brand_name} {n}"),
                Some(n) => n,
                None => brand_name,
            };
            let name = row().min_w(0.0).child(label(title, type_::SM_MEDIUM, t.foreground).truncate());
            let sub = match &f.session {
                Some(title) => format!("In \u{201c}{title}\u{201d}, {when}"),
                None => format!("From a chat, {when}"),
            };
            (badge, name, sub)
        }
        None => (
            row().size(28.0, 28.0).radius(7.0).center().fill(t.accent).child(crate::ui::widgets::ico(&crate::icons::INBOX, 14.0, t.muted_foreground)),
            row().child(label("OpenRecord", type_::SM_MEDIUM, t.foreground)),
            format!("{}, {when}", d.business_name),
        ),
    };
    let mut r = row().key("decision-header").w_full().px(20.0).pt(16.0).pb(4.0).gap(10.0).center_y()
        .child(badge)
        .child(col().grow(1.0).min_w(0.0).gap(1.0).child(name).child(label(sub, type_::XS11, t.muted_foreground).truncate()));
    if let Some(chat) = d.conversation_id.clone() {
        let business = d.business_id.clone();
        let open = move |s: &mut App| s.open_business_chat(&business, &chat);
        r = r.child(if narrow {
            // Its icon alone in a narrow pane, so the sender keeps the room.
            row().key("decision-chat").size(28.0, 28.0).radius(6.0).center().role("button").label("Open the conversation").help("Open the conversation")
                .focusable(true).cursor(Cursor::Pointer).hover(t.hover_tint)
                .child(crate::ui::widgets::ico(&crate::icons::MESSAGE_SQUARE_QUOTE, 14.0, t.muted_foreground)).on_press(open)
        } else {
            button(t, "decision-chat", "Open the conversation", Variant::Ghost).on_press(open)
        });
    }
    r
}

fn decision_detail(s: &App, t: &Theme, d: &Decision, now: i64, narrow: bool) -> El {
    let busy = s.deciding.as_deref() == Some(d.key.as_str());
    let k = crate::ui::kit(t);

    // What kind of decision and for which business, then the title and the gist.
    let kind = row().gap(8.0).center_y()
        .child(row().h(22.0).px(8.0).radius(11.0).center().fill(t.accent).child(label(d.label.clone(), XS11_MEDIUM, t.foreground)))
        .child(label(d.business_name.clone(), type_::XS11, t.muted_foreground));
    let title = label(d.title.clone(), rune::TextStyle::new(22.0, 600.0).lh(30.0), t.foreground).wrap().role("heading").selectable(true);
    let summary = (!d.summary.is_empty()).then(|| label(d.summary.clone(), type_::BASE.lh(26.0), t.muted_foreground).wrap().selectable(true));
    let header = col().w_full().gap(12.0).child(kind).child(title).children(summary);

    let mut panel = col().key("decision-paragraphs").w_full().gap(24.0);
    // The agent's own message, as it read in the chat: its charts, generated views and diagrams included.
    if let Some(a) = d.agent.as_ref().filter(|a| !a.text.trim().is_empty()) {
        panel = panel.child(crate::ui::agent::reply_body(s, t, &k, "decision-message", &a.text));
    }
    if let Some(artifact) = &d.artifact {
        let id = artifact.clone();
        panel = panel.child(button(t, "publication-review-artifact", "Review saved artifact", Variant::Outline).self_start().on_press(move |s: &mut App| s.open_artifact(&id)));
    }
    if matches!(d.act, Act::Publication { .. }) {
        let id = d.id.clone();
        let business = d.business_id.clone();
        panel = panel.child(button(t, "publication-prelaunch-test", "Open prelaunch test", Variant::Outline).self_start().on_press(move |s: &mut App| s.net.campaign_publication(business.clone(), id.clone(), crate::net::PublicationAction::Test)));
    }
    for (i, sec) in d.sections.iter().enumerate() {
        let mut cell = col().key(format!("section-{i}")).w_full().gap(6.0).child(label(sec.label.clone(), type_::SM_MEDIUM, t.foreground));
        if let Some(b) = &sec.before {
            let side = |name: &str, text: String, fill: Color, ink: Color| {
                col()
                    .grow(1.0)
                    .min_w(200.0)
                    .px(12.0)
                    .py(10.0)
                    .gap(4.0)
                    .radius(8.0)
                    .fill(fill)
                    .child(label(name.to_string(), type_::XS2, t.muted_foreground))
                    .child(label(text, type_::SM_13, ink).wrap().selectable(true))
            };
            cell = cell.child(
                row()
                    .w_full()
                    .gap(10.0)
                    .flex_wrap()
                    .items_stretch()
                    .child(side("Now", if b.is_empty() { "(empty)".into() } else { b.clone() }, t.wrong_soft.alpha(0.5), t.muted_foreground))
                    .child(side("After you approve", sec.text.clone(), t.supported_soft, t.foreground)),
            );
        } else {
            cell = cell.child(label(sec.text.clone(), type_::SM.lh(24.0), t.muted_foreground).wrap().selectable(true));
        }
        panel = panel.child(cell);
    }
    if let Some(text) = &d.body {
        panel = panel.child(label(text.clone(), type_::SM.lh(24.0), t.foreground).wrap().selectable(true));
    }
    if d.act == Act::Check {
        panel = panel.child(model_picker(s, t));
    }
    if let Some((key, err)) = &s.decision_error {
        if key == &d.key {
            panel = panel.child(label(err.clone(), type_::SM_13, t.wrong).wrap().key("decision-error").live_region(rune::LiveRegion::Polite));
        }
    }

    // The decision itself, held under the document: what approving does, then the buttons.
    let blocked = d.blocked(s.model.as_deref());
    let note = blocked.map(str::to_string).or_else(|| d.note.clone());
    let footer = if s.declining {
        let input = text_input(&s.decline_reason, type_::SM)
            .key("decline-reason")
            .placeholder("Why not? Optional, the agent reads it", t.muted_foreground)
            .label("Reason for declining")
            .w_full()
            .color(t.foreground)
            .on_edit(|s: &mut App| &mut s.decline_reason)
            .on_submit(|s: &mut App, _| s.confirm_decline());
        row().w_full().gap(8.0).center_y()
            .child(shadows(row().grow(1.0).min_w(0.0).h(32.0).px(10.0).radius(6.0).center_y().fill(t.control).child(input), &t.control_shadow))
            .child(button(t, "decline-cancel", "Cancel", Variant::Ghost).on_press(|s: &mut App| s.cancel_decline()))
            .child(action(t, "decline-confirm", if busy { "Declining…" } else { d.decline.as_str() }, Variant::Primary, !busy, |s: &mut App| s.confirm_decline()))
    } else {
        let buttons = row().gap(8.0).center_y()
            .child(button(t, "decline", d.decline.as_str(), Variant::Outline).disabled(busy).on_press_tx(|s: &mut App, tx| s.start_decline(tx)))
            .child(action(t, "approve", if busy { "Working…" } else { d.approve.as_str() }, Variant::Primary, !busy && blocked.is_none(), |s: &mut App| s.approve_decision()));
        let note = label(note.unwrap_or_default(), type_::XS, t.muted_foreground).wrap();
        // Side by side when there is room; in a narrow pane the note sits above the buttons.
        if narrow {
            col().w_full().gap(10.0).child(note.w_full()).child(buttons.self_end())
        } else {
            row().w_full().gap(16.0).center_y().child(note.grow(1.0).min_w(0.0)).child(buttons)
        }
    };
    let footer = col().key("decision-footer").w_full().items_center().pt(12.0).pb(18.0).child(footer.max_w(720.0).px(if narrow { 20.0 } else { 32.0 }));

    let scroll_body = col().key("decision-document").w_full().max_w(720.0).px(if narrow { 20.0 } else { 32.0 }).pt(if narrow { 24.0 } else { 36.0 }).pb(40.0).gap(32.0).child(header).child(panel);
    let detail_scroll = col()
        .key("decision-scroll")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(col().w_full().items_center().child(scroll_body))
        .scroll(ScrollSpec { stick_bottom: false })
        .scroll_edge_fade(16.0);

    let read_key = d.key.clone();
    shadows(
        col()
            .key(format!("decision-detail-{}", d.key))
            .on_layout(move |s: &mut App, _| s.mark_decision_opened(&read_key))
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .radius(12.0)
            .fill(t.card)
            .clip_rounded(12.0)
            .child(decision_header(s, t, d, now, narrow))
            .child(detail_scroll)
            .child(footer),
        &t.card_shadow,
    )
}

/// A button that is greyed and ignores presses while `enabled` is false.
fn action(t: &Theme, key: &str, text_: &str, variant: Variant, enabled: bool, on: impl Fn(&mut App) + 'static) -> El {
    let b = button(t, key, text_, variant).disabled(!enabled);
    if enabled {
        b.on_press(on)
    } else {
        b.opacity(0.5).cursor(Cursor::Default)
    }
}

fn model_picker(s: &App, t: &Theme) -> El {
    let head = label("Measurement model", type_::XS_MEDIUM, t.muted_foreground);
    let body = match &s.models {
        Load::Ready(list) if list.is_empty() => {
            label("No supported measurement model is configured. This re-check can't run here.", type_::SM_13, t.muted_foreground).wrap()
        }
        Load::Ready(list) => {
            let mut r = row().w_full().gap(6.0).flex_wrap();
            for m in list {
                let on = s.model.as_deref() == Some(m.as_str());
                let name = m.clone();
                let chip = row()
                    .key(format!("model-{m}"))
                    .h(28.0)
                    .px(10.0)
                    .radius(14.0)
                    .center()
                    .role("radio")
                    .label(m.clone())
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .hover(t.hover_tint)
                    .motion(CONTROL)
                    .fill(if on { t.primary } else { t.control })
                    .on_press(move |s: &mut App| s.choose_model(&name))
                    .child(label(m.clone(), type_::XS_MEDIUM, if on { t.primary_foreground } else { t.foreground }));
                r = r.child(if on { chip } else { shadows(chip, &t.control_shadow) });
            }
            r
        }
        Load::Failed(e) => label(e.clone(), type_::SM_13, t.wrong).wrap(),
        _ => label("Loading models…", type_::SM_13, t.muted_foreground),
    };
    col().key("model-picker").w_full().gap(8.0).child(head).child(body)
}

fn ai_answers(s: &App, t: &Theme) -> El {
    crate::ui::issues::view(s, t)
}
