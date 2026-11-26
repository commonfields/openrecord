//! The agent chat (`components/agent-chat.tsx`, `agent-trace.tsx`,
//! `agent-model-picker.tsx`): the transcript in a centred column, the person's
//! messages in soft bubbles on the right, the agent's replies as Markdown under
//! a folded work log, with their sources, helper sessions and decisions, and
//! the composer with its model picker at the bottom.

use rune::{Align, Color, Cursor, El, TextStyle, LiveRegion, ScrollSpec, Side, Transition, col, el, row, text_input};
use rune_kit::{Dialog, Kit, Markdown, MarkdownStyle};

use crate::api::Message;
use crate::brands;
use crate::chat::{self, Activity, Progress};
use crate::icons;
use crate::state::{ComposerSlot, App, Load, Page, Turn, View};
use crate::theme::{Theme, hex, shadows, type_};
use crate::ui::widgets::{AutofocusIf, CONTROL, failure, ico, label};


/// Where the chat transcript and composer are drawn: the main column or the
/// right panel under Campaigns.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChatLayout {
    Main,
    Side,
}

pub fn view(s: &App, t: &Theme, k: &Kit) -> El {
    chat_session(s, t, k, ChatLayout::Main)
}

/// The same chat session as the main column, embedded under Campaigns in the
/// right panel (shared transcript, side composer).
pub fn side_session(s: &App, t: &Theme, k: &Kit) -> El {
    chat_session(s, t, k, ChatLayout::Side)
}

fn chat_session(s: &App, t: &Theme, k: &Kit, layout: ChatLayout) -> El {
    let side = layout == ChatLayout::Side;
    let column = if side { f32::MAX } else { s.prefs.chat_width.max() };
    let business = s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "this business".into());
    // Beside Analytics the native transcript is off (`ui::view`), so this one is drawn.
    if s.prefs.words_webview && !side && !s.side_shows_overview() {
        return words_webview(s, t, k, column, &business);
    }
    let messages = s.transcript();

    // Messages land where they belong: no rise and no glide, so opening a chat
    // or starting a turn never slides the column up the window. Another chat
    // crossfades in over the last one instead of blanking and popping.
    let shown = s.conversation.ready().map(|c| c.id.as_str()).unwrap_or("none");
    let turns: Vec<usize> = messages.iter().enumerate().filter(|(_, m)| m.role == "user").map(|(i, _)| i).collect();
    let mut list = col()
        .key(format!("{}{shown}", if side { "side-messages-" } else { "messages-" }))
        .w_full()
        .gap(if side { 8.0 } else { 12.0 })
        .pt(if side { 8.0 } else { 24.0 })
        .pb(if side { 8.0 } else { 16.0 })
        .transition(Transition::opacity());
    if !side {
        list = list.max_w(column);
    }
    match &s.conversation {
        // Only a slow load says so: a quick one goes straight to the chat.
        Load::Loading if messages.is_empty() => {
            list = list.child(label("Opening the chat…", type_::SM_13, t.muted_foreground).key("chat-loading").transition(Transition::opacity()).enter_delay(0.4));
        }
        Load::Failed(e) => {
            let e = e.clone();
            list = list.child(failure(t, "chat-failed", &e, |s: &mut App| s.refresh()));
        }
        _ => {}
    }
    if let Some(info) = s.conversation.ready().and_then(|c| c.session.clone()) {
        if let Some(parent) = info.parent_session_id.clone() {
            list = list.child(helper_banner(t, &info, parent));
        }
    }
    let statuses = task_statuses(&messages);
    for (i, m) in messages.iter().enumerate() {
        if let Some(name) = handover(&messages, i) {
            list = list.child(divider(t, &format!("handover-{i}"), Some(&brand_of(m)), &format!("Switched to {name}. It has the conversation so far")));
        }
        if m.origin.as_ref().is_some_and(|o| o.kind == "wake") {
            let title = m.origin.as_ref().and_then(|o| o.title.clone()).unwrap_or_else(|| "Helper results arrived. Continuing".into());
            list = list.child(divider(t, &format!("wake-{i}"), None, &title));
            continue;
        }
        // The weekly brief's instructions are OpenRecord's, not the person's words.
        if m.role == "user" && crate::chat::is_brief_request(&m.text) {
            list = list.child(divider(t, &format!("brief-{i}"), None, "Scheduled weekly brief"));
            continue;
        }
        let mut item = message(s, t, k, i, m, &statuses);
        if !side && m.role == "user" {
            let owner = shown.to_string();
            item = item.on_layout(move |s: &mut App, rect: [f32; 4]| s.timeline.mark(&owner, i, rect[1]));
        }
        list = list.child(item);
    }
    match &s.turn {
        Turn::Working { progress, started, stopping, .. } => {
            list = list.child(live_trace(s, t, k, progress, started.elapsed().as_millis() as i64, *stopping));
            // Questions it left while it carries on, answerable now.
            for b in &progress.blanks {
                list = list.child(blank_card(s, t, b));
            }
            // What the person sent while it works, where they sent it, with whether the agent has it yet.
            for n in &s.steer {
                list = list.child(steer_note(s, t, n));
            }
            if !progress.answer.is_empty() {
                list = list.child(live_reply(t, k, &progress.answer));
            }
        }
        Turn::Failed { error, message } => {
            // The web's failed note: right-aligned, small, with Retry when there is a message to resend.
            let mut note = row().key("turn-failed").self_end().gap(6.0).center_y().live_region(LiveRegion::Polite).child(label(error.clone(), type_::XS11, t.muted_foreground).wrap());
            if !message.is_empty() {
                note = note.child(
                    label("Retry", TextStyle::new(11.0, 500.0).lh(16.0), t.foreground)
                        .key("turn-retry")
                        .role("button")
                        .focusable(true)
                        .cursor(Cursor::Pointer)
                        .on_press_tx(|s: &mut App, tx| s.retry(tx)),
                );
            }
            list = list.child(note);
        }
        Turn::Idle => {
            if let Some(text) = &s.pending_answer {
                list = list.child(live_reply(t, k, text));
            }
        }
    }
    if let Some(w) = work_pane(s, t, &messages) {
        list = list.child(w.pt(12.0));
    }

    let transcript = col()
        .key("transcript")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        // Both sides as the composer's, so replies start at its left edge and
        // the person's bubbles end at its right edge.
        .px(if side { 12.0 } else { 24.0 })
        .on_layout({
            let track_timeline = !side;
            move |s: &mut App, rect: [f32; 4]| {
                if track_timeline {
                    s.timeline.top = rect[1];
                }
            }
        })
        .child(if side { col().w_full().child(list) } else { col().w_full().items_center().child(list) })
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(if side { 10.0 } else { 16.0 });

    // Only Home shows the empty start state; a new session opens on its transcript.
    let fresh = messages.is_empty() && s.chat_id.is_none() && matches!(s.conversation, Load::Idle) && matches!(s.turn, Turn::Idle);
    let body = if !side && fresh && (s.home || s.general) {
        start(s, t, &business)
    } else {
        let mut b = col()
            .key(if side { "side-transcript-body" } else { "transcript-body" })
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(transcript);
        if !side {
            b = b.children(timeline_rail(s, t, shown, &messages, &turns));
        }
        b
    };
    // A helper opened from here draws beside the panel, as an artifact does (`ui::workspace`).
    let lit = !side && fresh && (s.home || s.general);
    let slot = if side { ComposerSlot::Side } else { ComposerSlot::Main };
    col()
        .key(if side { "side-agent-session" } else { "agent" })
        .w_full()
        .h_full()
        .min_h(0.0)
        .children(if lit { window_light(s, t) } else { None })
        .child(body)
        .child(composer(s, t, &business, slot, false))
}

/// Agent chat with the transcript in `@pierre/words` (WKWebView); composer stays native Rune.
fn words_webview(s: &App, t: &Theme, k: &Kit, column: f32, business: &str) -> El {
    let messages = s.transcript();
    let fresh = messages.is_empty() && s.chat_id.is_none() && matches!(s.conversation, Load::Idle) && matches!(s.turn, Turn::Idle);
    let body = if fresh && (s.home || s.general) {
        start(s, t, business)
    } else {
        let mut stack = col().key("words-stack").w_full().grow(1.0).min_h(0.0);
        stack = stack.child(
            col()
                .key("words-transcript-slot")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .on_layout(|s: &mut App, rect: [f32; 4]| s.words_rect = Some(rect))
                .child(el().key("words-slot-spacer").w_full().h_full()),
        );
        if matches!(s.turn, Turn::Working { .. }) {
            if let Turn::Working { progress, started, stopping, .. } = &s.turn {
                stack = stack.child(
                    live_trace(s, t, k, progress, started.elapsed().as_millis() as i64, *stopping)
                        .pin(None, None, Some(8.0), Some(8.0)),
                );
            }
        }
        col()
            .key("transcript-body")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .items_center()
            .child(col().w_full().max_w(column).grow(1.0).min_h(0.0).child(stack))
    };
    let lit = fresh && (s.home || s.general);
    col()
        .key("agent")
        .w_full()
        .h_full()
        .min_h(0.0)
        .children(if lit { window_light(s, t) } else { None })
        .child(body)
        .child(composer(s, t, business, ComposerSlot::Main, false))
}

/// Home's backdrop while idle: the chosen picture (or the built-in scene for
/// this theme) as a dither (`crate::backdrop`). Faded back so the composer
/// stays the brightest thing; it takes no input and is hidden from assistive tech.
fn window_light(s: &App, t: &Theme) -> Option<El> {
    let pixels = crate::backdrop::current(s.prefs.home_background, t.dark)?;
    Some(
        el()
            .key("home-bg")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .pixels_fit(&pixels, rune::SurfaceFit::Fill)
            .opacity(if t.dark { 0.5 } else { 0.6 })
            .clip_rounded(0.0)
            .a11y_hidden(),
    )
}

fn timeline_rail(s: &App, t: &Theme, owner: &str, messages: &[Message], turns: &[usize]) -> Option<El> {
    if turns.len() < 2 { return None; }
    let active = s.timeline.active(owner, turns);
    let mut marks = col().key("timeline-marks").w(28.0).gap(2.0);
    for (number, &index) in turns.iter().enumerate() {
        let key = format!("timeline-turn-{index}");
        let hovered = s.row_hover.as_deref() == Some(key.as_str());
        let on = active == Some(index);
        let text = messages[index].text.split_whitespace().collect::<Vec<_>>().join(" ");
        let preview: String = text.chars().take(120).collect();
        let preview = if text.chars().count() > 120 { format!("{preview}…") } else { preview };
        marks = marks.child(row().key(key.clone()).w(28.0).h(12.0).center_y()
            .role("button").label(format!("Go to turn {}: {preview}", number + 1)).help(preview)
            .focusable(true).cursor(Cursor::Pointer)
            .on_hover_change(super::widgets::track_hover(key))
            .on_press_tx(move |_s: &mut App, tx| tx.scroll_key_to(format!("msg-{index}"), 16.0))
            .child(el().key(format!("timeline-tick-{index}")).w(if on || hovered { 22.0 } else { 9.0 }).h(2.0).radius(1.0)
                .fill(t.foreground.alpha(if on || hovered { 0.65 } else { 0.22 })).motion(CONTROL)));
    }
    Some(col().key("conversation-timeline").w(28.0).pin(Some(4.0), Some(16.0), None, Some(16.0)).justify_center()
        .child(marks.max_h(360.0).min_h(0.0).shrink().scroll(ScrollSpec { stick_bottom: false })))
}

/// Vertical offset for Home and the side launcher so they line up in a tall window.
pub(super) fn home_stack_top(s: &App) -> f32 {
    let height = if s.window.1 > 0.0 { s.window.1 / s.zoom().max(0.1) } else { 800.0 };
    ((height - 48.0 - 150.0) * 0.32).max(32.0)
}

/// Home before the first message: empty room above the composer until we add content here.
fn start(s: &App, _t: &Theme, _business: &str) -> El {
    el()
        .key("start-scroll")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
}

/// What the agent produced in this chat (`WorkPane`): the proposals its replies
/// saved that still wait for a decision, and the drafts that were accepted.
fn work_pane(s: &App, t: &Theme, messages: &[Message]) -> Option<El> {
    let proposals = s.proposals.ready()?;
    let ids: std::collections::HashSet<&str> =
        messages.iter().filter(|m| m.role != "user").flat_map(|m| m.decisions.iter()).filter(|r| r.kind == "AGENT_PROPOSAL").map(|r| r.id.as_str()).collect();
    let linked: Vec<&crate::api::Proposal> = proposals.iter().filter(|p| ids.contains(p.id.as_str())).collect();
    let open: Vec<chat::DecisionRef> = linked.iter().filter(|p| p.status == "PROPOSED").map(|p| chat::DecisionRef { kind: "AGENT_PROPOSAL".into(), id: p.id.clone() }).collect();
    let kept: Vec<&&crate::api::Proposal> = linked.iter().filter(|p| p.status == "APPROVED" && p.is_draft()).collect();
    if open.is_empty() && kept.is_empty() {
        return None;
    }
    let mut c = col().key("work-pane").w_full().gap(20.0);
    let cards = decisions(s, t, usize::MAX - 1, &open);
    if !cards.is_empty() {
        c = c.child(
            col()
                .w_full()
                .gap(8.0)
                .label("Waiting for your decision")
                .child(row().gap(6.0).center_y().child(el().size(6.0, 6.0).radius(3.0).fill(t.review)).child(label(format!("Waiting for your decision ({})", cards.len()), type_::XS_MEDIUM, t.foreground)))
                .children(cards),
        );
    }
    if !kept.is_empty() {
        let open_ = s.drafts_open;
        let mut d = col().w_full().gap(8.0).child(
            label(format!("Accepted drafts ({}), {}", kept.len(), if open_ { "hide" } else { "view" }), type_::XS_MEDIUM, t.muted_foreground)
                .key("drafts-toggle")
                .role("button")
                .expanded(open_)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover_group()
                .group_color(t.foreground)
                .on_press(|s: &mut App| s.drafts_open = !s.drafts_open),
        );
        if open_ {
            for p in kept {
                d = d.child(draft_card(s, t, p));
            }
        }
        c = c.child(d);
    }
    Some(c)
}

