//! The agent chat (`components/agent-chat.tsx`, `agent-trace.tsx`,
//! `agent-model-picker.tsx`): the transcript in a centred column, the person's
//! messages in soft bubbles on the right, the agent's replies as Markdown under
//! a folded work log, with their sources, helper sessions and decisions, and
//! the composer with its model picker at the bottom.

use rune::{Align, Cursor, El, GrowthSpec, TextStyle, LiveRegion, LoopSpec, ScrollSpec, Side, Transition, col, el, row, text_input};
use rune_kit::{Dialog, Kit, Markdown, Menu, MenuItem, Placement};

use crate::api::Message;
use crate::brands;
use crate::chat::{self, Activity, Progress};
use crate::icons;
use crate::state::{App, Load, Page, Turn, View};
use crate::theme::{Theme, hex, shadows, type_};
use crate::ui::widgets::{CONTROL, failure, ico, label};


pub fn view(s: &App, t: &Theme, k: &Kit) -> El {
    let column = s.prefs.chat_width.max();
    let business = s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "this business".into());
    let messages = s.transcript();

    // A growth stack: a message added to it eases in instead of jumping in.
    let mut list = col().key("messages").w_full().max_w(column).gap(12.0).px(24.0).pt(24.0).pb(16.0).growth(GrowthSpec::default());
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
        list = list.child(message(s, t, k, i, m, &statuses));
    }
    match &s.turn {
        Turn::Working { progress, started, stopping, .. } => {
            list = list.child(live_trace(s, t, k, progress, started.elapsed().as_millis() as i64, *stopping));
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

// ---- Motion (the web's `step-in`, `bubble-in` and `chip-in`) ----------------

/// A finished step slides up 4 points out of a blur as it lands.
fn step_in() -> Transition {
    Transition::offset(0.0, 4.0).combined(Transition::opacity()).combined(Transition::blur(2.0))
}

/// A new message rises 6 points and fades in.
fn bubble_in() -> Transition {
    Transition::offset(0.0, 6.0).combined(Transition::opacity()).combined(Transition::scale(0.985))
}

/// Chips follow one another in, 50 milliseconds apart.
fn chip_in(el_: El, n: usize) -> El {
    el_.transition(Transition::offset(0.0, 3.0).combined(Transition::opacity()).combined(Transition::scale(0.97))).enter_delay(0.05 * n.min(4) as f32)
}

/// A spinner: one turn a second.
fn spinning(el_: El) -> El {
    el_.looping(LoopSpec::rotation(1.0))
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

fn message(s: &App, t: &Theme, k: &Kit, i: usize, m: &Message, statuses: &std::collections::HashMap<String, String>) -> El {
    let user = m.role == "user";
    let mut c = col().key(format!("msg-{i}")).w_full().gap(4.0).hover_group().transition(bubble_in());
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
            c = c.child(
                col()
                    .max_w(s.prefs.chat_width.max().min(900.0) * 0.85)
                    .px(16.0)
                    .py(10.0)
                    .radius(16.0)
                    .fill(t.accent)
                    .child(label(m.text.clone(), type_::BASE.lh(26.0), t.foreground).wrap().selectable(true)),
            );
        }
        return c.child(copy_button(s, t, i, &m.text));
    }
    let mut body = col().w_full().gap(6.0);
    body = body.child(run_trace(s, t, k, i, &m.work_log()));
    let muted = m.run.as_ref().is_some_and(|r| r.status != "COMPLETED" && !r.status.is_empty());
    // Markdown, with any ```chart blocks drawn as charts in their place. A reply
    // that just arrived grows word by word, each word fading in (Rune's streaming
    // Markdown); a click shows it whole.
    let revealing = s.revealing(&m.text);
    let shown = revealing.clone().unwrap_or_else(|| m.text.clone());
    let mut reply = col().key(format!("reply-{i}")).w_full().gap(6.0);
    for (j, part) in crate::visual::split(&shown).into_iter().enumerate() {
        reply = reply.child(match part {
            crate::visual::Part::Text(md) => Markdown::new(md).selectable(revealing.is_none()).streaming(revealing.is_some()).reveal(if revealing.is_some() { 0.18 } else { 0.0 }).build(k).w_full().opacity(if muted { 0.7 } else { 1.0 }),
            crate::visual::Part::Chart(raw) => crate::ui::visual::view(s, t, format!("visual-{i}-{j}"), &raw).my(4.0),
        });
    }
    if revealing.is_some() {
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
        body = body.child(tasks(t, i, m, statuses));
    }
    if !m.decisions.is_empty() {
        body = body.children(decisions(s, t, i, m));
    }
    c.child(body).child(copy_button(s, t, i, &m.text))
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

/// A run of the same kind of step: thinking, or tool calls.
enum Group<'a> {
    Thought { texts: Vec<&'a str>, ms: i64 },
    Tools(Vec<&'a Activity>),
}

/// Consecutive steps of one kind fold into one line, in the order they ran.
fn groups(activity: &[Activity]) -> Vec<Group<'_>> {
    let mut out: Vec<Group<'_>> = Vec::new();
    for a in activity {
        match (a, out.last_mut()) {
            (Activity::Thought { text: x, ms }, Some(Group::Thought { texts, ms: total })) => {
                texts.push(x);
                *total += ms;
            }
            (Activity::Thought { text: x, ms }, _) => out.push(Group::Thought { texts: vec![x], ms: *ms }),
            (Activity::Tool { .. }, Some(Group::Tools(list))) => list.push(a),
            (Activity::Tool { .. }, _) => out.push(Group::Tools(vec![a])),
        }
    }
    out
}

/// A folded line in Rune's agent timeline: "Thought for 4s ›" or "Used 3 tools ›".
/// Open, a tool group's header sticks to the top while its steps scroll under it.
fn fold(t: &Theme, k: &Kit, key: String, open: bool, at: (usize, usize), parts: Vec<El>, sticky: bool) -> El {
    let toggle_key = key.clone();
    let mut head = row()
        .key(key)
        .h(28.0)
        .gap(6.0)
        .center_y()
        .role("button")
        .expanded(open)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover_group()
        .on_press_tx(move |s: &mut App, tx| {
            if !s.open_logs.remove(&at) {
                s.open_logs.insert(at);
            }
            tx.keep_on_screen(toggle_key.clone());
        })
        .children(parts)
        // The chevron turns a quarter as the line opens, and brightens on hover.
        .child(
            row()
                .size(14.0, 14.0)
                .center()
                .rotate(if open { std::f32::consts::FRAC_PI_2 } else { 0.0 })
                .motion(CONTROL)
                .group_opacity(0.6, 1.0)
                .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground)),
        );
    if open && sticky {
        head = head.w_full().fill(t.background).sticky_top(0.0);
    }
    let _ = k;
    head
}

