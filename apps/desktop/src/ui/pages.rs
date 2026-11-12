//! The workspace pages the sidebar opens: Inbox, Overview, Campaigns,
//! AI answers and Channels, read from the same endpoints the web pages use.

use rune::{Color, Cursor, El, ScrollSpec, col, row, text_input};

use crate::api::Decision;
use crate::decisions::Act;
use crate::format;
use crate::icons;
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, card, ico, label};

pub fn view(s: &App, t: &Theme) -> El {
    let body = match s.page {
        Page::Inbox => inbox(s, t),
        Page::Overview => crate::ui::overview::view(s, t),
        Page::Campaigns => crate::ui::campaigns::view(s, t),
        Page::AiAnswers => ai_answers(s, t),
        Page::Channels => crate::ui::channels::view(s, t),
        Page::Usage => crate::ui::account_pages::usage(s, t),
        Page::Businesses => crate::ui::account_pages::businesses(s, t),
        Page::Clients => crate::ui::account_pages::clients(s, t),
    };
    body.key(format!("page-{}", s.page.key()))
}


/// Opens the agent with a request typed in the composer, ready to send.
fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(request);
    }
}

/// The inbox, as the web lays it out: the list on a card at the left, the open
/// item on a card at the right with its details and the decision under them.
/// It fills the window; each card scrolls on its own. Up and down move through the list.
pub fn inbox(s: &App, t: &Theme) -> El {
    let items = s.inbox();
    let now = format::now();
    let n = items.len();
    let open = s.open_decision().map(|d| d.key.clone());
    let mut list = col().key("decision-list").w_full().padding(6.0).gap(2.0);
    for d in &items {
        let on = open.as_deref() == Some(d.key.as_str());
        let key = d.key.clone();
        let mut r = col()
            .key(format!("decision-{}", d.key))
            .w_full()
            .px(12.0)
            .py(12.0)
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
                .child(label(format!("{}, {}", d.business_name, d.label), type_::XS11, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                .child(label(format::relative(d.created_at.as_deref(), now), type_::XS11, t.muted_foreground)))
            .child(label(d.title.clone(), type_::SM_MEDIUM, t.foreground).wrap().max_lines(2))
            .child(label(d.summary.clone(), type_::XS, t.muted_foreground).wrap().max_lines(2));
        if on {
            r = shadows(r.fill(t.accent), &t.control_shadow);
        }
        list = list.child(r);
    }
    let left = card(t)
        .key("inbox-list")
        .w(352.0)
        .h_full()
        .clip_rounded(12.0)
        .child(row().w_full().px(16.0).py(12.0).center_y()
            .child(label("Inbox", type_::SM_MEDIUM, t.foreground).role("heading").grow(1.0))
            .child(label(if n == 1 { "1 waiting".to_string() } else { format!("{n} waiting") }, type_::XS, t.muted_foreground)))
        .child(if items.is_empty() {
            col().w_full().grow(1.0).center().px(24.0).gap(6.0)
                .child(ico(&icons::INBOX, 20.0, t.muted_foreground))
                .child(label("Nothing waiting", type_::SM_MEDIUM, t.foreground))
                .child(label("Work the agent prepares for you to approve lands here.", type_::XS, t.muted_foreground).wrap())
        } else {
            col().key("inbox-scroll").w_full().grow(1.0).min_h(0.0).child(list).scroll(ScrollSpec { stick_bottom: false })
        });
    let right = match s.open_decision() {
        Some(d) => decision_detail(s, t, d, now),
        None => card(t).grow(1.0).h_full().center().gap(10.0)
            .child(ico(&icons::INBOX, 28.0, t.muted_foreground.alpha(0.6)))
            .child(label("Your inbox is clear", type_::BASE_MEDIUM, t.foreground))
            .child(label("When the agent needs a decision from you, it shows up here.", type_::SM_13, t.muted_foreground))
            .child(button(t, "ask-next", "Ask the agent what to do next", Variant::Outline).on_press(ask(
                "What should we work on next? Check our results and channels and propose the most useful next step for me to approve.",
            ))),
    };
    row().key("inbox").w_full().h_full().padding(16.0).gap(16.0).child(left).child(right)
}

fn decision_detail(s: &App, t: &Theme, d: &Decision, now: i64) -> El {
    let busy = s.deciding.as_deref() == Some(d.key.as_str());
    // The details on an inner bordered panel, as the web's decision card.
    let mut panel = col().w_full().px(16.0).py(14.0).gap(10.0).radius(10.0).border(1.0, t.border);
    if !d.sections.is_empty() {
        for (i, sec) in d.sections.iter().enumerate() {
            let mut cell = col().key(format!("section-{i}")).w_full().gap(6.0).child(label(sec.label.clone(), type_::XS_MEDIUM, t.muted_foreground));
            if let Some(b) = &sec.before {
                let side = |name: &str, text: String, fill: Color, ink: Color| col().grow(1.0).min_w(0.0).px(12.0).py(10.0).gap(4.0).radius(8.0).fill(fill)
                    .child(label(name.to_string(), type_::XS2, t.muted_foreground)).child(label(text, type_::SM_13, ink).wrap().selectable(true));
                cell = cell.child(row().w_full().gap(10.0).items_stretch()
                    .child(side("Now", if b.is_empty() { "(empty)".into() } else { b.clone() }, t.wrong_soft.alpha(0.5), t.muted_foreground))
                    .child(side("After you approve", sec.text.clone(), t.supported_soft, t.foreground)));
            } else {
                cell = cell.child(label(sec.text.clone(), type_::SM_13.lh(20.0), t.foreground).wrap().selectable(true));
            }
            panel = panel.child(cell);
        }
    }
    if let Some(text) = &d.body {
        panel = panel.child(label(text.clone(), type_::SM_13.lh(20.0), t.foreground).wrap().selectable(true));
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
    // The decision, inline under the details, as on the web.
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
            .child(row().gap(8.0)
                .child(action(t, "decline-confirm", if busy { "Declining…" } else { d.decline.as_str() }, Variant::Primary, !busy, |s: &mut App| s.confirm_decline()))
                .child(button(t, "decline-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.cancel_decline())))
    } else {
        row().gap(8.0).center_y()
            .child(action(t, "approve", if busy { "Working…" } else { d.approve.as_str() }, Variant::Primary, !busy && blocked.is_none(), |s: &mut App| s.approve_decision()))
            .child(button(t, "decline", d.decline.as_str(), Variant::Outline).disabled(busy).on_press_tx(|s: &mut App, tx| s.start_decline(tx)))
    };
    panel = panel.child(actions);
    let mut body = col().w_full().px(16.0).py(14.0).gap(14.0)
        .child(col().w_full().gap(3.0)
            .child(label(format!("{}, {}, {}", d.business_name, d.label, format::relative(d.created_at.as_deref(), now)), type_::XS11, t.muted_foreground))
            .child(label(d.title.clone(), type_::SM_MEDIUM, t.foreground).wrap().role("heading").selectable(true))
            .children((!d.summary.is_empty()).then(|| label(d.summary.clone(), type_::XS, t.muted_foreground).wrap().selectable(true))))
        .child(panel);
    if let Some(chat) = d.conversation_id.clone() {
        let business = d.business_id.clone();
        body = body.child(
            row().w_full().gap(10.0).center_y()
                .child(label("The agent suggested this in a chat.", type_::XS, t.muted_foreground.alpha(0.8)).wrap().grow(1.0).min_w(0.0))
                .child(button(t, "decision-chat", "Open the conversation", Variant::Outline).on_press(move |s: &mut App| s.open_business_chat(&business, &chat))),
        );
    }
    card(t)
        .key(format!("decision-detail-{}", d.key))
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .clip_rounded(12.0)
        .child(col().key("decision-scroll").w_full().grow(1.0).min_h(0.0).child(body).scroll(ScrollSpec { stick_bottom: false }))
}

/// A button that is greyed and ignores presses while `enabled` is false.
fn action(t: &Theme, key: &str, text_: &str, variant: Variant, enabled: bool, on: impl Fn(&mut App) + 'static) -> El {
    let b = button(t, key, text_, variant).disabled(!enabled);
    if enabled { b.on_press(on) } else { b.opacity(0.5).cursor(Cursor::Default) }
}

fn model_picker(s: &App, t: &Theme) -> El {
    let head = label("Measurement model", type_::XS_MEDIUM, t.muted_foreground);
    let body = match &s.models {
        Load::Ready(list) if list.is_empty() => label("No supported measurement model is configured. This re-check can't run here.", type_::SM_13, t.muted_foreground).wrap(),
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
    if let Some(a) = &s.answer {
        return crate::ui::answer::view(s, t, a);
    }
    crate::ui::issues::view(s, t)
}