/// An accepted draft (`SavedDraft`): what it is, its text to copy, and its evidence.
fn draft_card(s: &App, t: &Theme, p: &crate::api::Proposal) -> El {
    let mut c = col().key(format!("draft-{}", p.id)).w_full().gap(10.0).padding(16.0).radius(10.0).fill(t.card).hover_group().child(label(format!("{} (accepted)", p.draft_name()), type_::XS_MEDIUM, t.foreground)).child(label(p.message.clone(), type_::XS, t.foreground).wrap());
    match &p.payload {
        Some(pl) => {
            let when = pl.generated_at.as_deref().map(crate::format::date_time).unwrap_or_default();
            c = c.child(label(format!("Prepared {when}. Accepting it saves the draft. Nothing is published or sent."), type_::XS, t.muted_foreground).wrap());
            if let Some(text_) = pl.text.clone().filter(|x| !x.is_empty()) {
                let copy = text_.clone();
                let copied = s.copied == Some(usize::MAX - 2);
                c = c
                    .child(col().w_full().max_h(384.0).child(label(text_, type_::XS.lh(20.0), t.foreground).wrap().selectable(true)).scroll(ScrollSpec { stick_bottom: false }))
                    .child(
                        row()
                            .key(format!("draft-copy-{}", p.id))
                            .size(24.0, 24.0)
                            .radius(6.0)
                            .center()
                            .role("button")
                            .label(if copied { "Copied" } else { "Copy draft" })
                            .help(if copied { "Copied" } else { "Copy" })
                            .cursor(Cursor::Pointer)
                            .hover(t.hover_tint)
                            .on_press_tx(move |s: &mut App, tx| {
                                tx.copy(copy.clone());
                                s.copied = Some(usize::MAX - 2);
                            })
                            .child(ico(if copied { &icons::CHECK } else { &icons::COPY }, 14.0, t.muted_foreground)),
                    );
            }
            if !pl.references.is_empty() {
                let mut refs = row().w_full().gap(8.0).flex_wrap().label("Where this came from");
                for (j, r) in pl.references.iter().enumerate() {
                    let mut l = label(if r.text.is_empty() { "Source".to_string() } else { r.text.clone() }, type_::XS, t.foreground).key(format!("draft-ref-{j}"));
                    if let Some(u) = r.url().map(str::to_string) {
                        l = l.role("link").cursor(Cursor::Pointer).help(u.clone()).on_press_tx(move |s: &mut App, tx| {
                            s.open_link(&u, tx);
                        });
                    }
                    refs = refs.child(l);
                }
                c = c.child(refs);
            }
        }
        None => c = c.child(label("Sources not available", type_::XS, t.muted_foreground)),
    }
    shadows(c, &t.card_shadow)
}

/// A helper session opened from the conversation, to review (`HelperPane`): its
/// own card beside the panel, as an artifact opens, sliding in from the right.
/// Read-only; "Open as main chat" is where to reply. Escape or the close button
/// slides it away.
pub fn helper_pane(s: &App, t: &Theme, k: &Kit, id: &str, load: &Load<crate::api::Conversation>) -> El {
    // The tab names the helper; this row only offers to carry on with it.
    let head = row()
        .w_full()
        .h(40.0)
        .px(16.0)
        .center_y()
        .child(el().grow(1.0))
        .child(
            label("Open as main chat", type_::XS_MEDIUM, t.muted_foreground)
                .key("helper-main")
                .role("button")
                .px(8.0)
                .py(4.0)
                .radius(6.0)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(|s: &mut App| s.helper_as_main()),
        );
    let body = match load {
        Load::Ready(c) => {
            let statuses = task_statuses(&c.messages);
            // A reading column, as the main chat keeps one: lines stay short
            // enough to read however wide the panel is.
            let mut list = col().w_full().max_w(s.prefs.chat_width.max()).gap(12.0);
            for (i, m) in c.messages.iter().enumerate() {
                // Keys and folds of their own, apart from the main conversation's.
                list = list.child(message(s, t, k, 100_000 + i, m, &statuses));
            }
            col().w_full().items_center().px(24.0).pb(24.0).child(list)
        }
        Load::Failed(e) => col().w_full().padding(20.0).child(label(e.clone(), type_::SM_13, t.muted_foreground).wrap()),
        _ => col().w_full().padding(20.0).child(label("Opening the helper…", type_::SM_13, t.muted_foreground)),
    };
    col()
        .key(format!("helper-{id}"))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .fill(t.background)
        .role("complementary")
        .label("Helper session")
        .child(head)
        .child(col().w_full().grow(1.0).min_h(0.0).child(body).scroll(ScrollSpec { stick_bottom: true }))
}

/// The left edge of the card beside the panel (an artifact or a helper): drag
/// to resize within 30 to 70 percent of the split, double-click for half, arrow
/// keys to nudge, as the sidebar's edge does. The share is kept between launches.
pub fn side_edge(what: &str) -> El {
    use crate::prefs::HELPER_DEFAULT;
    el().key(format!("{what}-edge"))
        .pin(Some(0.0), Some(0.0), None, Some(0.0))
        .w(8.0)
        .role("separator")
        .label("Resize side panel")
        .help("Drag to resize; double-click for half and half")
        .focusable(true)
        .cursor(Cursor::ResizeColumn)
        .on_drag(|s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            match d.phase {
                rune::Phase::Down => {
                    d.data = s.prefs.helper();
                    s.resizing = Some(crate::ui::Resize::Helper);
                }
                // Dragging left widens the card.
                rune::Phase::Move if s.split_w > 0.0 => s.prefs.helper_width = (d.data - d.dx / s.zoom() / s.split_w * 100.0).clamp(30.0, 70.0),
                rune::Phase::Move => {}
                rune::Phase::Up => {
                    if d.cancelled() {
                        s.prefs.helper_width = d.data;
                    }
                    s.resizing = None;
                    s.prefs.save();
                }
            }
        })
        .on_double_press(|s: &mut App| {
            s.prefs.helper_width = HELPER_DEFAULT;
            s.prefs.save();
        })
        .on_key(|s: &mut App, ev: &rune::KeyEvent, _tx: &mut rune::Tx| {
            let step = match ev.key {
                rune::Key::Left => 2.0,
                rune::Key::Right => -2.0,
                _ => return false,
            };
            s.prefs.helper_width = (s.prefs.helper() + step).clamp(30.0, 70.0);
            s.prefs.save();
            true
        })
}

// ---- Motion (the web's `chip-in`) -------------------------------------------

/// Chips follow one another in, 50 milliseconds apart.
fn chip_in(el_: El, n: usize) -> El {
    el_.transition(Transition::offset(0.0, 3.0).combined(Transition::opacity()).combined(Transition::scale(0.97))).enter_delay(0.05 * n.min(4) as f32)
}

// ---- Messages ---------------------------------------------------------------

/// The provider and model that answered a reply.
fn model_of(m: &Message) -> Option<(String, String)> {
    let i = m.inference.as_ref().filter(|_| m.role != "user")?;
    Some((i.provider.clone(), i.model.clone().unwrap_or_default()))
}

fn brand_of(m: &Message) -> String {
    let (p, model) = model_of(m).unwrap_or_default();
    brands::model_brand(&model, &p)
}

/// The model's name when this reply came from another model than the reply before it.
fn handover(messages: &[Message], i: usize) -> Option<String> {
    let now = model_of(&messages[i])?;
    let before = messages[..i].iter().rev().find_map(model_of)?;
    (before != now).then(|| if now.1.is_empty() { now.0 } else { now.1 })
}

/// A thin rule with a note in the middle.
fn divider(t: &Theme, key: &str, logo: Option<&str>, note: &str) -> El {
    let line = || el().grow(1.0).h(1.0).fill(t.border);
    let mut mid = row().gap(6.0).center_y();
    if let Some(b) = logo {
        mid = mid.child(brands::mark(t, b, 12.0));
    }
    row().key(key).w_full().py(4.0).gap(8.0).center_y().role("note").child(line()).child(mid.child(label(note.to_string(), type_::XS11, t.muted_foreground))).child(line())
}

/// Each helper's latest status: a later message (its posted result) supersedes the card that started it.
fn task_statuses(messages: &[Message]) -> std::collections::HashMap<String, String> {
    messages.iter().flat_map(|m| m.tasks.iter()).map(|t| (t.id.clone(), t.status.clone())).collect()
}

/// An agent reply drawn as the chat draws it, outside the chat: Markdown with
/// its ```chart blocks as charts, ```ui blocks as generated views and
/// ```mermaid blocks as diagrams.
pub(crate) fn reply_body(s: &App, t: &Theme, k: &Kit, key: &str, text_: &str) -> El {
    let mut reply = col().key(key.to_string()).w_full().gap(6.0);
    for (j, part) in crate::visual::split(text_).into_iter().enumerate() {
        reply = reply.child(match part {
            crate::visual::Part::Text(md) => words_markdown(&md, t, k)
                .selectable(true)
                // A diagram wider than a narrow pane scrolls sideways instead of spilling out of it.
                .diagram_frame(|card, _| col().w_full().child(card).scroll_x())
                .build(k)
                .w_full(),
            crate::visual::Part::Chart(raw) => crate::ui::visual::view(s, t, format!("{key}-visual-{j}"), &raw).my(4.0),
            crate::visual::Part::Ui(raw) => crate::ui::surface::view(s, t, format!("{key}-surface-{j}"), &raw).my(4.0),
        });
    }
    reply
}

/// Agent prose with Pierre syntax colouring (same stack as `@pierre/words` / highlights on web).
fn words_markdown(md: &str, t: &Theme, k: &Kit) -> Markdown {
    Markdown::new(md).style(prose(t, k)).highlighter(crate::ui::words::highlighter(k))
}

/// A reply's prose, as Rune's chat sets it: 14 point Inter on a 22.4 line,
/// bold at 600 rather than 670, and headings only a step above the body.
fn prose(t: &Theme, k: &Kit) -> MarkdownStyle {
    let body = TextStyle::new(14.0, 400.0).lh(22.4);
    MarkdownStyle::from_kit(k)
        .text(t.foreground)
        .body_font(body)
        .strong_weight(600.0)
        .heading_font(1, TextStyle::new(16.0, 600.0).lh(24.0))
        .heading_font(2, TextStyle::new(15.0, 600.0).lh(24.0))
        .heading_font(3, TextStyle::new(14.0, 600.0).lh(22.4))
        .heading_font(4, TextStyle::new(14.0, 600.0).lh(22.4))
}

/// A question the agent left without stopping: the question, its answers to
/// pick, and the answer it assumes until one is picked. Picking one while the
/// agent works reaches it at its next step; afterwards it asks it to update
/// what it made. "Other" types an answer of the person's own.
fn blank_card(s: &App, t: &Theme, b: &chat::Blank) -> El {
    let answer = s.blank_answer(b);
    let mut choices = row().gap(6.0).flex_wrap().center_y();
    let mut options = b.options.clone();
    if !options.iter().any(|o| o.eq_ignore_ascii_case(&b.assumed)) {
        options.insert(0, b.assumed.clone());
    }
    for (j, o) in options.iter().enumerate() {
        let picked = answer.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(o));
        let (blank, choice) = (b.clone(), o.clone());
        let mut chip = row()
            .key(format!("blank-{}-{j}", b.id))
            .h(28.0)
            .px(12.0)
            .radius(14.0)
            .center_y()
            .role("button")
            .label(format!("Answer {}: {o}", b.question))
            .checked(picked)
            .focusable(answer.is_none())
            .border(1.0, if picked { t.primary } else { t.border })
            .motion(CONTROL)
            .child(label(o.clone(), type_::XS_MEDIUM, if picked { t.foreground } else { t.muted_foreground }));
        if answer.is_none() {
            chip = chip.cursor(Cursor::Pointer).hover(t.hover_tint).on_press_tx(move |s: &mut App, tx| s.answer_blank(&blank, &choice, tx));
        } else if picked {
            chip = chip.fill(t.accent);
        }
        choices = choices.child(chip);
    }
    if answer.is_none() {
        let blank = b.clone();
        choices = choices.child(
            label("Other…", type_::XS_MEDIUM, t.muted_foreground)
                .key(format!("blank-{}-other", b.id))
                .role("button")
                .px(8.0)
                .py(6.0)
                .radius(6.0)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press_tx(move |s: &mut App, tx| s.answer_blank_freely(&blank, tx)),
        );
    }
    let status = match &answer {
        Some(a) => format!("You answered: {a}"),
        None => format!("Assuming {} until you answer", b.assumed),
    };
    shadows(
        col()
            .key(format!("blank-{}", b.id))
            .w_full()
            .max_w(560.0)
            .px(14.0)
            .py(12.0)
            .gap(8.0)
            .radius(12.0)
            .fill(t.card)
            .role("group")
            .label(format!("Question from the agent: {}", b.question))
            .transition(chip_in_t())
            .child(label(b.question.clone(), type_::SM_MEDIUM, t.foreground).wrap())
            .child(choices)
            .child(label(status, type_::XS11, t.muted_foreground)),
        &t.card_shadow,
    )
}

/// A message sent while the agent worked: the user's bubble, and under it
/// whether the run has read it yet (it reads between steps).
fn steer_note(s: &App, t: &Theme, n: &chat::Steer) -> El {
    let state = if n.read { "Read by the agent" } else if n.id.is_some() { "The agent reads it at its next step" } else { "Sending…" };
    col()
        .key(format!("steer-{}", n.local))
        .w_full()
        .items_end()
        .gap(4.0)
        .transition(chip_in_t())
        .child(user_bubble(s, t, &n.text))
        .child(
            row()
                .gap(4.0)
                .center_y()
                .live_region(LiveRegion::Polite)
                .child(ico(if n.read { &icons::CHECK } else { &icons::CORNER_DOWN_RIGHT }, 12.0, t.muted_foreground))
                .child(label(state, type_::XS11, t.muted_foreground)),
        )
}