fn thought_line(t: &Theme, k: &Kit, key: String, at: (usize, usize), open: bool, texts: &[&str], ms: i64) -> El {
    let name = if ms > 0 { format!("Thought for {}", chat::elapsed(ms)) } else { "Thought".to_string() };
    let head = fold(t, k, key.clone(), open, at, vec![ico(&icons::BRAIN, 15.0, t.muted_foreground).group_color(t.foreground), label(name.clone(), type_::SM.features("'tnum' 1"), t.muted_foreground).group_color(t.foreground)], false).label(name);
    let mut body = col().w_full().pl(22.0).pb(6.0).gap(6.0);
    for x in texts.iter().filter(|x| !x.trim().is_empty()) {
        body = body.child(label(x.to_string(), type_::SM_13.italic(), t.muted_foreground.alpha(0.85)).wrap().selectable(open));
    }
    col().key(format!("{key}-group")).w_full().clip_soft(0.0).child(head).child(folding(format!("{key}-body"), open, body))
}

fn tools_line(t: &Theme, k: &Kit, key: String, at: (usize, usize), open: bool, list: &[&Activity], live: Option<El>) -> El {
    let n = list.len();
    let name = format!("Used {n} tool{}", if n == 1 { "" } else { "s" });
    // "Used 3 tools", the count in the foreground and rolling as it grows.
    let parts = vec![row()
        .gap(4.0)
        .center_y()
        .child(label("Used", type_::SM, t.muted_foreground).group_color(t.foreground))
        .child(rune_kit::RollingText::new(format!("{key}-count"), n.to_string()).value(n as f64).font(type_::SM_MEDIUM.features("'tnum' 1")).color(t.foreground).build(k))
        .child(label(if n == 1 { "tool" } else { "tools" }, type_::SM, t.muted_foreground).group_color(t.foreground))];
    let head = fold(t, k, key.clone(), open, at, parts, true).label(name);
    let mut body = col().key(format!("{key}-steps")).w_full().pl(2.0).pb(6.0).growth(GrowthSpec::default());
    for (j, a) in list.iter().enumerate() {
        if let Activity::Tool { tool, text: x, failed } = a {
            let (icon, ink) = if *failed { (ico(&icons::X, 14.0, t.wrong), t.wrong.alpha(0.85)) } else { (ico(chat::tool_icon(tool), 14.0, t.muted_foreground), t.muted_foreground) };
            body = body.child(row().key(format!("{key}-step-{j}")).w_full().h(28.0).gap(8.0).center_y().transition(step_in()).child(icon).child(label(x.clone(), type_::SM_13, ink).truncate().grow(1.0).min_w(0.0)));
        }
    }
    let mut c = col().key(format!("{key}-group")).w_full().clip_soft(0.0).child(head).child(folding(format!("{key}-box"), open, body));
    if let Some(l) = live {
        c = c.child(l);
    }
    c
}

