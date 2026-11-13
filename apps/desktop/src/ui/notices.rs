//! The decisions waiting on the person, as a stack of notifications in the
//! window's bottom right corner. At rest they sit one behind another, the
//! newest in front and two more peeking above it, each a little narrower and
//! fainter, as the notification centre stacks them. Under the pointer the stack
//! spreads into a list, one card per decision, and gathers again when the
//! pointer leaves. A card opens its decision in the Inbox; "Hide" puts the
//! current ones away until a new one arrives.

use rune::{Cursor, El, Spring, col, row};

use crate::format;
use crate::icons;
use crate::state::{App, Page, Screen, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, ico, label};

const WIDTH: f32 = 340.0;
const CARD_H: f32 = 64.0;
const GAP: f32 = 8.0;
/// How much of each card behind the front one shows above it at rest.
const PEEK: f32 = 12.0;
const SHOWN: usize = 5;
const SPREAD: Spring = Spring::new(0.36, 0.08);

/// The stack, when there is anything waiting and nowhere else on screen already lists it.
pub fn layer(s: &App, t: &Theme) -> Option<El> {
    if s.screen != Screen::Workspace || s.settings.is_some() || (s.view == View::Workspace && s.page == Page::Inbox) {
        return None;
    }
    let waiting: Vec<_> = s.inbox().into_iter().filter(|d| !s.notices_hidden.contains(&d.key)).collect();
    if waiting.is_empty() {
        return None;
    }
    let open = s.notices_open;
    let now = format::now();
    let shown = &waiting[..waiting.len().min(SHOWN)];
    // Oldest at the top of the list, the newest at the bottom, in front.
    let order: Vec<_> = shown.iter().rev().collect();
    let last = order.len() - 1;
    let mut stack = col().key("notices-cards").w(WIDTH).gap(GAP);
    for (j, d) in order.iter().enumerate() {
        let behind = last - j;
        // At rest every card slides down onto the front one, less its peek.
        let (dy, scale, fade) = if open { (0.0, 1.0, 1.0) } else { (behind as f32 * (CARD_H + GAP - PEEK), 1.0 - 0.045 * behind as f32, [1.0, 0.75, 0.5].get(behind).copied().unwrap_or(0.0)) };
        // Cards behind the front one show only their edge, as the notification centre does.
        let content = if open || behind == 0 { 1.0 } else { 0.0 };
        let key = d.key.clone();
        let card = shadows(
            row()
                .key(format!("notice-{}", d.key))
                .w_full()
                .h(CARD_H)
                .px(14.0)
                .gap(12.0)
                .radius(14.0)
                .center_y()
                .fill(t.popover)
                .role("button")
                .label(format!("{}: {}", d.label, d.title))
                .focusable(open || behind == 0)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .motion(SPREAD)
                .offset(0.0, dy)
                .scale(scale)
                .opacity(fade)
                .on_hover_change(|s: &mut App, inside, _tx| {
                    if inside {
                        s.notices_open = true;
                    }
                })
                .on_press(move |s: &mut App| {
                    s.notices_open = false;
                    s.show_page(Page::Inbox);
                    s.select_decision(&key);
                })
                .child(row().size(30.0, 30.0).radius(8.0).center().fill(t.partial_soft).opacity(content).motion(SPREAD).child(ico(&icons::NAV_INBOX, 15.0, t.partial)))
                .child(
                    col()
                        .opacity(content)
                        .motion(SPREAD)
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(1.0)
                        .child(
                            row()
                                .w_full()
                                .gap(8.0)
                                .center_y()
                                .child(label(d.label.clone(), type_::XS11, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                                .child(label(format::relative(d.created_at.as_deref(), now), type_::XS11, t.muted_foreground)),
                        )
                        .child(label(d.title.clone(), type_::SM_MEDIUM, t.foreground).truncate()),
                )
                // At rest the front card says how many wait behind it.
                .children((!open && behind == 0 && waiting.len() > 1).then(|| {
                    row().h(20.0).px(7.0).radius(10.0).center().fill(t.accent).child(label(format!("+{}", waiting.len() - 1), type_::XS_MEDIUM.features("'tnum' 1"), t.muted_foreground))
                })),
            &t.float_shadow,
        );
        stack = stack.child(card);
    }
    let n = waiting.len();
    // Above the list while it is spread: how many, the way to all of them, and "Hide".
    let head = row()
        .key("notices-head")
        .w(WIDTH)
        .h(28.0)
        .px(4.0)
        .gap(10.0)
        .center_y()
        .opacity(if open { 1.0 } else { 0.0 })
        .motion(SPREAD)
        .child(label(if n == 1 { "1 decision needs you".to_string() } else { format!("{n} decisions need you") }, type_::XS_MEDIUM, t.foreground).grow(1.0))
        .child(link(t, "notices-all", "Open inbox", open).on_press(|s: &mut App| {
            s.notices_open = false;
            s.show_page(Page::Inbox);
        }))
        .child(link(t, "notices-hide", "Hide", open).on_press(|s: &mut App| {
            let keys: Vec<String> = s.inbox().iter().map(|d| d.key.clone()).collect();
            s.notices_hidden.extend(keys);
            s.notices_open = false;
        }));
    // Clear of the composer when a chat fills the panel.
    let bottom = if s.chat_shown() && !s.pane_shown() { 112.0 } else { 24.0 };
    Some(
        col()
            .key("notices")
            .pin(None, None, Some(24.0), Some(bottom))
            .w(WIDTH)
            .gap(6.0)
            .role("region")
            .label("Decisions waiting on you")
            .on_hover_change(|s: &mut App, inside, _tx| {
                if !inside {
                    s.notices_open = false;
                }
            })
            .child(head)
            .child(stack),
    )
}

fn link(t: &Theme, key: &str, text_: &str, live: bool) -> El {
    label(text_.to_string(), type_::XS_MEDIUM, t.muted_foreground)
        .key(key.to_string())
        .role("button")
        .focusable(live)
        .cursor(if live { Cursor::Pointer } else { Cursor::Default })
        .hover(t.hover_tint)
        .motion(CONTROL)
        .px(6.0)
        .py(2.0)
        .radius(5.0)
}