/// The person's message bubble.
fn user_bubble(s: &App, t: &Theme, text: &str) -> El {
    col()
        .max_w(s.prefs.chat_width.max().min(900.0) * 0.85)
        .px(16.0)
        .py(10.0)
        .radius(16.0)
        .fill(t.accent)
        .child(label(text.to_string(), type_::SM.lh(22.0), t.foreground).wrap().selectable(true))
}

fn message(s: &App, t: &Theme, k: &Kit, i: usize, m: &Message, statuses: &std::collections::HashMap<String, String>) -> El {
    let user = m.role == "user";
    let mut c = col().key(format!("msg-{i}")).w_full().gap(4.0).hover_group();
    c = if user { c.items_end() } else { c.items_start() };
    if let Some(o) = &m.origin {
        c = c.child(row().gap(4.0).center_y().child(ico(&icons::CORNER_DOWN_RIGHT, 12.0, t.muted_foreground)).child(label(o.text(), type_::XS11, t.muted_foreground)));
    }
    if user {
        if !m.attachments.is_empty() {
            let mut files = row().gap(6.0).flex_wrap();
            for (j, a) in m.attachments.iter().enumerate() {
                files = files.child(attachment_chip(t, &format!("attachment-{i}-{j}"), &a.name, a.lines(), None));
            }
            c = c.child(files);
        }
        if !m.text.is_empty() {
            c = c.child(user_bubble(s, t, &m.text));
        }
        c = c.child(copy_button(s, t, i, &m.text));
        // What the person added while that turn worked, as sent.
        for note in &m.notes {
            c = c.child(user_bubble(s, t, note)).child(label("Sent while the agent worked", type_::XS11, t.muted_foreground));
        }
        return c;
    }
    let mut body = col().w_full().gap(6.0);
    body = body.child(run_trace(s, t, k, i, &m.work_log(), m.duration_ms));
    let muted = m.run.as_ref().is_some_and(|r| r.status != "COMPLETED" && !r.status.is_empty());
    // Markdown (Pierre / rune-kit — native sibling of `@pierre/words` on web), with ```chart
    // blocks as charts. A fresh reply streams the full text with a 180ms fade; tap to settle.
    let animating = s.words_revealing(&m.text);
    let mut reply = col().key(format!("reply-{i}")).w_full().gap(6.0);
    for (j, part) in crate::visual::split(&m.text).into_iter().enumerate() {
        reply = reply.child(match part {
            crate::visual::Part::Text(md) => words_markdown(&md, t, k)
                .selectable(!animating)
                .streaming(animating)
                .reveal(if animating { 0.18 } else { 0.0 })
                .build(k)
                .w_full()
                .opacity(if muted { 0.7 } else { 1.0 }),
            crate::visual::Part::Chart(raw) => crate::ui::visual::view(s, t, format!("visual-{i}-{j}"), &raw).my(4.0),
            crate::visual::Part::Ui(raw) => crate::ui::surface::view(s, t, format!("surface-{i}-{j}"), &raw).my(4.0),
        });
    }
    if animating {
        reply = reply.cursor(Cursor::Default).on_press(|s: &mut App| s.reveal = None);
    }
    body = body.child(reply);
    if let Some(r) = &m.run {
        if !r.gaps.is_empty() {
            body = body.child(label(format!("Not fully checked: {}", r.gaps.join("; ")), type_::XS11, t.partial).wrap());
        }
    }
    if !m.citations.is_empty() {
        body = body.child(resources(s, t, i, m));
    }
    if !m.tasks.is_empty() && m.origin.as_ref().is_none_or(|o| o.kind != "result") {
        body = body.child(tasks(s, t, i, m, statuses));
    }
    if !m.artifacts.is_empty() {
        body = body.children(artifacts(t, i, &m.artifacts));
        // The questions it left while it worked stay on the reply, answerable.
        for b in &m.blanks {
            body = body.child(blank_card(s, t, b));
        }
    }
    if !m.decisions.is_empty() {
        body = body.children(decisions(s, t, i, &m.decisions));
    }
    c.child(body).child(reply_actions(s, t, i, &m.text))
}

/// Under a reply: copy, helpful, not helpful, and (on the latest) ask again.
/// They show under the pointer, as copy did.
fn reply_actions(s: &App, t: &Theme, i: usize, text_: &str) -> El {
    let rated = s.rated.get(&(s.chat_id.clone().unwrap_or_default(), i)).copied();
    let latest = s.transcript().iter().rposition(|m| m.role != "user") == Some(i) && !matches!(s.turn, Turn::Working { .. });
    let act = |key: String, icon: &'static rune::Icon, name: &str, on: bool| {
        row()
            .key(key)
            .size(24.0, 24.0)
            .radius(6.0)
            .center()
            .role("button")
            .label(name.to_string())
            .help(name.to_string())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .child(ico(icon, 14.0, if on { t.foreground } else { t.muted_foreground }))
    };
    let mut r = row()
        .gap(2.0)
        .center_y()
        .group_opacity(if rated.is_some() { 1.0 } else { 0.0 }, 1.0)
        .child(copy_button(s, t, i, text_))
        .child(act(format!("good-{i}"), &icons::THUMBS_UP, "Helpful", rated == Some(true)).on_press(move |s: &mut App| s.rate_reply(i, true)))
        .child(act(format!("bad-{i}"), &icons::THUMBS_DOWN, "Not helpful", rated == Some(false)).on_press(move |s: &mut App| s.rate_reply(i, false)));
    if latest {
        r = r.child(act(format!("retry-{i}"), &icons::REFRESH_CW, "Ask again", false).on_press_tx(|s: &mut App, tx| s.retry_reply(tx)));
    }
    // A saved reply can start a new chat that carries everything up to it.
    if s.chat_id.is_some() && !matches!(s.turn, Turn::Working { .. }) {
        r = r.child(act(format!("branch-{i}"), &icons::GIT_BRANCH, "Branch into a new chat", false).on_press(move |s: &mut App| s.branch_reply(i)));
    }
    r
}

fn copy_button(s: &App, t: &Theme, i: usize, text_: &str) -> El {
    let copied = s.copied == Some(i);
    let text_ = text_.to_string();
    row()
        .key(format!("copy-{i}"))
        .size(24.0, 24.0)
        .radius(6.0)
        .center()
        .role("button")
        .label(if copied { "Copied" } else { "Copy message" })
        .help(if copied { "Copied" } else { "Copy" })
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .group_opacity(if copied { 1.0 } else { 0.0 }, 1.0)
        .on_press_tx(move |s: &mut App, tx| {
            tx.copy(text_.clone());
            s.copied = Some(i);
        })
        .child(ico(if copied { &icons::CHECK } else { &icons::COPY }, 14.0, t.muted_foreground))
}

// ---- The work log -----------------------------------------------------------

/// The periwinkle the web's thinking glyph takes (`text-secondary`).
fn secondary(t: &Theme) -> rune::Color {
    if t.dark { hex("#8aa8fa") } else { hex("#7096f9") }
}

/// A finished reply's process: one "Thought for 12s" line (Rune's collapsible)
/// at the top of the reply; open, it shows every thought and tool call in the
/// order they ran. The reply itself follows under it.
fn run_trace(s: &App, t: &Theme, k: &Kit, i: usize, activity: &[Activity], duration: Option<i64>) -> El {
    let thought: i64 = activity.iter().map(|a| if let Activity::Thought { ms, .. } = a { *ms } else { 0 }).sum();
    let ms = duration.filter(|d| *d > 0).unwrap_or(thought);
    if activity.is_empty() && ms <= 0 {
        return el();
    }
    let at = (i, 0);
    let open = s.open_logs.contains(&at);
    let title = if ms > 0 { format!("Thought for {}", chat::elapsed(ms)) } else { "Thought".to_string() };
    let line = el().pin(Some(11.5), Some(12.0), None, Some(12.0)).w(1.0).fill(t.border);
    let mut rail = col().key(format!("trace-{i}-rail")).w_full().pt(2.0).pb(6.0).child(line);
    for (j, a) in activity.iter().enumerate() {
        rail = rail.child(step(t, a).key(format!("trace-{i}-step-{j}")));
    }
    if activity.is_empty() {
        rail = rail.child(label("No steps were recorded for this reply.", type_::XS, t.muted_foreground));
    }
    let fold = rune_kit::Collapsible::new(title.clone(), open)
        .ghost()
        .on_toggle(move |s: &mut App| {
            if !s.open_logs.remove(&at) {
                s.open_logs.insert(at);
            }
        })
        .child(rail)
        .build(k);
    col().key(format!("trace-{i}")).w_full().label(title).child(fold)
}

// ---- The turn still running (the web's `LiveTrace`) -----------------------------

/// Thinking and working: the app's loader, turning. Still when motion is reduced.
fn thinking_glyph(t: &Theme, reduce: bool) -> El {
    let mark = ico(&icons::LOADER, 16.0, t.muted_foreground);
    row().size(24.0, 24.0).center().a11y_hidden().child(if reduce { mark } else { mark.looping(rune::LoopSpec::rotation(1.0)) })
}

/// A finished thought's mark, as Claude Code sets one: a quiet "∴".
fn thought_mark(t: &Theme) -> El {
    row().size(16.0, 16.0).center().a11y_hidden().child(rune::text("∴").font(type_::SM).color(t.muted_foreground))
}

/// One line on the rail: a node and its text. Tool steps sit in a small round
/// node; reasoning is a lighter aside with its glyph.
fn log_row(t: &Theme, node: El, body: El, boxed: bool, wrap: bool) -> El {
    let mut n = row().size(24.0, 24.0).center().child(node);
    if boxed {
        n = shadows(n.radius(12.0).fill(t.background), &t.control_shadow);
    }
    let r = row().w_full().min_h(28.0).py(2.0).gap(8.0).child(n).child(col().grow(1.0).min_w(0.0).child(body));
    if wrap { r.items_start() } else { r.center_y() }
}

fn step(t: &Theme, a: &Activity) -> El {
    match a {
        Activity::Thought { text: x, .. } => log_row(t, thought_mark(t), label(x.clone(), type_::SM.italic(), t.muted_foreground.alpha(0.8)).wrap().max_lines(4).pt(2.0), false, true),
        Activity::Tool { tool, text: x, failed } => {
            let icon = if *failed { ico(&icons::X, 14.0, t.wrong) } else { ico(chat::tool_icon(tool), 14.0, t.foreground.alpha(0.7)) };
            log_row(t, icon, label(x.clone(), type_::SM, if *failed { t.wrong.alpha(0.8) } else { t.foreground.alpha(0.8) }).truncate(), true, false)
        }
    }
}

/// A turn still running: the loader turning beside "Thinking" (or "Working"
/// once a tool runs) and a rolling timer; under it the step under way, which
/// slides in each time it changes; and the steps already done, folded into one
/// of Rune's collapsibles.
fn live_trace(s: &App, t: &Theme, k: &Kit, p: &Progress, ms: i64, stopping: bool) -> El {
    let reduce = s.prefs.reduce_motion;
    let working = p.phase != chat::Phase::Thinking || p.trace.iter().any(|a| matches!(a, Activity::Tool { .. }));
    let head = if stopping { "Stopping" } else if working { "Working" } else { "Thinking" };
    let tool = match (p.phase, &p.current_tool) {
        (chat::Phase::Working, Some(tool)) => Some(tool.clone()),
        _ => None,
    };
    let mut c = col().key("working").w_full().gap(4.0).role("status").live_region(LiveRegion::Polite).label(format!("{head}, {}. {}", chat::elapsed(ms), p.live()));
    if !p.trace.is_empty() {
        let at = (usize::MAX, 0);
        let n = p.trace.len();
        let line = el().pin(Some(11.5), Some(12.0), None, Some(12.0)).w(1.0).fill(t.border);
        let mut rail = col().key("live-steps").w_full().pt(2.0).pb(4.0).child(line);
        for (i, a) in p.trace.iter().enumerate() {
            rail = rail.child(step(t, a).key(format!("live-step-{i}")));
        }
        c = c.child(
            rune_kit::Collapsible::new(format!("{n} {} so far", if n == 1 { "step" } else { "steps" }), s.open_logs.contains(&at))
                .ghost()
                .on_toggle(move |s: &mut App| {
                    if !s.open_logs.remove(&at) {
                        s.open_logs.insert(at);
                    }
                })
                .child(rail)
                .build(k),
        );
    }
    let headline = row()
        .key("live-head")
        .h(28.0)
        .gap(8.0)
        .center_y()
        .child(thinking_glyph(t, reduce))
        .child(label(head, type_::SM_MEDIUM, t.foreground))
        .child(rune_kit::RollingText::new("live-elapsed", chat::elapsed(ms)).font(type_::SM.features("'tnum' 1")).color(t.muted_foreground).build(k));
    // The step under way: each new one slides up into place as the last leaves.
    let now_text = p.live();
    let show_now = !stopping
        && match head {
            "Thinking" => now_text != "Thinking",
            "Working" => tool.is_some() || (now_text != "Working" && !now_text.is_empty()),
            _ => !now_text.is_empty(),
        };
    let mut now = row()
        .key(format!("live-now:{}", now_text))
        .w_full()
        .min_h(22.0)
        .pl(32.0)
        .gap(8.0)
        .center_y()
        .transition(Transition::offset(0.0, 6.0).combined(Transition::opacity()));
    if let Some(tool) = &tool {
        now = now.child(ico(chat::tool_icon(tool), 13.0, t.muted_foreground));
    }
    now = now.child(label(now_text, if tool.is_some() { type_::SM_13 } else { type_::SM_13.italic() }, t.muted_foreground).truncate().grow(1.0).min_w(0.0));
    if show_now {
        c.child(headline).child(now)
    } else {
        c.child(headline)
    }
}