/// A fold's body: always laid out, held at no height while shut so the group's
/// clip folds it up, as Rune's sticky tool group does, and out of the
/// accessibility tree while hidden.
fn folding(key: String, open: bool, body: El) -> El {
    let held = col().key(key).w_full();
    if open { held.child(body) } else { held.h(0.0).a11y_hidden().child(body) }
}

/// A finished reply's steps: one folded line per run of thinking or tool calls.
fn run_trace(s: &App, t: &Theme, k: &Kit, i: usize, activity: &[Activity]) -> El {
    let mut c = col().key(format!("trace-{i}")).w_full();
    for (g, group) in groups(activity).iter().enumerate() {
        let at = (i, g);
        let open = s.open_logs.contains(&at);
        let key = format!("trace-{i}-{g}");
        c = c.child(match group {
            Group::Thought { texts, ms } => thought_line(t, k, key, at, open, texts, *ms),
            Group::Tools(list) => tools_line(t, k, key, at, open, list, None),
        });
    }
    c
}

/// The turn still running: its folded steps so far, what it is doing now,
/// and the "Working" line under them.
fn live_trace(s: &App, t: &Theme, k: &Kit, p: &Progress, ms: i64, stopping: bool) -> El {
    let live = usize::MAX;
    let all = groups(&p.trace);
    let n = all.len();
    let mut c = col().key("working").w_full().role("status").live_region(LiveRegion::Polite).growth(GrowthSpec::default());
    let now = label(p.live(), type_::SM_13, t.muted_foreground).truncate();
    let thinking_now = !matches!((p.phase, &p.current_tool), (chat::Phase::Working, Some(_)));
    for (g, group) in all.iter().enumerate() {
        let at = (live, g);
        let open = s.open_logs.contains(&at);
        let key = format!("live-{g}");
        c = c.child(match group {
            Group::Thought { texts, ms } => thought_line(t, k, key, at, open, texts, *ms),
            // The step under way shows under the tool group it belongs to.
            Group::Tools(list) if g + 1 == n && !thinking_now => {
                let tool = p.current_tool.clone().unwrap_or_default();
                let step = row().key("live-now").w_full().h(28.0).pl(2.0).gap(8.0).center_y().transition(step_in()).child(ico(chat::tool_icon(&tool), 14.0, secondary(t)).looping(LoopSpec::opacity(1.2, 0.0, 0.45, 1.0))).child(now.clone());
                tools_line(t, k, key, at, open, list, Some(step))
            }
            Group::Tools(list) => tools_line(t, k, key, at, open, list, None),
        });
    }
    if thinking_now || !matches!(all.last(), Some(Group::Tools(_))) {
        if !thinking_now {
            let tool = p.current_tool.clone().unwrap_or_default();
            c = c.child(row().key("live-now").w_full().h(28.0).pl(2.0).gap(8.0).center_y().transition(step_in()).child(ico(chat::tool_icon(&tool), 14.0, secondary(t)).looping(LoopSpec::opacity(1.2, 0.0, 0.45, 1.0))).child(now));
        } else {
            // Thinking: the glyph breathes while the text sweeps, as the web's `.thinking` does.
            c = c.child(row().key("live-thinking").w_full().h(28.0).gap(6.0).center_y().transition(step_in()).child(ico(&icons::BRAIN, 15.0, secondary(t)).looping(LoopSpec::opacity(1.6, 0.0, 0.4, 1.0))).child(now.looping(LoopSpec::opacity(2.25, 0.0, 0.6, 1.0))));
        }
    }
    let status = if stopping { "Stopping".to_string() } else { format!("Working for {}", chat::elapsed(ms)) };
    c.child(
        row()
            .key("working-line")
            .h(28.0)
            .mt(4.0)
            .gap(8.0)
            .center_y()
            // Two steady beats a second (`status-pulse`).
            .child(el().size(6.0, 6.0).radius(3.0).fill(t.working).looping(LoopSpec::opacity(0.5, 0.0, 0.4, 1.0)))
            .child(label(status, type_::SM.features("'tnum' 1"), t.muted_foreground)),
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
        let mut chips = row().gap(6.0).flex_wrap();
        for (j, cit) in m.citations.iter().enumerate() {
            let url = cit.url().map(str::to_string);
            let name = if cit.text.is_empty() { url.clone().unwrap_or_else(|| "Open evidence".into()) } else { cit.text.clone() };
            let mut chip = row()
                .key(format!("source-{i}-{j}"))
                .gap(4.0)
                .center_y()
                .px(6.0)
                .py(2.0)
                .radius(6.0)
                .fill(t.accent.alpha(0.6))
                .hover(t.accent)
                .hover_group()
                .motion(CONTROL)
                .max_w(288.0)
                .child(ico(if url.is_some() { &icons::GLOBE } else { &icons::FILE_TEXT }, 12.0, t.muted_foreground).group_color(t.foreground))
                .child(label(name, type_::XS, t.muted_foreground).group_color(t.foreground).truncate());
            if let Some(u) = url {
                chip = chip.role("link").help(u.clone()).cursor(Cursor::Pointer).on_press_tx(move |_s: &mut App, tx| {
                    let _ = tx.open_url(&u);
                });
            }
            chips = chips.child(chip_in(chip, j));
        }
        c = c.child(chips);
    }
    c
}

