//! The agent chat (`components/agent-chat.tsx`): the transcript in a centred
//! column, the person's messages in soft bubbles on the right, the agent's
//! replies as Markdown under a one-line work log, and the composer at the bottom.

use rune::{Cursor, El, ScrollSpec, col, el, row, text_input};
use rune_kit::{Kit, Markdown};

use crate::api::Message;
use crate::icons;
use crate::state::{App, Load, Turn};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{failure, ico, label};

const COLUMN: f32 = 720.0;

pub fn view(s: &App, t: &Theme, k: &Kit) -> El {
    let business = s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "this business".into());
    let messages = s.transcript();

    let mut list = col().key("messages").w_full().max_w(COLUMN).gap(12.0).px(24.0).pt(24.0).pb(16.0);
    match &s.conversation {
        Load::Loading if messages.is_empty() => {
            list = list.child(label("Opening the chat…", type_::SM_13, t.muted_foreground).key("chat-loading"));
        }
        Load::Failed(e) => {
            let e = e.clone();
            list = list.child(failure(t, "chat-failed", &e, |s: &mut App| s.refresh()));
        }
        _ => {}
    }
    if messages.is_empty() && !matches!(s.conversation, Load::Loading | Load::Failed(_)) {
        list = list.child(
            col()
                .key("chat-empty")
                .w_full()
                .pt(120.0)
                .gap(8.0)
                .items_center()
                .child(label(format!("Ask {business}'s agent"), type_::BASE_MEDIUM, t.foreground))
                .child(label("It reads your results and channels, proposes the next step, and asks before it publishes, sends or spends.", type_::SM_13, t.muted_foreground).wrap().max_w(420.0)),
        );
    }
    for (i, m) in messages.iter().enumerate() {
        list = list.child(message(t, k, i, m));
    }
    match &s.turn {
        Turn::Working { .. } => {
            list = list.child(
                row()
                    .key("working")
                    .gap(8.0)
                    .center_y()
                    .child(el().size(6.0, 6.0).radius(3.0).fill(t.working))
                    .child(label("Working", type_::XS_MEDIUM, t.working))
                    .live_region(rune::LiveRegion::Polite),
            );
        }
        Turn::Failed { error, .. } => {
            list = list.child(label(error.clone(), type_::XS, t.wrong).key("turn-failed").self_end().wrap().live_region(rune::LiveRegion::Polite));
        }
        Turn::Idle => {}
    }

    let transcript = col()
        .key("transcript")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(col().w_full().items_center().child(list))
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(16.0);

    col().key("agent").w_full().h_full().min_h(0.0).child(transcript).child(composer(s, t, &business))
}

fn message(t: &Theme, k: &Kit, i: usize, m: &Message) -> El {
    if m.role == "user" {
        return col().key(format!("msg-{i}")).w_full().items_end().child(
            col()
                .max_w(COLUMN * 0.85)
                .px(16.0)
                .py(10.0)
                .radius(16.0)
                .fill(t.accent)
                .child(label(m.text.clone(), type_::BASE.lh(26.0), t.foreground).wrap().selectable(true)),
        );
    }
    let mut c = col().key(format!("msg-{i}")).w_full().gap(6.0);
    if !m.tool_calls.is_empty() {
        let n = m.tool_calls.len();
        let summary = format!("Worked through {n} {}", if n == 1 { "step" } else { "steps" });
        c = c.child(
            row()
                .gap(6.0)
                .center_y()
                .help(m.tool_calls.iter().map(|c| format!("{}: {}", c.tool.replace('_', " "), c.summary)).collect::<Vec<_>>().join("\n"))
                .child(ico(&icons::SPARKLES, 13.0, t.muted_foreground))
                .child(label(summary, type_::XS, t.muted_foreground)),
        );
    }
    c.child(Markdown::new(m.text.clone()).selectable(true).build(k).w_full())
}

fn composer(s: &App, t: &Theme, business: &str) -> El {
    let working = matches!(s.turn, Turn::Working { .. });
    let input = text_input(&s.composer, type_::LG)
        .key("composer-input")
        .placeholder("Describe a task or ask a question", t.muted_foreground)
        .label("Message the agent")
        .w_full()
        .max_h(200.0)
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.composer)
        .on_submit(|s: &mut App, tx| s.send_message(tx))
        .autofocus();
    let can_send = !working && !s.composer.text.trim().is_empty();
    let send = row()
        .key("send")
        .size(32.0, 32.0)
        .radius(16.0)
        .center()
        .role("button")
        .label("Send")
        .disabled(!can_send)
        .cursor(if can_send { Cursor::Pointer } else { Cursor::Default })
        .fill(if can_send { t.primary } else { t.accent })
        .on_press_tx(|s: &mut App, tx| s.send_message(tx))
        .child(ico(&icons::ARROW_UP, 18.0, if can_send { t.primary_foreground } else { t.muted_foreground }));
    let field = shadows(
        row()
            .key("composer")
            .w_full()
            .min_h(48.0)
            .pl(16.0)
            .pr(8.0)
            .py(8.0)
            .gap(12.0)
            .items_center()
            .radius(12.0)
            .fill(t.control)
            .child(col().grow(1.0).min_w(0.0).py(3.0).self_center().child(input))
            .child(send),
        &t.control_shadow,
    );
    let options = row()
        .w_full()
        .px(12.0)
        .pt(4.0)
        .gap(6.0)
        .center_y()
        .child(ico(&icons::FOLDER, 14.0, t.muted_foreground))
        .child(label(business.to_string(), type_::XS, t.muted_foreground))
        .child(el().grow(1.0))
        .child(label("Return sends, Shift+Return adds a line", type_::XS, t.muted_foreground.alpha(0.8)));
    col().w_full().items_center().px(24.0).pb(8.0).child(col().w_full().max_w(COLUMN).child(field).child(options))
}