/// The answer while it is being written, drawn as it will be once it is stored.
fn live_reply(t: &Theme, k: &Kit, text: &str) -> El {
    let live = chat::live_answer(text);
    col().key("live-reply").w_full().pt(4.0).child(
        words_markdown(&live, t, k)
            .streaming(true)
            .reveal(0.18)
            .build(k)
            .w_full(),
    )
}

/// At the top of a helper session: what it is for and where it came from.
fn helper_banner(t: &Theme, info: &chat::SessionInfo, parent: String) -> El {
    let name = format!("{} helper{}", chat::role_label(info.role.as_deref().unwrap_or("general")), info.title.as_ref().map(|x| format!(", {x}")).unwrap_or_default());
    shadows(
        row()
            .key("helper-banner")
            .w_full()
            .px(14.0)
            .py(10.0)
            .gap(8.0)
            .center_y()
            .radius(10.0)
            .fill(t.card)
            .child(ico(&icons::USERS, 14.0, t.muted_foreground))
            .child(label(name, type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
            .child(
                label("Open the session that started it", type_::XS_MEDIUM, t.foreground)
                    .key("open-parent")
                    .role("link")
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut App| s.open_session(&parent)),
            ),
        &t.card_shadow,
    )
}

// ---- What a reply points to -------------------------------------------------

fn resources(s: &App, t: &Theme, i: usize, m: &Message) -> El {
    let open = s.open_sources.contains(&i);
    let toggle = label(format!("Resources ({})", m.citations.len()), type_::XS_MEDIUM, t.muted_foreground)
        .hover_group()
        .group_color(t.foreground)
        .key(format!("resources-{i}"))
        .role("button")
        .expanded(open)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .on_press(move |s: &mut App| {
            if !s.open_sources.remove(&i) {
                s.open_sources.insert(i);
            }
        });
    let mut c = col().w_full().pt(2.0).gap(8.0).child(toggle);
    if open {
        let mut chips = row().gap(8.0).flex_wrap();
        for (j, cit) in m.citations.iter().enumerate() {
            let url = cit.url().map(str::to_string);
            let name = if cit.text.is_empty() { url.clone().unwrap_or_else(|| "Open source".into()) } else { cit.text.clone() };
            // The chat box's shape at a smaller size: a pill on the card
            // colour with a hairline border, its icon in a round frame.
            let icon = row()
                .size(20.0, 20.0)
                .radius(10.0)
                .center()
                .fill(t.accent)
                .child(ico(if url.is_some() { &icons::GLOBE } else { &icons::FILE_TEXT }, 11.0, t.muted_foreground).group_color(t.foreground));
            let mut chip = row()
                .key(format!("source-{i}-{j}"))
                .h(28.0)
                .gap(6.0)
                .center_y()
                .pl(4.0)
                .pr(12.0)
                .radius(14.0)
                .border(1.0, t.border)
                .fill(t.card)
                .hover(t.accent.alpha(0.5))
                .hover_group()
                .motion(CONTROL)
                .max_w(288.0)
                .child(icon)
                .child(label(name, type_::XS, t.muted_foreground).group_color(t.foreground).truncate());
            if let Some(u) = url {
                chip = chip.role("link").help(u.clone()).cursor(Cursor::Pointer).on_press_tx(move |s: &mut App, tx| {
                    s.open_link(&u, tx);
                });
            }
            chips = chips.child(chip_in(chip, j));
        }
        c = c.child(chips);
    }
    c
}

fn tasks(s: &App, t: &Theme, i: usize, m: &Message, statuses: &std::collections::HashMap<String, String>) -> El {
    // A helper: what it is doing, which kind of helper, and where it stands.
    let mut c = col().w_full().pt(4.0).gap(6.0);
    for task in &m.tasks {
        let status = statuses.get(&task.id).unwrap_or(&task.status).as_str();
        let state = match status {
            "RUNNING" => {
                let spin = ico(&icons::LOADER, 14.0, t.working);
                if s.prefs.reduce_motion { spin } else { spin.looping(rune::LoopSpec::rotation(1.0)) }
            }
            "COMPLETED" => ico(&icons::CHECK, 14.0, t.muted_foreground),
            _ => ico(&icons::CIRCLE_ALERT, 14.0, t.wrong),
        };
        let detail = format!("{} helper, {}", chat::role_label(if task.role.is_empty() { "general" } else { &task.role }), chat::task_status(status).to_lowercase());
        let mut card = item_card(t, format!("task-{i}-{}", task.id), &icons::USERS, &task.title, &detail, state);
        if !task.session_id.is_empty() {
            let id = task.session_id.clone();
            card = card
                .role("link")
                .label(format!("Open the helper session: {}", task.title))
                .help(task.model.clone().unwrap_or_else(|| "Open the helper session".into()))
                .focusable(true)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.open_helper(&id));
        }
        let n = c_count(&m.tasks, &task.id);
        c = c.child(chip_in(card, n));
    }
    c
}

/// What a reply made or started (a landing page, a helper at work): a small
/// card with its kind in a rounded tile, the title over one quiet line that
/// says what it is, and where it stands on the right.
fn item_card(t: &Theme, key: String, icon: &'static rune::Icon, title: &str, detail: &str, trailing: El) -> El {
    row()
        .key(key)
        .w_full()
        .max_w(440.0)
        .pl(8.0)
        .pr(14.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .radius(12.0)
        .border(1.0, t.border)
        .fill(t.card)
        .hover(t.accent.alpha(0.5))
        .hover_group()
        .motion(CONTROL)
        .child(row().size(36.0, 36.0).radius(9.0).center().fill(t.accent).child(ico(icon, 16.0, t.muted_foreground).group_color(t.foreground)))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(1.0)
                .child(label(title.to_string(), type_::SM_MEDIUM, t.foreground).truncate().min_w(0.0))
                .child(label(detail.to_string(), type_::XS, t.muted_foreground).truncate().min_w(0.0)),
        )
        .child(trailing)
}

fn c_count(tasks: &[chat::TaskRef], id: &str) -> usize {
    tasks.iter().position(|x| x.id == id).unwrap_or(0)
}

/// The proposals a reply saved that still wait for a decision, each opening in the inbox.
/// What a reply wrote, opened beside its conversation.
fn artifacts(t: &Theme, i: usize, refs: &[chat::ArtifactRef]) -> Vec<El> {
    // Just the title; a press opens it as a tab of the right panel.
    refs.iter()
        .map(|r| {
            let id = r.id.clone();
            let page = crate::artifacts::is_page(&r.kind);
            let detail = format!("{}, version {}", r.kind_label(), r.version.max(1));
            let icon = if page { &icons::GLOBE } else { &icons::FILE_TEXT };
            row()
                .w_full()
                .transition(chip_in_t())
                .child(
                    item_card(t, format!("artifact-{i}-{}", r.id), icon, &r.title, &detail, ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground).group_color(t.foreground))
                        .role("link")
                        .label(format!("Open {}", r.title))
                        .help(r.caption())
                        .focusable(true)
                        .cursor(Cursor::Pointer)
                        .on_press(move |s: &mut App| if page { s.open_page_artifact(&id) } else { s.open_artifact(&id) }),
                )
        })
        .collect()
}

fn decisions(s: &App, t: &Theme, i: usize, refs: &[chat::DecisionRef]) -> Vec<El> {
    use crate::ui::widgets::{Variant, button};
    let mut out = Vec::new();
    for r in refs {
        let key = r.key();
        let Some(d) = s.decisions.iter().find(|d| d.key == key) else { continue };
        let busy = s.deciding.as_deref() == Some(key.as_str());
        let here = s.decision.as_deref() == Some(key.as_str());
        // Kind, title, then what it is about: three steps of the type scale,
        // one weight for the title only, the footer set apart by a hairline.
        let summary = if d.summary.is_empty() { None } else { Some(label(d.summary.clone(), type_::SM_13, t.muted_foreground).wrap().max_lines(3).pt(4.0)) };
        let eyebrow = row()
            .gap(8.0)
            .center_y()
            .pb(8.0)
            .child(el().size(6.0, 6.0).radius(3.0).fill(t.review))
            .child(label(d.label.clone(), type_::XS, t.muted_foreground));
        let mut c = col()
            .key(format!("decision-{i}-{key}"))
            .w_full()
            .padding(16.0)
            .radius(12.0)
            .border(1.0, t.border)
            .fill(t.card)
            .role("group")
            .label("Waiting for your decision")
            .transition(chip_in_t())
            .child(eyebrow)
            .child(label(d.title.clone(), type_::SM_MEDIUM, t.foreground).wrap())
            .children(summary);
        if let Some((k, e)) = &s.decision_error {
            if k == &key {
                c = c.child(label(e.clone(), type_::SM_13, t.wrong).wrap().live_region(LiveRegion::Polite));
            }
        }
        // Decided where it was proposed, as the web's cards do. A re-check needs its
        // measurement model chosen, which the inbox offers.
        let actions = if d.act == crate::decisions::Act::Check {
            let open = key.clone();
            row().pt(6.0).gap(8.0).child(button(t, &format!("review-{i}-{key}"), "Choose a model and decide", Variant::Primary).on_press(move |s: &mut App| {
                s.show_view(View::Workspace);
                s.show_page(Page::Inbox);
                s.select_decision(&open);
            }))
        } else if here && s.declining {
            let input = text_input(&s.decline_reason, type_::SM)
                .key("decline-reason")
                .placeholder("Why not? Optional, saved for the agent", t.muted_foreground)
                .label("Reason for declining")
                .w_full()
                .color(t.foreground)
                .on_edit(|s: &mut App| &mut s.decline_reason)
                .on_submit(|s: &mut App, _| s.confirm_decline());
            let confirm = button(t, &format!("decline-confirm-{i}"), if busy { "Declining…" } else { d.decline.as_str() }, Variant::Primary);
            col()
                .w_full()
                .pt(6.0)
                .gap(8.0)
                .child(shadows(row().w_full().h(36.0).px(12.0).radius(8.0).center_y().fill(t.control).child(input), &t.control_shadow))
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(el().grow(1.0))
                        .child(button(t, &format!("decline-cancel-{i}"), "Cancel", Variant::Outline).on_press(|s: &mut App| s.cancel_decline()))
                        .child(if busy { confirm.opacity(0.5) } else { confirm.on_press(|s: &mut App| s.confirm_decline()) }),
                )
        } else {
            let blocked = d.blocked(None);
            let (k1, k2) = (key.clone(), key.clone());
            let decline = button(t, &format!("decline-{i}-{key}"), d.decline.as_str(), Variant::Outline);
            let approve = button(t, &format!("approve-{i}-{key}"), if busy { "Working…" } else { d.approve.as_str() }, Variant::Primary);
            let mut bar = row().w_full().mt(14.0).pt(12.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border).gap(12.0).center_y().flex_wrap();
            bar = bar.child(match blocked.map(str::to_string).or_else(|| d.note.clone()) {
                Some(n) => label(n, type_::XS, t.muted_foreground.alpha(0.8)).wrap().grow(1.0).min_w(200.0),
                None => el().grow(1.0),
            });
            bar.child(if busy { decline.opacity(0.5) } else { decline.on_press_tx(move |s: &mut App, tx| s.decline_in_chat(&k1, tx)) })
                .child(if busy || blocked.is_some() { approve.opacity(0.5).cursor(Cursor::Default) } else { approve.on_press(move |s: &mut App| s.approve_in_chat(&k2)) })
        };
        out.push(shadows(c.child(actions), &t.card_shadow));
    }
    out
}

fn chip_in_t() -> Transition {
    Transition::offset(0.0, 3.0).combined(Transition::opacity()).combined(Transition::scale(0.97))
}

// ---- The composer -----------------------------------------------------------

/// The box's inset around its round buttons, the same on every side, so the
/// buttons sit concentric with the pill's ends (radius = inset + 16).
pub(super) const COMPOSER_INSET: f32 = 6.0;
pub(super) const COMPOSER_BUTTON: f32 = 32.0;
pub(super) const COMPOSER_PILL: f32 = COMPOSER_INSET + COMPOSER_BUTTON / 2.0;

/// Equalizer bars for the composer's idle voice affordance.
fn waveform_bars(ink: rune::Color) -> El {
    row()
        .gap(2.0)
        .center_y()
        .child(el().size(2.0, 8.0).radius(1.0).fill(ink))
        .child(el().size(2.0, 14.0).radius(1.0).fill(ink))
        .child(el().size(2.0, 10.0).radius(1.0).fill(ink))
        .child(el().size(2.0, 16.0).radius(1.0).fill(ink))
}