fn tasks(t: &Theme, i: usize, m: &Message, statuses: &std::collections::HashMap<String, String>) -> El {
    // Rune's task chip: a status mark, the helper's role, its title and where it stands.
    let mut c = row().w_full().pt(4.0).gap(6.0).flex_wrap();
    for task in &m.tasks {
        let status = statuses.get(&task.id).unwrap_or(&task.status).as_str();
        let (icon, ink) = match status {
            "RUNNING" => (&icons::LOADER, secondary(t)),
            "COMPLETED" => (&icons::CHECK, t.muted_foreground),
            _ => (&icons::X, t.wrong),
        };
        let mark = if status == "RUNNING" { spinning(ico(icon, 14.0, ink)) } else { ico(icon, 14.0, ink) };
        let mut chip = row()
            .key(format!("task-{i}-{}", task.id))
            .h(32.0)
            .px(10.0)
            .gap(8.0)
            .center_y()
            .radius(8.0)
            .fill(t.card)
            .max_w(560.0)
            .motion(CONTROL)
            .child(mark)
            .child(label(chat::role_label(&task.role), type_::SM_MEDIUM, t.foreground))
            .child(label(task.title.clone(), type_::SM, t.muted_foreground).truncate().min_w(0.0))
            .child(label(chat::task_status(status), type_::XS, t.muted_foreground.alpha(0.8)));
        if !task.session_id.is_empty() {
            let id = task.session_id.clone();
            chip = chip
                .role("link")
                .label(format!("Open the helper session: {}", task.title))
                .help(task.model.clone().unwrap_or_else(|| "Open the helper session".into()))
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.open_session(&id));
        }
        let n = c_count(&m.tasks, &task.id);
        c = c.child(chip_in(shadows(chip, &t.card_shadow), n));
    }
    c
}

