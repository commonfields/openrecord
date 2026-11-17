//! The workspace pages the sidebar opens: Inbox, Overview, Campaigns,
//! AI answers and Channels, read from the same endpoints the web pages use.

use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text_input};

const XS11_MEDIUM: rune::TextStyle = rune::TextStyle::new(11.0, 500.0).lh(16.0);

use crate::api::Decision;
use crate::decisions::Act;
use crate::format;
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, card, empty_state_plain, label};

pub fn view(s: &App, t: &Theme) -> El {
    view_page(s, t, s.page)
}

pub fn view_page(s: &App, t: &Theme, page: Page) -> El {
    let body = match page {
        Page::Inbox => inbox(s, t),
        Page::Overview => crate::ui::overview::view(s, t),
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
            .child(row().w_full().gap(8.0).center_y()
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
        Some(d) => decision_detail(s, t, d, now),
        None => shadows(
            col()
                .key("inbox-empty-detail")
                .grow(1.0)
                .min_w(0.0)
                .h_full()
                .radius(12.0)
                .fill(t.card)
                .clip_rounded(12.0)
                .justify_center()
                .items_center()
                .child(empty_state_plain(
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
        col().key("inbox").w_full().h_full().padding(12.0).pt(6.0).gap(6.0)
            .child(left.w_full().h(240.0))
            .child(right.w_full().h(0.0).grow(1.0).min_h(0.0))
    } else {
        row().key("inbox").w_full().h_full().padding(12.0).pt(6.0)
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

fn decision_detail(s: &App, t: &Theme, d: &Decision, now: i64) -> El {
    let busy = s.deciding.as_deref() == Some(d.key.as_str());

    let meta = row().w_full().gap(8.0).flex_wrap()
        .child(label(d.business_name.clone(), type_::XS11, t.muted_foreground))
        .child(label(d.label.clone(), type_::XS11, t.muted_foreground))
        .child(label(format::relative(d.created_at.as_deref(), now), type_::XS11, t.muted_foreground));
    let title = label(d.title.clone(), type_::TITLE, t.foreground).wrap().role("heading").selectable(true);
    let summary = (!d.summary.is_empty()).then(|| label(d.summary.clone(), type_::BASE.lh(26.0), t.muted_foreground).wrap().selectable(true));

    let header = col()
        .w_full()
        .gap(12.0)
        .child(meta)
        .child(title)
        .children(summary);

    let mut panel = col().key("decision-paragraphs").w_full().gap(24.0);
    if let Some(artifact) = &d.artifact {
        let id = artifact.clone();
        panel = panel.child(button(t, "publication-review-artifact", "Review saved artifact", Variant::Outline).on_press(move |s: &mut App| s.open_artifact(&id)));
    }
    if matches!(d.act, Act::Publication { .. }) {
        let id = d.id.clone();
        let business = d.business_id.clone();
        panel = panel.child(button(t, "publication-prelaunch-test", "Open prelaunch test", Variant::Outline).on_press(move |s: &mut App| s.net.campaign_publication(business.clone(), id.clone(), crate::net::PublicationAction::Test)));
    }
    if !d.sections.is_empty() {
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
                cell = cell.child(label(sec.text.clone(), type_::BASE.lh(26.0), t.foreground).wrap().selectable(true));
            }
            panel = panel.child(cell);
        }
    }
    if let Some(text) = &d.body {
        panel = panel.child(label(text.clone(), type_::BASE.lh(26.0), t.foreground).wrap().selectable(true));
    }
    let blocked = d.blocked(s.model.as_deref());
    let note = blocked.map(str::to_string).or_else(|| d.note.clone());
    if let Some(n) = &note {
        panel = panel.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    if d.act == Act::Check {
        panel = panel.child(model_picker(s, t));
    }
    if let Some((key, err)) = &s.decision_error {
        if key == &d.key {
            panel = panel.child(label(err.clone(), type_::SM_13, t.wrong).wrap().key("decision-error").live_region(rune::LiveRegion::Polite));
        }
    }

    let actions = if s.declining {
        let input = text_input(&s.decline_reason, type_::SM)
            .key("decline-reason")
            .placeholder("Why not? Optional, the agent reads it", t.muted_foreground)
            .label("Reason for declining")
            .w_full()
            .color(t.foreground)
            .on_edit(|s: &mut App| &mut s.decline_reason)
            .on_submit(|s: &mut App, _| s.confirm_decline());
        col().w_full().gap(8.0)
            .child(shadows(row().w_full().h(32.0).px(10.0).radius(6.0).center_y().fill(t.control).child(input), &t.control_shadow))
            .child(
                row()
                    .gap(8.0)
                    .child(action(t, "decline-confirm", if busy { "Declining…" } else { d.decline.as_str() }, Variant::Primary, !busy, |s: &mut App| s.confirm_decline()))
                    .child(button(t, "decline-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.cancel_decline())),
            )
    } else {
        row()
            .gap(8.0)
            .center_y()
            .flex_wrap()
            .child(action(t, "approve", if busy { "Working…" } else { d.approve.as_str() }, Variant::Primary, !busy && blocked.is_none(), |s: &mut App| s.approve_decision()))
            .child(button(t, "decline", d.decline.as_str(), Variant::Outline).disabled(busy).on_press_tx(|s: &mut App, tx| s.start_decline(tx)))
    };
    panel = panel.child(actions);

    let mut scroll_body = col().key("decision-document").w_full().max_w(840.0).padding(28.0).gap(28.0).child(header).child(panel);
    if let Some(chat) = d.conversation_id.clone() {
        let business = d.business_id.clone();
        scroll_body = scroll_body.child(
            col()
                .w_full()
                .gap(12.0)
                .child(
                    label("The agent suggested this in a chat.", type_::XS, t.muted_foreground.alpha(0.8))
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(button(t, "decision-chat", "Open the conversation", Variant::Outline).self_start().on_press(move |s: &mut App| s.open_business_chat(&business, &chat))),
        );
    }

    let detail_scroll = col()
        .key("decision-scroll")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(col().w_full().items_center().child(scroll_body))
        .scroll(ScrollSpec { stick_bottom: false });

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
            .child(detail_scroll),
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