/// The chat box. The right panel draws the same one under an artifact or a
/// helper (`ComposerSlot::Side`): its own text, the same model, files and
/// buttons, and what is sent goes to the chat about the tab in front.
pub fn composer(s: &App, t: &Theme, business: &str, slot: ComposerSlot, float_on_page: bool) -> El {
    let side = slot == ComposerSlot::Side;
    let text_state = if side { &s.side.composer } else { &s.composer };
    let working = matches!(s.turn, Turn::Working { .. });
    let blocked = s.model_unavailable();
    let has_text = !text_state.text.trim().is_empty();
    let placeholder = if blocked {
        "No agent model is available. Connect one in Settings, Agent"
    } else if working {
        "Add to what the agent is doing"
    } else if side && matches!(s.side_tab(), crate::side::SideTab::Helper(_)) {
        "Ask about this helper's work"
    } else if side && matches!(s.side_tab(), crate::side::SideTab::Page(Page::Campaigns)) {
        "Reply to the agent about campaigns"
    } else if side {
        "Ask for a change to this page"
    } else if !s.transcript().is_empty() {
        "Reply to the agent, or type / for commands"
    } else {
        "Describe a task or ask a question"
    };
    let mut input = crate::ui::widgets::field_input(text_state, type_::BASE, t)
        .key(slot.key("composer-input"))
        .placeholder(placeholder, t.muted_foreground)
        .label("Message the agent")
        .w_full()
        .py(4.0)
        .max_h(192.0)
        .on_edit(move |s: &mut App| if side { &mut s.side.composer } else { &mut s.composer })
        .on_input_paste(|s: &mut App, content, _tx| s.composer_paste(content))
        // Return sends, or with "Send with Enter" off adds a line (⌘Return sends then).
        .on_submit(move |s: &mut App, tx| {
            if s.prefs.enter_to_send {
                s.send_from(slot, tx);
            } else if side {
                s.side.composer.insert("\n");
            } else {
                s.composer.insert("\n");
            }
        });
    if !side {
        // While the "/" menu is open, arrows, Tab, Return and Escape drive it.
        input = input.on_input_key(|s: &mut App, ev, tx| s.composer_key(ev, tx)).autofocus();
    }
    // The buttons at the box's right end, as the web composer draws them: while a
    // turn runs, a queue button (once something is typed) and Stop; otherwise Send,
    // only once something is typed.
    let circle = |key: &str, name: &str, help: &str, fill: rune::Color| {
        row().key(slot.key(key)).size(COMPOSER_BUTTON, COMPOSER_BUTTON).radius(COMPOSER_BUTTON / 2.0).center().role("button").label(name).help(help).focusable(true).cursor(Cursor::Pointer).fill(fill).motion(CONTROL)
    };
    let action_fill = if t.dark { t.foreground.alpha(0.12) } else { t.foreground.alpha(0.10) };
    let action_hover = t.foreground.alpha(if t.dark { 0.18 } else { 0.16 });
    let action_ink = t.foreground.alpha(0.85);
    /// Round composer control with the same accent hover as the "+" action menu.
    let action_btn = |key: &str, name: &str, help: &str, chosen: bool, child: El| {
        let hover_key = format!("hover:{}", slot.key(key));
        let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
        let b = row()
            .key(slot.key(key))
            .size(COMPOSER_BUTTON, COMPOSER_BUTTON)
            .radius(COMPOSER_BUTTON / 2.0)
            .center()
            .role("button")
            .label(name)
            .help(help)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_hover_change(crate::ui::widgets::track_hover(hover_key))
            .child(child);
        crate::ui::widgets::highlight(t, b, hovered, chosen)
    };
    let mut actions = row().gap(4.0).center_y().self_end();
    if working {
        if has_text {
            let can = !blocked;
            actions = actions.child(
                circle("queue", "Queue message", "Queue it. It sends when the agent finishes.", t.accent)
                    .disabled(!can)
                    .opacity(if can { 1.0 } else { 0.5 })
                    .on_press_tx(move |s: &mut App, tx| s.send_from(slot, tx))
                    .child(ico(&icons::ARROW_UP, 16.0, t.foreground)),
            );
        }
        let stopping = matches!(s.turn, Turn::Working { stopping: true, .. });
        actions = actions.child(
            circle("stop", "Stop the agent", "Stop the agent", action_fill)
                .disabled(stopping)
                .hover(action_hover)
                .on_press(|s: &mut App| s.stop_turn())
                .child(el().size(10.0, 10.0).radius(2.0).fill(action_ink)),
        );
    } else if has_text {
        let can = !blocked;
        let send_help = if s.prefs.enter_to_send {
            "Send (Enter). Shift Enter adds a new line."
        } else {
            "Send (⌘ Enter). Enter adds a new line."
        };
        actions = actions.child(
            action_btn("send", "Send message", send_help, false, ico(&icons::CORNER_DOWN_LEFT, 16.0, action_ink))
                .disabled(!can)
                .opacity(if can { 1.0 } else { 0.5 })
                .on_press_tx(move |s: &mut App, tx| s.send_from(slot, tx)),
        );
    }
    // Voice input shares the subdued treatment of the send control.
    let mut trailing = row().gap(4.0).center_y().self_end();
    if !working && !has_text && s.prefs.voice_input {
        trailing = trailing.child(
            action_btn("voice-affordance", "Start voice input", "Voice input (macOS dictation)", false, waveform_bars(action_ink)).on_press_tx(
                move |_s: &mut App, tx| {
                    tx.focus(&slot.key("composer-input"), false);
                    crate::dictation::start();
                },
            ),
        );
    } else {
        trailing = trailing.child(actions);
    }
    // Quick actions beside the message input.
    let plus_open = s.chat_actions && s.composer_slot == slot;
    let plus_hover_key = format!("hover:{}", slot.key("chat-actions-trigger"));
    let plus_hovered = s.row_hover.as_deref() == Some(plus_hover_key.as_str());
    let plus = action_btn(
        "chat-actions-trigger",
        "Chat actions",
        "Chat actions",
        plus_open,
        ico(
            &icons::PLUS,
            18.0,
            if plus_hovered || plus_open { t.foreground } else { t.muted_foreground },
        ),
    )
    .self_end()
    .expanded(plus_open)
    .on_press_tx(move |s: &mut App, tx| {
        s.composer_slot = slot;
        s.chat_actions = !s.chat_actions;
        if s.chat_actions {
            tx.focus("chat-action-attach", false);
        }
    });

    let field_row = row()
        .key(slot.key("composer"))
        .w_full()
        .on_layout(move |s: &mut App, rect: [f32; 4]| s.composer_widths[side as usize] = rect[2])
        .min_h(COMPOSER_BUTTON + 2.0 * COMPOSER_INSET)
        .padding(COMPOSER_INSET)
        .gap(8.0)
        .items_end()
        .radius(COMPOSER_PILL)
        .border(1.0, t.border)
        .fill(if float_on_page { Color::TRANSPARENT } else { t.card })
        // Files dropped on the box are attached, as on the web.
        .on_drop_files(|s: &mut App, paths, _tx| {
            for p in paths {
                s.attach_path(p);
            }
        })
        .child(plus)
        .child(col().grow(1.0).min_w(0.0).self_center().px(2.0).child(input))
        .child(trailing);
    let field = if float_on_page { field_row } else { shadows(field_row, &t.control_shadow) };

    // "Chat options" under the box: the business on the left; follow-ups, the
    // memory meter, the model and reasoning on the right, 12 points apart.
    let mut options = row()
        .w_full()
        .min_h(24.0)
        .px(12.0)
        .gap(16.0)
        .flex_wrap()
        .center_y()
        .child({
            // "Change the business": opens the business deck to choose what the next chat is about.
            let name = if s.general { "General chat".to_string() } else { business.to_string() };
            row()
                .key(slot.key("chat-context"))
                .gap(4.0)
                .center_y()
                .max_w(224.0)
                .min_w(0.0)
                .role("button")
                .label(format!("Change the business or client, now chatting about {name}"))
                .help(format!("Chatting about {name}"))
                .disabled(working)
                .focusable(!working)
                .cursor(if working { Cursor::Default } else { Cursor::Pointer })
                .hover_group()
                .on_press(move |s: &mut App| {
                    if !matches!(s.turn, Turn::Working { .. }) {
                        s.open_chat_picker();
                    }
                })
                .child(ico(&icons::FOLDER, 14.0, t.muted_foreground).group_color(t.foreground))
                .child(label(name, type_::XS, t.muted_foreground).group_color(t.foreground).truncate())
        })
        .child(el().grow(1.0));
    let mut right = row().gap(12.0).center_y();
    if let Some(f) = followups_trigger(s, t, slot) {
        right = right.child(f);
    }
    if let Some(m) = context_meter(s, t, slot) {
        right = right.child(m);
    }
    right = right.child(model_trigger(s, t, working, slot));
    right = right.child(reasoning_trigger(s, t, working, slot));
    options = options.child(right);

    // Feedforward: once the person pauses, what the agent will take as given,
    // to correct before sending. The reply style changes with a press.
    let ahead = if side { Vec::new() } else { s.feedforward() };
    let ahead = (!ahead.is_empty()).then(|| {
        let mut r = row().key("feedforward").w_full().px(12.0).pb(4.0).gap(6.0).flex_wrap().center_y().role("note").label("What the agent will assume").transition(Transition::opacity());
        for (j, f) in ahead.iter().enumerate() {
            let style = matches!(f, chat::Forward::Style(_));
            let mut chip = row()
                .key(format!("forward-{j}"))
                .h(24.0)
                .px(10.0)
                .gap(4.0)
                .radius(12.0)
                .center_y()
                .border(1.0, t.border)
                .child(label(f.text(), type_::XS, t.muted_foreground));
            if style {
                chip = chip
                    .role("button")
                    .label(format!("{}, press to change", f.text()))
                    .help("Change how the agent answers")
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .hover(t.hover_tint)
                    .child(ico(&icons::CHEVRON_DOWN, 12.0, t.muted_foreground))
                    .on_press(|s: &mut App| s.cycle_style());
            }
            r = r.child(chip);
        }
        r
    });

    // The web's `space-y-0.5`: queued messages, attached files, the box, then its options.
    let mut stack = col().w_full().max_w(s.prefs.chat_width.max()).gap(2.0);
    if !s.queued.is_empty() && !side {
        stack = stack.child(queued(t, &s.queued));
    }
    if !s.attachments.is_empty() {
        let mut files = row().gap(6.0).flex_wrap().mb(4.0).label("Attached files");
        for (j, a) in s.attachments.iter().enumerate() {
            files = files.child(attachment_chip(t, &format!("pending-{j}"), &a.name, a.lines(), Some(j)));
        }
        stack = stack.child(files);
    }
    if let Some(e) = &s.attach_error {
        stack = stack.child(label(e.clone(), type_::XS, t.wrong).px(12.0).wrap().live_region(LiveRegion::Polite));
    }
    stack = stack.children(ahead);
    if !side {
        if let Some(pills) = composer_pills(s, t) { stack = stack.child(pills); }
    }
    // Beside the decisions stack when it would overlap the box, the composer centres in the room left.
    col().w_full().items_center().pl(24.0).pr(24.0).pb(8.0).child(stack.child(field).child(options))
}

fn composer_pills(s: &App, t: &Theme) -> Option<El> {
    if s.general { return None; }
    let pill = |key: &str, title: String, icon: &'static rune::Icon| {
        row().key(key.to_string()).h(28.0).px(10.0).gap(6.0).radius(14.0).center_y()
            .border(1.0, t.border).fill(t.card).role("button").label(title.clone())
            .focusable(true).cursor(Cursor::Pointer).hover(t.accent)
            .child(ico(icon, 14.0, t.muted_foreground))
            .child(label(title, type_::XS, t.foreground))
    };
    let mut pills = row().key("composer-pills").w_full().gap(8.0).flex_wrap().pb(8.0);
    let mut count = 0;
    if s.brief_schedule_here() {
        count += 1;
        let title = if s.brief_schedule.saving { "Weekly brief · Saving…" } else { "Weekly brief · Turn off" };
        pills = pills.child(pill("brief-schedule-toggle", title.into(), &icons::CALENDAR_CLOCK)
            .disabled(s.brief_schedule.saving || !matches!(s.turn, Turn::Idle))
            .on_press(|s: &mut App| s.toggle_brief_schedule()));
    }
    let changes = s.chat_artifacts();
    if !changes.is_empty() {
        count += 1;
        pills = pills.child(pill("composer-changes", format!("Changes · {}", changes.len()), &icons::GIT_COMPARE)
            .on_press(|s: &mut App| s.launch(crate::side::Launch::Changes)));
    }
    (count > 0).then_some(pills)
}

/// A file attached to a message: its name and length, removable before sending.
fn attachment_chip(t: &Theme, key: &str, name: &str, lines: usize, remove: Option<usize>) -> El {
    let mut c = row()
        .key(key.to_string())
        .h(32.0)
        .max_w(256.0)
        .pl(10.0)
        .pr(if remove.is_some() { 4.0 } else { 10.0 })
        .gap(8.0)
        .center_y()
        .radius(8.0)
        .fill(t.card)
        .help(name.to_string())
        .child(ico(&icons::FILE_TEXT, 14.0, t.muted_foreground))
        .child(label(name.to_string(), type_::XS_MEDIUM.lh(16.0), t.foreground).truncate().min_w(0.0))
        .child(label(format!("{} line{}", crate::insights::int(lines as f64), if lines == 1 { "" } else { "s" }), type_::XS, t.muted_foreground));
    if let Some(j) = remove {
        c = c.child(
            row()
                .key(format!("{key}-remove"))
                .size(24.0, 24.0)
                .radius(5.0)
                .center()
                .role("button")
                .label(format!("Remove {name}"))
                .cursor(Cursor::Pointer)
                .hover(t.accent)
                .on_press(move |s: &mut App| {
                    if j < s.attachments.len() {
                        s.attachments.remove(j);
                    }
                })
                .child(ico(&icons::X, 14.0, t.muted_foreground)),
        );
    }
    shadows(c, &t.card_shadow)
}

/// The slash commands matching what's typed; pressing one sends it.

/// Messages waiting for the turn under way: each can go now (stopping the agent) or be removed.
fn queued(t: &Theme, list: &[String]) -> El {
    let mut c = col().key("queued").w_full().gap(4.0).role("list").label("Queued messages");
    for (i, m) in list.iter().enumerate() {
        c = c.child(shadows(
            row()
                .key(format!("queued-{i}"))
                .w_full()
                .min_h(36.0)
                .pl(12.0)
                .pr(4.0)
                .py(4.0)
                .gap(8.0)
                .center_y()
                .radius(10.0)
                .fill(t.card)
                .child(ico(&icons::CORNER_DOWN_RIGHT, 14.0, t.muted_foreground))
                .child(label(m.clone(), type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0))
                .child(label(if i == 0 { "Next".to_string() } else { format!("Queued {}", i + 1) }, type_::XS, t.muted_foreground))
                .child(
                    row()
                        .key(format!("queued-now-{i}"))
                        .h(28.0)
                        .px(10.0)
                        .radius(6.0)
                        .center()
                        .role("button")
                        .label("Send now")
                        .cursor(Cursor::Pointer)
                        .fill(t.accent)
                        .hover(t.hover_tint)
                        .on_press(move |s: &mut App| s.send_queued_now(i))
                        .child(label("Send now", type_::XS_MEDIUM, t.foreground)),
                )
                .child(
                    row()
                        .key(format!("queued-remove-{i}"))
                        .size(28.0, 28.0)
                        .radius(6.0)
                        .center()
                        .role("button")
                        .label("Remove queued message")
                        .cursor(Cursor::Pointer)
                        .hover(t.hover_tint)
                        .on_press(move |s: &mut App| s.unqueue(i))
                        .child(ico(&icons::X, 14.0, t.muted_foreground)),
                ),
            &t.card_shadow,
        ));
    }
    c
}