fn c_count(tasks: &[chat::TaskRef], id: &str) -> usize {
    tasks.iter().position(|x| x.id == id).unwrap_or(0)
}

/// The proposals a reply saved that still wait for a decision, each opening in the inbox.
fn decisions(s: &App, t: &Theme, i: usize, m: &Message) -> Vec<El> {
    use crate::ui::widgets::{Variant, button};
    let mut out = Vec::new();
    for r in &m.decisions {
        let key = r.key();
        let Some(d) = s.decisions.iter().find(|d| d.key == key) else { continue };
        let busy = s.deciding.as_deref() == Some(key.as_str());
        let here = s.decision.as_deref() == Some(key.as_str());
        let summary = if d.summary.is_empty() { None } else { Some(label(d.summary.clone(), type_::SM_13, t.muted_foreground).wrap().max_lines(3)) };
        let mut c = col()
            .key(format!("decision-{i}-{key}"))
            .w_full()
            .px(16.0)
            .py(14.0)
            .gap(6.0)
            .radius(12.0)
            .fill(t.card)
            .role("group")
            .label("Waiting for your decision")
            .transition(chip_in_t())
            .child(label(d.label.clone(), type_::XS_MEDIUM, t.muted_foreground))
            .child(label(d.title.clone(), type_::BASE_MEDIUM, t.foreground).wrap())
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
            let mut bar = row().w_full().pt(6.0).gap(8.0).center_y().flex_wrap();
            bar = bar.child(match blocked.map(str::to_string).or_else(|| d.note.clone()) {
                Some(n) => label(n, type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(200.0),
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

fn composer(s: &App, t: &Theme, business: &str) -> El {
    let working = matches!(s.turn, Turn::Working { .. });
    let blocked = s.model_unavailable();
    let has_text = !s.composer.text.trim().is_empty();
    let placeholder = if blocked {
        "The model you used is unavailable now. Pick another model below"
    } else if working {
        "Write a follow-up. It sends when the agent finishes"
    } else if !s.transcript().is_empty() {
        "Reply to the agent, or type / for commands"
    } else {
        "Describe a task or ask a question"
    };
    let input = text_input(&s.composer, type_::BASE)
        .key("composer-input")
        .placeholder(placeholder, t.muted_foreground)
        .label("Message the agent")
        .w_full()
        .py(4.0)
        .max_h(192.0)
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.composer)
        // While the "/" menu is open, arrows, Tab, Return and Escape drive it.
        .on_input_key(|s: &mut App, ev, tx| s.composer_key(ev, tx))
        // Return sends, or with "Send with Enter" off adds a line (⌘Return sends then).
        .on_submit(|s: &mut App, tx| {
            if s.prefs.enter_to_send {
                s.send_message(tx);
            } else {
                s.composer.insert("\n");
            }
        })
        .autofocus();
    // The buttons at the box's right end, as the web composer draws them: while a
    // turn runs, a queue button (once something is typed) and Stop; otherwise Send,
    // only once something is typed.
    let circle = |key: &str, name: &str, help: &str, fill: rune::Color| {
        row().key(key).size(32.0, 32.0).radius(16.0).center().role("button").label(name).help(help).focusable(true).cursor(Cursor::Pointer).fill(fill).motion(CONTROL)
    };
    let mut actions = row().gap(4.0).center_y().self_end();
    if working {
        if has_text {
            let can = !blocked;
            actions = actions.child(
                circle("queue", "Queue message", "Queue it. It sends when the agent finishes.", t.accent)
                    .disabled(!can)
                    .opacity(if can { 1.0 } else { 0.5 })
                    .on_press_tx(|s: &mut App, tx| s.send_message(tx))
                    .child(ico(&icons::ARROW_UP, 16.0, t.foreground)),
            );
        }
        let stopping = matches!(s.turn, Turn::Working { stopping: true, .. });
        actions = actions.child(
            circle("stop", "Stop the agent", "Stop the agent", t.primary)
                .disabled(stopping)
                .hover(t.primary.alpha(0.9))
                .on_press(|s: &mut App| s.stop_turn())
                .child(el().size(10.0, 10.0).radius(2.0).fill(t.primary_foreground)),
        );
    } else if has_text {
        let can = !blocked;
        actions = actions.child(
            circle("send", "Send message", if s.prefs.enter_to_send { "Send (Enter). Shift Enter adds a new line." } else { "Send (⌘ Enter). Enter adds a new line." }, t.primary)
                .disabled(!can)
                .opacity(if can { 1.0 } else { 0.5 })
                .hover(t.primary.alpha(0.9))
                .on_press_tx(|s: &mut App, tx| s.send_message(tx))
                .child(ico(&icons::ARROW_UP, 16.0, t.primary_foreground)),
        );
    }
    // "Chat actions" on the left of the box: save as playbook, share, attach and providers.
    let plus = row()
        .key("chat-actions-trigger")
        .size(32.0, 32.0)
        .radius(6.0)
        .center()
        .self_end()
        .role("button")
        .label("Chat actions")
        .expanded(s.chat_actions)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .hover_group()
        .motion(CONTROL)
        .on_press(|s: &mut App| s.chat_actions = !s.chat_actions)
        .child(ico(&icons::PLUS, 20.0, t.muted_foreground).group_color(t.foreground));

    let mut field = shadows(
        row()
            .key("composer")
            .w_full()
            .min_h(48.0)
            .px(12.0)
            .py(8.0)
            .gap(12.0)
            .items_end()
            .radius(10.0)
            .fill(t.card)
            .child(plus)
            .child(col().grow(1.0).min_w(0.0).self_center().child(input))
            .child(actions),
        &t.control_shadow,
    );
    // The "/" menu sits over the transcript just above the box, inset 8 points
    // each side, every entry listed: the web's `absolute inset-x-2 bottom-full mb-2`.
    if let Some(menu) = command_menu(s, t) {
        field = field.child(menu);
    }

    // "Chat options" under the box: the business on the left; follow-ups, the
    // memory meter, the model and reasoning on the right, 12 points apart.
    let mut options = row()
        .w_full()
        .min_h(24.0)
        .px(12.0)
        .center_y()
        .child(row().gap(4.0).center_y().max_w(224.0).min_w(0.0).label(format!("Chatting about {business}")).child(ico(&icons::FOLDER, 14.0, t.muted_foreground)).child(label(business.to_string(), type_::XS, t.muted_foreground).truncate()))
        .child(el().grow(1.0));
    let mut right = row().gap(12.0).center_y();
    if let Some(f) = followups_trigger(s, t) {
        right = right.child(f);
    }
    if let Some(m) = context_meter(s, t) {
        right = right.child(m);
    }
    right = right.child(model_trigger(s, t, working)).child(reasoning_trigger(s, t, working));
    options = options.child(right);

    // The web's `space-y-0.5`: queued messages, attached files, the box, then its options.
    let mut stack = col().w_full().max_w(s.prefs.chat_width.max()).gap(2.0);
    if !s.queued.is_empty() {
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
    col().w_full().items_center().px(24.0).pb(8.0).child(stack.child(field).child(options))
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
fn context_meter(s: &App, t: &Theme) -> Option<El> {
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
            .key("context-meter")
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

/// The composer's model button: the chosen model's logo and name.
fn model_trigger(s: &App, t: &Theme, locked: bool) -> El {
    let chosen = s.chosen_model();
    let name = match (&s.catalog, chosen) {
        (_, Some(o)) if !s.model_unavailable() => o.name.clone(),
        (_, _) if s.model_unavailable() => "Model unavailable".into(),
        (Load::Loading | Load::Idle, _) => "Checking providers…".into(),
        _ => "Choose a model".into(),
    };
    let mut r = row()
        .key("model-picker")
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
        .on_press(|s: &mut App| {
            if !matches!(s.turn, Turn::Working { .. }) {
                s.open_model_menu();
            }
        });
    if let Some(o) = chosen.filter(|_| !s.model_unavailable()) {
        r = r.child(brands::mark(t, &o.brand, 16.0));
    }
    let ink = if s.model_unavailable() { t.wrong } else { t.muted_foreground };
    r.child(label(name, type_::XS, ink).group_color(if s.model_unavailable() { t.wrong } else { t.foreground }).truncate()).child(ico(&icons::CHEVRON_DOWN, 14.0, t.muted_foreground).group_color(t.foreground))
}

/// The reasoning effort for the next reply, beside the model, when the model reports any.
fn reasoning_trigger(s: &App, t: &Theme, locked: bool) -> El {
    // Always shown, as on the web; disabled while the model reports no reasoning controls.
    let none = s.chosen_model().filter(|_| !s.model_unavailable()).is_none_or(|m| m.efforts.is_empty());
    let locked = locked || none;
    let name = s.reasoning_effort().map(chat::effort_label).unwrap_or_else(|| "Reasoning".into());
    {
        row()
            .key("reasoning-picker")
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
                    s.menu = Some(crate::state::Menu::Reasoning);
                }
            })
            .child(label(name, type_::XS, t.muted_foreground).group_color(if locked { t.muted_foreground } else { t.foreground }))
            .child(ico(&icons::CHEVRON_DOWN, 16.0, t.muted_foreground).group_color(if locked { t.muted_foreground } else { t.foreground }))
    }
}

/// Default and the efforts the model offers, each a 40-point row as the web's select draws them.
pub fn reasoning_menu(s: &App, t: &Theme) -> El {
    let efforts = s.chosen_model().map(|m| m.efforts.clone()).unwrap_or_default();
    let current = s.reasoning_effort().map(str::to_string);
    let mut m = shadows(col().key("reasoning-menu").w(176.0).padding(4.0).gap(1.0).radius(12.0).fill(t.popover), &t.float_shadow).role("listbox").label("Reasoning effort");
    let row_ = |key: String, name: String, on: bool, effort: Option<String>| {
        row()
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
            .hover(t.accent)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.choose_reasoning(effort.clone()))
            .child(label(name, type_::SM, t.foreground).grow(1.0))
            .children(on.then(|| ico(&icons::CHECK, 14.0, secondary(t))))
    };
    m = m.child(row_("effort-default".into(), "Default".into(), current.is_none(), None));
    for e in efforts {
        m = m.child(row_(format!("effort-{e}"), chat::effort_label(&e), current.as_deref() == Some(e.as_str()), Some(e.clone())));
    }
    m.anchored("reasoning-picker", Side::Top, Align::End, 8.0).modal(true, |s: &mut App| s.menu = None)
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
    let mut list = col().w_full().gap(1.0).role("listbox").label("Models");
    for o in &visible {
        let on = chosen.as_deref() == Some(o.value.as_str());
        let value = o.value.clone();
        let mut r = row()
            .key(format!("model-{}", o.value))
            .w_full()
            .h(32.0)
            .px(8.0)
            .gap(8.0)
            .center_y()
            .radius(6.0)
            .role("option")
            .label(o.name.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.accent)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.choose_agent_model(value.clone()))
            .child(brands::mark(t, &o.brand, 16.0))
            .child(label(o.name.clone(), type_::SM, t.foreground).truncate().min_w(0.0))
            .child(match &o.instance {
                Some(i) => label(i.clone(), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0),
                None => el().grow(1.0),
            });
        if on {
            r = r.fill(t.accent.alpha(0.5)).child(ico(&icons::CHECK, 14.0, secondary(t)));
        }
        list = list.child(r);
    }
    let list = col().key("model-list").w_full().max_h(256.0).mt(4.0).child(list).scroll(ScrollSpec { stick_bottom: false });
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
    let mut m = shadows(col().key("model-menu").w(300.0).padding(6.0).radius(12.0).fill(t.popover), &t.float_shadow).child(tabs).child(list);
    if let Some(st) = status {
        m = m.child(label(st, type_::XS, t.muted_foreground).px(8.0).py(12.0).wrap());
    }
    if s.model_unavailable() {
        m = m.child(label("The model you used is unavailable now. Pick another one.", type_::XS, t.wrong).px(8.0).py(8.0).wrap());
    }
    m.child(el().w_full().h(1.0).mt(6.0).mb(4.0).fill(t.border))
        .child(manage)
        .role("dialog")
        .label("Choose an agent model")
        .anchored("model-picker", Side::Top, Align::End, 8.0)
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
    let height = entries.len() as f32 * 28.0 + 8.0;
    let mut list = col().key("command-menu").padding(4.0).radius(10.0).fill(t.popover).role("listbox").label("Commands").pin(Some(8.0), Some(-(height + 8.0)), Some(8.0), None);
    for (i, e) in entries.iter().enumerate() {
        let on = i == active;
        let id = e.id();
        let mut r = row()
            .key(format!("command-{id}"))
            .w_full()
            .h(28.0)
            .px(10.0)
            .radius(6.0)
            .center_y()
            .role("option")
            .label(e.name().to_string())
            .checked(on)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_hover_change(move |s: &mut App, inside, _tx| {
                if inside {
                    s.command_index = i;
                }
            })
            .on_press_tx(move |s: &mut App, tx| s.choose_entry(&id, tx))
            .child(label(e.name().to_string(), type_::XS_MEDIUM, t.foreground).truncate());
        if on {
            r = shadows(r.fill(t.accent), &t.control_shadow);
        }
        list = list.child(r);
    }
    Some(shadows(list, &t.float_shadow))
}

// ---- Overlays: the "/" menu, the "+" menu and their dialogs ---------------------

/// What the agent view floats over the window, built with Rune's kit: the "/"
/// menu as a `PopupList` above the composer, the "+" menu, and its dialogs.
pub fn layers(s: &App, t: &Theme, k: &Kit, layer: &mut Vec<El>) {
    if s.chat_actions {
        let draft = s.composer.text.trim();
        let can_save = !draft.is_empty() && !draft.starts_with('/');
        let can_share = s.chat_id.is_some() && s.conversation.ready().is_some();
        let _ = Menu::new("chat-actions")
            .open(true)
            .placement(Placement::TopEnd)
            .min_width(240.0)
            .item(MenuItem::new("Save as playbook").icon(&icons::BOOKMARK_PLUS).disabled(!can_save).on_select_tx(|s: &mut App, tx| s.open_save_playbook(tx)))
            .item(MenuItem::new("Share this chat").icon(&icons::SHARE).description("read-only link").disabled(!can_share).on_select(|s: &mut App| s.open_share()))
            .separator()
            .item(MenuItem::new("Attach files").icon(&icons::PAPERCLIP).on_select_tx(|s: &mut App, tx| s.attach(tx)))
            .separator()
            .item(MenuItem::new("Manage providers").on_select(|s: &mut App| {
                s.chat_actions = false;
                s.open_settings(crate::state::SettingsPage::Agent);
            }))
            .on_close(|s: &mut App| s.chat_actions = false)
            .build(k, layer);
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

/// "Follow-ups", "Follow-ups on" or "Follow-ups elsewhere", by the model picker.
/// Only on a person's own chat, not a helper session.
fn followups_trigger(s: &App, t: &Theme) -> Option<El> {
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
            .key("followups-trigger")
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
                    Location::Here => "Enabled in this chat",
                    Location::Elsewhere => "Enabled in another chat",
                },
                type_::SM_MEDIUM,
                t.foreground,
            ));
            if let Policy::Configured { enabled: true, provider, model, conversation_id, .. } = &f.policy {
                status = status.child(row().gap(8.0).center_y().child(brands::mark(t, &crate::brands::model_brand(model, provider), 16.0)).child(label(model.clone(), type_::SM_13, t.muted_foreground)));
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
                .child(label("Read-only. No publishing, ad-budget changes, contacting customers or starting other agents. No provider fallback. The server and selected provider must be available.", type_::SM_13, t.muted_foreground).wrap());
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