/// How full the chat's memory was on the last turn, as a small ring and percent.
fn context_meter(s: &App, t: &Theme, slot: ComposerSlot) -> Option<El> {
    let messages = s.conversation.ready()?.messages.as_slice();
    let use_ = messages.iter().rev().find_map(|m| m.context.as_ref()).filter(|c| c.budget_chars > 0)?;
    let pct = use_.percent();
    let tone = if pct >= 90 { t.partial } else { t.muted_foreground };
    let r = 6.0f32;
    let ring = |from: f32, to: f32| -> Vec<[f32; 2]> {
        let n = 48;
        (0..=n).map(|k| {
            let a = (from + (to - from) * k as f32 / n as f32) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
            [8.0 + r * a.cos(), 8.0 + r * a.sin()]
        }).collect()
    };
    let mut shape = rune::Shape::new().stroke(ring(0.0, 1.0), 2.0, t.muted_foreground.alpha(0.25));
    if pct > 0 {
        shape = shape.stroke(ring(0.0, pct as f32 / 100.0), 2.0, tone);
    }
    Some(
        row()
            .key(slot.key("context-meter"))
            .gap(4.0)
            .center_y()
            .role("img")
            .label(format!("Chat memory {pct}% full"))
            .help(use_.note())
            .focusable(true)
            .child(rune::canvas(shape).size(16.0, 16.0))
            .child(label(format!("{pct}%"), type_::XS.features("'tnum' 1"), tone)),
    )
}

/// Says which model runs in place of the picked one, while that one is unavailable.
fn stand_in_note(s: &App) -> Option<String> {
    let stand_in = s.model_stand_in()?;
    let picked = s.agent_model.as_deref()?;
    let picked = picked.split_once(':').map_or(picked, |(_, m)| m);
    Some(format!("{picked} isn't available right now, so the agent uses {} instead. It goes back to {picked} once that works again.", stand_in.name))
}

/// The composer's model button: the chosen model's logo and name.
fn model_trigger(s: &App, t: &Theme, locked: bool, slot: ComposerSlot) -> El {
    let chosen = s.chosen_model();
    let name = match (&s.catalog, chosen) {
        (_, Some(o)) if !s.model_unavailable() => o.name.clone(),
        (_, _) if s.model_unavailable() => "Model unavailable".into(),
        (Load::Loading | Load::Idle, _) => "Checking providers…".into(),
        _ => "Choose a model".into(),
    };
    let mut r = row()
        .key(slot.key("model-picker"))
        .gap(4.0)
        .center_y()
        .max_w(224.0)
        .role("button")
        .label("Agent model")
        .disabled(locked)
        .focusable(true)
        .cursor(if locked { Cursor::Default } else { Cursor::Pointer })
        .opacity(if locked { 0.5 } else { 1.0 })
        .hover_group()
        .on_press(move |s: &mut App| {
            if !matches!(s.turn, Turn::Working { .. }) {
                s.composer_slot = slot;
                s.open_model_menu();
            }
        });
    if let Some(note) = stand_in_note(s) {
        r = r.help(note);
    }
    if let Some(o) = chosen.filter(|_| !s.model_unavailable()) {
        r = r.child(brands::mark(t, &o.brand, 16.0));
    }
    let ink = if s.model_unavailable() { t.wrong } else { t.muted_foreground };
    r.child(label(name, type_::XS, ink).group_color(if s.model_unavailable() { t.wrong } else { t.foreground }).truncate()).child(ico(&icons::CHEVRON_DOWN, 14.0, t.muted_foreground).group_color(t.foreground))
}

/// The reasoning effort for the next reply, beside the model, when the model reports any.
fn reasoning_trigger(s: &App, t: &Theme, locked: bool, slot: ComposerSlot) -> El {
    // Always shown, as on the web; disabled while the model reports no reasoning controls.
    let none = s.chosen_model().filter(|_| !s.model_unavailable()).is_none_or(|m| m.efforts.is_empty());
    let locked = locked || none;
    let name = s.reasoning_effort().map(chat::effort_label).unwrap_or_else(|| "Reasoning".into());
    row()
        .key(slot.key("reasoning-picker"))
        .gap(4.0)
        .center_y()
        .role("button")
        .label("Reasoning effort")
        .help(if none { "This provider hasn't reported reasoning controls for this model." } else { "Reasoning effort for the next reply" })
        .disabled(locked)
        .focusable(!locked)
        .cursor(if locked { Cursor::Default } else { Cursor::Pointer })
        .hover_group()
        .on_press(move |s: &mut App| {
            if !locked && !matches!(s.turn, Turn::Working { .. }) {
                s.composer_slot = slot;
                s.menu = Some(crate::state::Menu::Reasoning);
            }
        })
        .child(label(name, type_::XS, t.muted_foreground).group_color(if locked { t.muted_foreground } else { t.foreground }))
        .child(ico(&icons::CHEVRON_DOWN, 16.0, t.muted_foreground).group_color(if locked { t.muted_foreground } else { t.foreground }))
}

/// Default and the efforts the model offers, each a 40-point row as the web's select draws them.
pub fn reasoning_menu(s: &App, t: &Theme) -> El {
    let efforts = s.chosen_model().map(|m| m.efforts.clone()).unwrap_or_default();
    let current = s.reasoning_effort().map(str::to_string);
    let mut m = shadows(col().key("reasoning-menu").w(176.0).padding(4.0).gap(1.0).radius(12.0).fill(t.popover), &t.float_shadow).focus_group().role("listbox").label("Reasoning effort");
    let row_ = |key: String, name: String, on: bool, effort: Option<String>| {
        let hk = format!("effort:{key}");
        let r = row()
            .key(key)
            .w_full()
            .h(40.0)
            .px(12.0)
            .radius(8.0)
            .center_y()
            .role("option")
            .label(name.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_hover_change(hover_key(hk.clone()))
            .focus_highlight(t.accent)
            .on_press(move |s: &mut App| s.choose_reasoning(effort.clone()))
            .child(label(name, type_::SM, t.foreground).grow(1.0))
            .children(on.then(|| ico(&icons::CHECK, 14.0, secondary(t))));
        let r = if on { r.autofocus() } else { r };
        let hovered = s.row_hover.as_deref() == Some(hk.as_str());
        crate::ui::widgets::highlight(t, r, hovered, false)
    };
    m = m.child(row_("effort-default".into(), "Default".into(), current.is_none(), None));
    for e in efforts {
        m = m.child(row_(format!("effort-{e}"), chat::effort_label(&e), current.as_deref() == Some(e.as_str()), Some(e.clone())));
    }
    m.anchored(s.composer_slot.key("reasoning-picker"), Side::Top, Align::End, 8.0).modal(true, |s: &mut App| s.menu = None)
}

/// Remembers which menu row the pointer is over, so its highlight eases in and out.
fn hover_key(key: String) -> impl Fn(&mut App, bool, &mut rune::Tx) + 'static {
    move |s: &mut App, inside, _tx| {
        if inside {
            s.row_hover = Some(key.clone());
        } else if s.row_hover.as_deref() == Some(key.as_str()) {
            s.row_hover = None;
        }
    }
}

/// The model picker, opened over the composer: provider logos to filter by,
/// then each model with its logo and the connection it runs on.
pub fn model_menu(s: &App, t: &Theme) -> El {
    let options = s.catalog.ready().cloned().unwrap_or_default();
    let chosen = s.chosen_model().map(|o| o.value.clone());
    let mut providers: Vec<String> = Vec::new();
    for o in &options {
        if !providers.contains(&o.provider) {
            providers.push(o.provider.clone());
        }
    }
    let filter = s.model_filter.clone().filter(|f| providers.contains(f));
    let query = s.model_query.as_ref().map(|q| q.text.trim().to_lowercase()).unwrap_or_default();

    // The providers as bare logos, or the search field in their place.
    let mut tabs = row().w_full().h(32.0).gap(2.0).center_y().role("group").label("Model providers");
    match &s.model_query {
        Some(q) => {
            tabs = tabs.child(ico(&icons::SEARCH, 14.0, t.muted_foreground).ml(8.0)).child(
                text_input(q, type_::SM)
                    .key("model-search")
                    .placeholder("Search models…", t.muted_foreground)
                    .label("Search models")
                    .grow(1.0)
                    .min_w(0.0)
                    .color(t.foreground)
                    .on_edit(|s: &mut App| s.model_query.get_or_insert_with(|| rune::TextEdit::new(""))),
            );
        }
        None => {
            for p in &providers {
                let on = filter.as_deref() == Some(p.as_str());
                let logo = if p == "hosted" { options.iter().find(|o| o.provider == "hosted").map(|o| o.brand.clone()).unwrap_or_else(|| "gemini".into()) } else if p == "claude" { "claude-code".into() } else { p.clone() };
                let key = p.clone();
                tabs = tabs.child(
                    row()
                        .key(format!("provider-{p}"))
                        .size(32.0, 32.0)
                        .radius(6.0)
                        .center()
                        .role("button")
                        .label(chat::driver_name(p))
                        .help(chat::driver_name(p))
                        .checked(on)
                        .focusable(true)
                        .cursor(Cursor::Pointer)
                        .opacity(if on { 1.0 } else { 0.5 })
                        .hover(t.hover_tint)
                        .on_press(move |s: &mut App| s.model_filter = if s.model_filter.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) })
                        .child(brands::mark(t, &logo, 18.0)),
                );
            }
            tabs = tabs.child(el().grow(1.0));
        }
    }
    let searching = s.model_query.is_some();
    tabs = tabs.child(
        row()
            .key("model-search-toggle")
            .size(28.0, 28.0)
            .radius(6.0)
            .center()
            .role("button")
            .label(if searching { "Close search" } else { "Search models" })
            .help(if searching { "Close search" } else { "Search models" })
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press_tx(move |s: &mut App, tx| {
                if s.model_query.take().is_none() {
                    s.model_query = Some(rune::TextEdit::new(""));
                    tx.focus("model-search", false);
                }
            })
            .child(ico(if searching { &icons::X } else { &icons::SEARCH }, 14.0, t.muted_foreground)),
    );

    // One line per model, the computer it runs on after its name; the list scrolls past eight.
    let visible: Vec<_> = options
        .iter()
        .filter(|o| searching || filter.as_deref().is_none_or(|f| f == o.provider))
        .filter(|o| query.is_empty() || o.name.to_lowercase().contains(&query) || o.instance.as_deref().is_some_and(|i| i.to_lowercase().contains(&query)))
        .collect();
    let mut list = col().w_full().gap(1.0).focus_group().role("listbox").label("Models");
    for o in &visible {
        let on = chosen.as_deref() == Some(o.value.as_str());
        let value = o.value.clone();
        let mut r = row()
            .key(format!("model-{}", o.value))
            .w_full()
            .px(8.0)
            .py(8.0)
            .gap(8.0)
            .center_y()
            .radius(6.0)
            .role("option")
            .label(o.name.clone())
            .checked(on)
            .focusable(true)
            .autofocus_if(on)
            .focus_highlight(t.accent)
            .cursor(Cursor::Pointer)
            .on_hover_change(hover_key(format!("model:{}", o.value)))
            .on_press(move |s: &mut App| s.choose_agent_model(value.clone()))
            .child(brands::mark(t, &o.brand, 16.0))
            // The web's row: the model's name, and the computer it runs on under it.
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .child(label(o.name.clone(), type_::SM, t.foreground).truncate())
                    .children(o.instance.clone().map(|i| label(i, type_::XS, t.muted_foreground).truncate())),
            );
        if on {
            r = r.child(ico(&icons::CHECK, 16.0, secondary(t)));
        }
        let hovered = s.row_hover.as_deref() == Some(format!("model:{}", o.value).as_str());
        list = list.child(crate::ui::widgets::highlight(t, r, hovered, on));
    }
    // The web's `max-h-64` list, inset 4 points, 6 above and below.
    let list = col().key("model-list").w_full().max_h(256.0).mt(4.0).px(4.0).py(6.0).child(list).scroll(ScrollSpec { stick_bottom: false });
    let status = match &s.catalog {
        Load::Loading | Load::Idle if options.is_empty() => Some("Checking providers…".to_string()),
        Load::Failed(e) => Some(format!("Providers could not load. {e}")),
        _ if options.is_empty() => Some("No agent model is ready. Connect a provider in Settings.".into()),
        _ if visible.is_empty() => Some("No model matches.".into()),
        _ => None,
    };
    let manage = label("Manage providers…", type_::SM_13, t.foreground)
        .key("manage-providers")
        .w_full()
        .h(32.0)
        .px(8.0)
        .radius(6.0)
        .center_y()
        .role("button")
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .on_press(|s: &mut App| s.open_settings(crate::state::SettingsPage::Agent));
    // The web's picker: 21rem wide, 8 points in, a hairline border; in dark mode
    // the lighter #303030 surface with a #414141 border, so rows hover darker.
    let (surface, rim) = if t.dark { (crate::theme::hex("#303030"), crate::theme::hex("#414141")) } else { (t.popover, t.border) };
    let mut m = shadows(col().key("model-menu").w(336.0).padding(8.0).radius(12.0).fill(surface).border(1.0, rim), &t.float_shadow).child(tabs).child(list);
    if let Some(st) = status {
        m = m.child(label(st, type_::XS, t.muted_foreground).px(8.0).py(12.0).wrap());
    }
    if s.model_unavailable() {
        m = m.child(label("No model is available right now. Connect one under Manage.", type_::XS, t.wrong).px(8.0).py(8.0).wrap());
    } else if let Some(note) = stand_in_note(s) {
        m = m.child(label(note, type_::XS, t.muted_foreground).px(8.0).py(8.0).wrap());
    }
    m.child(el().w_full().h(1.0).mt(6.0).mb(4.0).fill(t.border))
        .child(manage)
        .role("dialog")
        .label("Choose an agent model")
        .anchored(s.composer_slot.key("model-picker"), Side::Top, Align::End, 8.0)
        .modal(true, |s: &mut App| s.menu = None)
}

/// The composer's "/" menu (`role="listbox" aria-label="Commands"` in
/// `agent-chat.tsx`): commands, then playbooks, by name only, 28-point rows in
/// small medium-weight text; the highlighted row (arrows or pointer) takes the
/// accent fill and the control shadow.
fn command_menu(s: &App, t: &Theme) -> Option<El> {
    let entries = s.menu_entries();
    if entries.is_empty() {
        return None;
    }
    let active = s.command_index.min(entries.len() - 1);
    let width = s.composer_widths[0].max(1.0);
    let mut items = col().key("command-menu-list").w_full().min_h(0.0);
    for (i, e) in entries.iter().enumerate() {
        let on = i == active;
        let id = e.id();
        let r = crate::ui::widgets::highlight(
            t,
            row()
                .key(format!("command-{id}"))
                .w_full()
                .h(36.0)
                .px(10.0)
                .radius(6.0)
                .center_y()
                .role("option")
                .label(e.name().to_string())
                .checked(on)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .on_hover_change(move |s: &mut App, inside, _tx| {
                    if inside {
                        s.command_index = i;
                    }
                })
                .on_press_tx(move |s: &mut App, tx| s.choose_entry(&id, tx))
                .child(label(e.name().to_string(), type_::XS_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0)),
            on,
            false,
        );
        items = items.child(r);
    }
    let menu = col()
        .key("command-menu")
        .w(width)
        .min_h(0.0)
        .padding(4.0)
        .radius(10.0)
        .fill(t.popover)
        .border(1.0, t.border)
        .role("listbox")
        .label("Commands")
        .focus_group()
        .child(items.max_h(332.0).min_h(0.0).shrink().scroll(ScrollSpec { stick_bottom: false }))
        .anchored_fit("composer", Side::Top, Align::Start, 12.0);
    Some(shadows(menu, &t.control_shadow))
}

/// "Start a new chat" (`new-chat-dialog.tsx`): a search, "Start without a
/// business", then the businesses and client records, each listed once.
pub fn new_chat_dialog(s: &App, t: &Theme, k: &Kit, n: &crate::state::NewChat, layer: &mut Vec<El>) {
    let search = crate::ui::widgets::field_input(&n.query, type_::SM, t)
        .key("new-chat-search")
        .placeholder("Search businesses", t.muted_foreground)
        .label("Search businesses")
        .w_full()
        .on_edit(|s: &mut App| &mut s.new_chat.as_mut().expect("dialog open").query);
    // The "/" menu's surface: popover fill and border, with its accent highlight under the pointer.
    let field_hovered = s.row_hover.as_deref() == Some("new:search");
    let field = shadows(
        crate::ui::widgets::highlight(
            t,
            row().key("new-chat-field").w_full().h(44.0).px(12.0).gap(10.0).radius(10.0).center_y().border(1.0, t.border)
                .on_hover_change(hover_key("new:search".into()))
                .child(ico(&icons::SEARCH, 16.0, t.muted_foreground)).child(col().grow(1.0).min_w(0.0).child(search)),
            field_hovered,
            false,
        ).fill(if field_hovered { t.accent } else { t.card }),
        &t.float_shadow,
    );
    let hover = |key: String, r: El| {
        let hovered = s.row_hover.as_deref() == Some(key.as_str());
        crate::ui::widgets::highlight(t, r.on_hover_change(hover_key(key)), hovered, false)
    };
    let general = hover(
        "new:general".into(),
        row()
            .key("new-chat-general")
            .w_full()
            .px(12.0)
            .py(12.0)
            .gap(12.0)
            .radius(8.0)
            .center_y()
            .role("button")
            .label("Start without a business")
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_press(|s: &mut App| s.start_chat(None))
            .child(ico(&icons::MESSAGES_SQUARE, 20.0, t.muted_foreground))
            .child(col().child(label("Start without a business", type_::SM_MEDIUM, t.foreground)).child(label("A general chat, without business context", type_::SM_13, t.muted_foreground))),
    );
    // A client record is the same business seen from the agency side: listed once, by its own name.
    let q = n.query.text.trim().to_lowercase();
    let body = match &n.clients {
        Load::Ready(clients) => {
            let ids: std::collections::HashSet<&str> = clients.iter().map(|c| c.0.as_str()).collect();
            let targets: Vec<(String, String)> = s
                .businesses
                .iter()
                .filter(|b| !ids.contains(b.id.as_str()))
                .map(|b| (b.id.clone(), b.name.clone()))
                .chain(clients.iter().cloned())
                .filter(|(_, name)| name.to_lowercase().contains(&q))
                .collect();
            if targets.is_empty() {
                label(if q.is_empty() { "No businesses yet. You can start a general chat." } else { "No matching businesses." }, type_::SM, t.muted_foreground).px(8.0).py(16.0)
            } else {
                let mut list = col().w_full().py(4.0).label("Businesses").child(label("Businesses", type_::SM_13, t.muted_foreground).px(12.0).py(6.0));
                for (id, name) in targets {
                    let pick = id.clone();
                    list = list.child(hover(
                        format!("new:{id}"),
                        row()
                            .key(format!("new-chat-{id}"))
                            .w_full()
                            .px(12.0)
                            .py(10.0)
                            .gap(12.0)
                            .radius(8.0)
                            .center_y()
                            .role("button")
                            .label(name.clone())
                            .focusable(true)
                            .cursor(Cursor::Pointer)
                            .on_press(move |s: &mut App| s.start_chat(Some(pick.clone())))
                            .child(ico(&icons::BUILDING, 16.0, t.muted_foreground))
                            .child(label(name, type_::SM, t.foreground).truncate()),
                    ));
                }
                list
            }
        }
        Load::Failed(_) => row()
            .px(8.0)
            .py(16.0)
            .gap(4.0)
            .child(label("Couldn't load your businesses.", type_::SM, t.foreground))
            .child(label("Try again", type_::SM, t.foreground).role("button").cursor(Cursor::Pointer).on_press_tx(|s: &mut App, tx| s.open_new_chat(tx))),
        _ => label("Loading workspaces…", type_::SM, t.muted_foreground).px(8.0).py(16.0),
    };
    let footer_link = |key: &str, name: &str, press: fn(&mut App)| {
        let hk = format!("new:{key}");
        let hovered = s.row_hover.as_deref() == Some(hk.as_str());
        crate::ui::widgets::highlight(
            t,
            row()
                .key(key)
                .h(32.0)
                .px(10.0)
                .radius(6.0)
                .center_y()
                .role("link")
                .label(name)
                .cursor(Cursor::Pointer)
                .on_hover_change(hover_key(hk))
                .on_press(press)
                .child(label(name, type_::XS, if hovered { t.foreground } else { t.muted_foreground })),
            hovered,
            false,
        )
    };
    let footer = row()
        .w_full()
        .px(16.0)
        .py(8.0)
        .gap(8.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(footer_link("manage-businesses", "Manage businesses", |s: &mut App| {
            s.new_chat = None;
            s.show_page(crate::state::Page::Businesses);
        }))
        .child(el().grow(1.0))
        .child(footer_link("add-business", "Add a business", |s: &mut App| s.open_add_business(None)));
    let list = col()
        .w_full()
        .radius(10.0)
        .fill(t.popover)
        .border(1.0, t.border)
        .clip_rounded(10.0)
        .child(col().w_full().px(4.0).pt(4.0).child(general))
        .child(col().key("new-chat-list").w_full().max_h(360.0).px(4.0).py(4.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border).child(body).scroll(ScrollSpec { stick_bottom: false }))
        .child(footer);
    let close = |s: &mut App| s.new_chat = None;
    let panel = col()
        .key("new-chat-dialog")
        .role("dialog")
        .label("Start a new chat")
        .w_full()
        .max_w(672.0)
        .gap(6.0)
        .child(field)
        .child(shadows(list, &t.float_shadow))
        .token_motion(k.motion.overlay)
        .modal(true, close)
        .modal_click_outside(true);
    layer.push(col().key("new-chat-layer").absolute(0.0, 0.0).w_full().h_full().pt(96.0).px(12.0).items_center().child(panel));
}

// ---- Overlays: the "/" menu, the "+" menu and their dialogs ---------------------

/// What the agent view floats over the window, built with Rune's kit: the "/"
/// menu as a `PopupList` above the composer, the "+" menu, and its dialogs.
/// Whether the composer's "/" menu is showing: it floats over the chat
/// without blurring it, since the composer it belongs to stays in use.
pub fn command_menu_open(s: &App) -> bool {
    s.view == View::Agent && !s.chat_actions && !s.menu_entries().is_empty()
}

pub fn layers(s: &App, t: &Theme, k: &Kit, layer: &mut Vec<El>) {
    if s.view == View::Agent && !s.chat_actions {
        if let Some(menu) = command_menu(s, t) { layer.push(menu); }
    }
    if s.chat_actions {
        layer.push(chat_actions_menu(s, t));
    }
    if let Some(f) = &s.save_playbook {
        save_playbook_dialog(s, t, k, f, layer);
    }
    if let Some(sh) = &s.share {
        share_dialog(t, k, sh, layer);
    }
    if s.followups_open {
        followups_dialog(s, t, k, layer);
    }
}

/// Quick actions aligned with the message box.
fn chat_actions_menu(s: &App, t: &Theme) -> El {
    let item = |key: &str, name: &str, icon: &'static rune::Icon| {
        let hovered = s.row_hover.as_deref() == Some(key);
        let r = row().key(key.to_string()).w_full().h(36.0).px(10.0).gap(10.0).center_y().radius(6.0)
            .role("menuitem").label(name.to_string()).focusable(true).cursor(Cursor::Pointer)
            .on_hover_change(super::widgets::track_hover(key.to_string()))
            .child(ico(icon, 16.0, t.foreground))
            .child(label(name, type_::XS_MEDIUM, t.foreground).grow(1.0).min_w(0.0).truncate());
        super::widgets::highlight(t, r, hovered, false)
    };
    let width = s.composer_widths[(s.composer_slot == ComposerSlot::Side) as usize];
    let mut menu = col().key("chat-actions-menu").w(width.max(1.0)).min_h(0.0).padding(4.0)
        .radius(10.0).fill(t.popover).border(1.0, t.border).role("menu").label("Chat actions").focus_group()
        .child(item("chat-action-attach", "Attach", &icons::PAPERCLIP)
            .on_press_tx(|s: &mut App, tx| s.attach(tx)))
        .child(item("chat-action-connect", "Connect", &icons::NAV_CHANNELS)
            .on_press(|s: &mut App| s.open_channel_connections()))
        .child(item("chat-action-plan", "Plan", &icons::TARGET)
            .on_press_tx(|s: &mut App, tx| {
                s.prepare_composer_command("plan");
                tx.focus(&s.composer_slot.key("composer-input"), false);
            }));
    if !s.general && s.active.is_some() {
        let title = if s.brief_schedule.saving { "Saving weekly brief…" }
            else if s.brief_schedule_here() { "Turn off weekly brief" } else { "Weekly brief" };
        menu = menu.child(item("chat-action-weekly-brief", title, &icons::CALENDAR_CLOCK)
            .help(s.brief_schedule.error.clone().unwrap_or_else(|| if s.brief_schedule_here() { "Turn off weekly briefs for this session".into() } else { "Enable weekly briefs in this session".into() }))
            .disabled(s.brief_schedule.saving || !matches!(s.turn, Turn::Idle) || matches!(s.brief_schedule.value, Load::Loading))
            .on_press(|s: &mut App| s.toggle_brief_schedule()));
    }
    let menu = menu
        .anchored_fit(s.composer_slot.key("composer"), Side::Top, Align::Start, 12.0)
        .focus_return(s.composer_slot.key("chat-actions-trigger"))
        .modal(true, |s: &mut App| s.chat_actions = false);
    shadows(menu, &t.control_shadow)
}

/// "Follow-ups", "Follow-ups on" or "Follow-ups elsewhere", by the model picker.
/// Only on a person's own chat, not a helper session.
fn followups_trigger(s: &App, t: &Theme, slot: ComposerSlot) -> Option<El> {
    if s.general {
        return None;
    }
    let chat = s.chat_id.as_deref()?;
    let conv = s.conversation.ready().filter(|c| c.id == chat)?;
    if conv.session.as_ref().is_some_and(|i| i.parent_session_id.is_some()) {
        return None;
    }
    let state = match s.followups.ready().map(|f| f.location(chat)) {
        Some(crate::followups::Location::Here) => " on",
        Some(crate::followups::Location::Elsewhere) => " elsewhere",
        _ => "",
    };
    Some(
        row()
            .key(slot.key("followups-trigger"))
            .gap(5.0)
            .center_y()
            .role("button")
            .label("Manage automatic follow-ups")
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_press(|s: &mut App| s.open_followups())
            .hover_group()
            .child(ico(&icons::CALENDAR_CLOCK, 14.0, t.muted_foreground).group_color(t.foreground))
            .child(label(format!("Follow-ups{state}"), type_::XS, t.muted_foreground).group_color(t.foreground)),
    )
}

fn followups_dialog(s: &App, t: &Theme, k: &Kit, layer: &mut Vec<El>) {
    use crate::followups::{Location, Policy};
    use crate::ui::widgets::{Variant, button};
    let chat = s.chat_id.clone().unwrap_or_default();
    let busy = s.followup_saving;
    let chat_busy = matches!(s.turn, Turn::Working { .. });
    let mut body = col().w_full().px(16.0).pb(16.0).gap(14.0).child(
        label("Let the agent revisit saved investigations when a time or proposal decision is ready. This applies to your follow-ups for this business.", type_::SM_13, t.muted_foreground).wrap(),
    );
    let refresh = button(t, "followups-refresh", "Refresh status", Variant::Outline).on_press(|s: &mut App| {
        s.followup_error = None;
        s.refresh_followups();
    });
    match &s.followups {
        Load::Ready(f) => {
            let at = f.location(&chat);
            let mut status = col().w_full().gap(6.0).child(label(
                match at {
                    Location::Off => "Paused",
                    _ if f.automatic() => "On for this business",
                    Location::Here => "Enabled in this chat",
                    Location::Elsewhere => "Enabled in another chat",
                },
                type_::SM_MEDIUM,
                t.foreground,
            ));
            if let Policy::Configured { enabled: true, provider, model, conversation_id, .. } = &f.policy {
                status = if f.automatic() {
                    status.child(label("Turned on by OpenRecord. Each review uses whichever model is working at the time.", type_::SM_13, t.muted_foreground).wrap())
                } else {
                    status.child(row().gap(8.0).center_y().child(brands::mark(t, &crate::brands::model_brand(model, provider), 16.0)).child(label(model.clone(), type_::SM_13, t.muted_foreground)))
                };
                if at == Location::Elsewhere {
                    let id = conversation_id.clone();
                    status = status.child(label("Open the follow-up chat", type_::SM_13, t.foreground).key("followups-open-chat").role("link").cursor(Cursor::Pointer).on_press(move |s: &mut App| {
                        s.followups_open = false;
                        s.open_session(&id);
                    }));
                }
            }
            let l = &f.limits;
            status = status
                .child(label(format!("At most {} review every 24 hours, with {} model steps, {} stored-record reads and a {}-minute limit.", l.wake_ups_per24_hours, l.model_steps, l.tool_calls, l.timeout_seconds / 60), type_::SM_13, t.muted_foreground).wrap())
                .child(label(if f.automatic() {
                    "Read-only. No publishing, ad-budget changes, contacting customers or starting other agents."
                } else {
                    "Read-only. No publishing, ad-budget changes, contacting customers or starting other agents. No provider fallback. The server and selected provider must be available."
                }, type_::SM_13, t.muted_foreground).wrap());
            body = body.child(status);
            if let Some(e) = &s.followup_error {
                body = body.child(label(e.clone(), type_::SM_13, t.wrong).wrap().live_region(LiveRegion::Polite));
            }
            let model = s.followup_model();
            let rule = |c: El| c.pt(14.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border);
            if let Some(m) = &s.followup_confirm {
                let ok = !busy && !chat_busy;
                let allow = button(t, "followups-allow", if busy { "Allowing…" } else { "Allow follow-ups" }, Variant::Primary);
                body = body.child(rule(
                    col()
                        .w_full()
                        .gap(10.0)
                        .child(label(format!("Allow automatic reviews using {}?", m.label), type_::SM_MEDIUM, t.foreground).wrap())
                        .child(label(format!("Updates will be saved in this chat. {}You can pause them at any time.", if at == Location::Elsewhere { "This moves follow-ups from the other chat. " } else { "" }), type_::SM_13, t.muted_foreground).wrap())
                        .child(
                            row()
                                .w_full()
                                .gap(8.0)
                                .child(el().grow(1.0))
                                .child(button(t, "followups-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.followup_confirm = None))
                                .child(if ok { allow.on_press(|s: &mut App| s.allow_followups()) } else { allow.opacity(0.5).cursor(Cursor::Default) }),
                        ),
                ));
            } else {
                let mut bar = row().w_full().gap(8.0).center_y().child(refresh).child(el().grow(1.0));
                if matches!(f.policy, Policy::Configured { enabled: true, .. }) {
                    let pause = button(t, "followups-pause", if busy { "Pausing…" } else { "Pause follow-ups" }, Variant::Outline);
                    bar = bar.child(if busy { pause.opacity(0.5) } else { pause.on_press(|s: &mut App| s.pause_followups()) });
                }
                if at != Location::Here || model.as_ref().is_some_and(|m| !f.matches(m)) {
                    let name = match at {
                        Location::Elsewhere => "Move here",
                        Location::Here => "Change model",
                        Location::Off => "Enable follow-ups",
                    };
                    let ok = !busy && !chat_busy && model.is_some();
                    let b = button(t, "followups-enable", name, Variant::Primary);
                    bar = bar.child(if ok { b.on_press(|s: &mut App| s.confirm_followups()) } else { b.opacity(0.5).cursor(Cursor::Default) });
                }
                body = body.child(rule(bar));
                if model.is_none() && at != Location::Here {
                    body = body.child(label("Choose an available model in the composer to enable follow-ups.", type_::XS, t.muted_foreground).wrap());
                }
            }
            let mut reviews = col().w_full().gap(8.0).child(label("Recent reviews", type_::SM_MEDIUM, t.foreground));
            if f.wakes.is_empty() {
                reviews = reviews.child(label("No automatic reviews yet. Saving a waiting condition does not mean a review has run.", type_::SM_13, t.muted_foreground).wrap());
            }
            for w in &f.wakes {
                let id = w.conversation_id.clone();
                reviews = reviews.child(
                    row()
                        .key(format!("wake-{}", w.id))
                        .w_full()
                        .gap(8.0)
                        .items_start()
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .child(label(crate::followups::status_label(&w.status), type_::SM_13, t.foreground))
                                .child(label(w.started_at.as_deref().map(crate::format::date_time).unwrap_or_default(), type_::XS, t.muted_foreground)),
                        )
                        .child(label("Open chat", type_::XS_MEDIUM, t.foreground).role("link").cursor(Cursor::Pointer).on_press(move |s: &mut App| {
                            s.followups_open = false;
                            s.open_session(&id);
                        })),
                );
            }
            if f.wakes.iter().any(|w| w.status == "FAILED" || w.status == "INTERRUPTED") {
                reviews = reviews.child(label("Uncertain attempts aren't automatically retried. Open the chat to review what was saved before continuing manually.", type_::XS, t.muted_foreground).wrap());
            }
            body = body.child(rule(reviews));
        }
        Load::Failed(e) => {
            body = body.child(label(e.clone(), type_::SM_13, t.muted_foreground).wrap()).child(row().child(refresh));
        }
        _ => body = body.child(label("Loading follow-up settings…", type_::SM_13, t.muted_foreground)),
    }
    Dialog::new("followups", "Automatic follow-ups")
        .description("The agent can check back on its own.")
        .width(460.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|s: &mut App| {
            s.followups_open = false;
            s.followup_confirm = None;
        })
        .build(k, layer);
}

fn field(t: &Theme, input: El, h: f32) -> El {
    shadows(row().w_full().min_h(h).px(10.0).py(8.0).radius(8.0).items_start().fill(t.control).child(input), &t.control_shadow)
}

fn save_playbook_dialog(s: &App, t: &Theme, k: &Kit, f: &crate::state::SavePlaybook, layer: &mut Vec<El>) {
    let title = text_input(&f.title, type_::SM)
        .key("playbook-title")
        .placeholder("Title, for example Monthly SEO report", t.muted_foreground)
        .label("Playbook title")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.save_playbook.as_mut().expect("dialog open").title);
    let slug = chat::slug(&f.title.text);
    let name = text_input(&f.name, type_::SM.mono())
        .key("playbook-name")
        .placeholder(if slug.is_empty() { "command".to_string() } else { slug }, t.muted_foreground)
        .label("Command")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.save_playbook.as_mut().expect("dialog open").name);
    let prompt = text_input(&f.prompt, type_::SM)
        .key("playbook-prompt")
        .label("Playbook prompt")
        .w_full()
        .max_h(160.0)
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.save_playbook.as_mut().expect("dialog open").prompt)
        .on_submit(|s: &mut App, _| {
            if let Some(f) = &mut s.save_playbook {
                f.prompt.insert("\n");
            }
        });
    let ready = !f.busy && !f.prompt.text.trim().is_empty() && !f.command().is_empty();
    let save = crate::ui::widgets::button(t, "playbook-save", if f.busy { "Saving…" } else { "Save playbook" }, crate::ui::widgets::Variant::Primary);
    let save = if ready { save.on_press(|s: &mut App| s.submit_playbook()) } else { save.opacity(0.5).cursor(Cursor::Default) };
    let mut body = col()
        .w_full()
        .px(16.0)
        .pb(16.0)
        .gap(10.0)
        .child(label("Type the command in any business's chat to reuse it. {business} in the prompt becomes that business's name.", type_::SM_13, t.muted_foreground).wrap())
        .child(row().w_full().gap(8.0).center_y().child(field(t, title, 36.0).grow(1.0).min_w(0.0)).child(label("/", type_::SM, t.muted_foreground)).child(field(t, name, 36.0).w(230.0)))
        .child(field(t, prompt, 120.0));
    if let Some(e) = &f.error {
        body = body.child(label(e.clone(), type_::XS, t.wrong).wrap().live_region(LiveRegion::Polite));
    }
    body = body.child(row().w_full().child(el().grow(1.0)).child(save));
    let own: Vec<_> = s.playbooks.iter().filter(|p| !p.built_in).collect();
    if !own.is_empty() {
        let mut list = col().w_full().gap(2.0).pt(10.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border).child(label("Your playbooks", type_::XS_MEDIUM, t.foreground));
        for p in own {
            let n = p.name.clone();
            list = list.child(
                row()
                    .key(format!("own-{}", p.name))
                    .w_full()
                    .h(28.0)
                    .gap(8.0)
                    .center_y()
                    .child(label(format!("/{}", p.name), type_::XS.mono(), t.foreground))
                    .child(label(p.title.clone(), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                    .child(label("Delete", type_::XS_MEDIUM, t.muted_foreground).key(format!("delete-{}", p.name)).role("button").cursor(Cursor::Pointer).on_press(move |s: &mut App| s.delete_playbook(&n))),
            );
        }
        body = body.child(list);
    }
    Dialog::new("save-playbook", "Save as playbook")
        .description("Reuse this request in any business by its command.")
        .width(520.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|s: &mut App| s.save_playbook = None)
        .build(k, layer);
}

fn share_dialog(t: &Theme, k: &Kit, sh: &crate::state::ShareChat, layer: &mut Vec<El>) {
    let mut body = col().w_full().px(16.0).pb(16.0).gap(12.0).child(
        label("Anyone with the link can read this conversation, including messages added later: your messages, the agent's replies and their sources. They can't reply, and never see the agent's reasoning, tool details or the contents of attached files.", type_::SM_13, t.muted_foreground).wrap(),
    );
    if let Some(link) = &sh.link {
        let l = link.clone();
        body = body.child(
            col()
                .w_full()
                .gap(4.0)
                .padding(8.0)
                .radius(8.0)
                .border(1.0, t.border)
                .border_dash(4.0, 3.0)
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(label(link.clone(), type_::XS.mono(), t.foreground).truncate().grow(1.0).min_w(0.0).selectable(true))
                        .child(label("Copy", type_::XS_MEDIUM, t.foreground).key("share-copy").role("button").cursor(Cursor::Pointer).on_press_tx(move |s: &mut App, tx| {
                            tx.copy(l.clone());
                            s.notice = Some("Link copied".into());
                        })),
                )
                .child(label("Shown once. Revoke it below at any time.", type_::XS, t.muted_foreground)),
        );
    }
    let create = crate::ui::widgets::button(t, "share-create", if sh.busy { "Creating…" } else { "Create a link" }, crate::ui::widgets::Variant::Primary);
    body = body.child(row().child(if sh.busy { create.opacity(0.5) } else { create.on_press(|s: &mut App| s.create_share()) }));
    if let Some(e) = &sh.error {
        body = body.child(label(e.clone(), type_::XS, t.wrong).wrap());
    }
    match &sh.shares {
        Load::Ready(list) => {
            let active: Vec<_> = list.iter().filter(|x| x.active).collect();
            let mut c = col().w_full().border_sides([1.0, 0.0, 0.0, 0.0], t.border);
            if active.is_empty() {
                c = c.child(label("No active links.", type_::XS, t.muted_foreground).pt(10.0));
            }
            for x in active {
                let id = x.id.clone();
                let expires = x.expires_at.as_deref().map(crate::format::date).unwrap_or_default();
                let opened = x.last_viewed_at.as_deref().map(|v| format!("opened {}", crate::format::date_time(v))).unwrap_or_else(|| "not opened yet".into());
                c = c.child(
                    row()
                        .key(format!("share-{}", x.id))
                        .w_full()
                        .py(8.0)
                        .gap(8.0)
                        .center_y()
                        .border_sides([0.0, 0.0, 1.0, 0.0], t.border)
                        .child(label(format!("Link ending {}, expires {expires}, {opened}", x.hint), type_::XS, t.foreground).wrap().grow(1.0).min_w(0.0))
                        .child(label("Revoke", type_::XS_MEDIUM, t.muted_foreground).key(format!("revoke-{}", x.id)).role("button").cursor(Cursor::Pointer).on_press(move |s: &mut App| s.revoke_share(&id))),
                );
            }
            body = body.child(c);
        }
        Load::Failed(e) => body = body.child(label(e.clone(), type_::XS, t.wrong).wrap()),
        _ => body = body.child(label("Loading links…", type_::XS, t.muted_foreground)),
    }
    Dialog::new("share-chat", "Share this chat")
        .description("A read-only link that lasts 14 days.")
        .width(520.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|s: &mut App| s.share = None)
        .build(k, layer);
}

