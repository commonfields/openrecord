//! The agent chat (`components/agent-chat.tsx`, `agent-trace.tsx`,
//! `agent-model-picker.tsx`): the transcript in a centred column, the person's
//! messages in soft bubbles on the right, the agent's replies as Markdown under
//! a folded work log, with their sources, helper sessions and decisions, and
//! the composer with its model picker at the bottom.

use rune::{Align, Cursor, El, LiveRegion, ScrollSpec, Side, col, el, row, text, text_input};
use rune_kit::{Kit, Markdown};

use crate::api::Message;
use crate::brands;
use crate::chat::{self, Activity, Progress};
use crate::icons;
use crate::state::{App, Load, Page, Turn, View};
use crate::theme::{Theme, hex, shadows, type_};
use crate::ui::widgets::{CONTROL, failure, ico, label};

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
            list = list.child(live_trace(t, progress, started.elapsed().as_millis() as i64, *stopping));
        }
        Turn::Failed { error, .. } => {
            list = list.child(label(error.clone(), type_::XS, t.wrong).key("turn-failed").self_end().wrap().live_region(LiveRegion::Polite));
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
    let mut c = col().key(format!("msg-{i}")).w_full().gap(4.0).hover_group();
    c = if user { c.items_end() } else { c.items_start() };
    if let Some(o) = &m.origin {
        c = c.child(row().gap(4.0).center_y().child(ico(&icons::CORNER_DOWN_RIGHT, 12.0, t.muted_foreground)).child(label(o.text(), type_::XS11, t.muted_foreground)));
    }
    if user {
        if !m.attachments.is_empty() {
            let mut files = row().gap(6.0).flex_wrap();
            for (j, a) in m.attachments.iter().enumerate() {
                files = files.child(
                    row()
                        .key(format!("attachment-{i}-{j}"))
                        .gap(6.0)
                        .center_y()
                        .px(8.0)
                        .py(4.0)
                        .radius(8.0)
                        .fill(t.accent)
                        .child(ico(&icons::FILE_TEXT, 13.0, t.muted_foreground))
                        .child(label(a.name.clone(), type_::XS, t.foreground).truncate().max_w(200.0)),
                );
            }
            c = c.child(files);
        }
        if !m.text.is_empty() {
            c = c.child(
                col()
                    .max_w(COLUMN * 0.85)
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
    body = body.child(run_trace(s, t, i, &m.work_log(), m.duration_ms));
    let muted = m.run.as_ref().is_some_and(|r| r.status != "COMPLETED" && !r.status.is_empty());
    body = body.child(Markdown::new(m.text.clone()).selectable(true).build(k).w_full().opacity(if muted { 0.7 } else { 1.0 }));
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

/// One line on the rail: a node and its text.
fn log_row(t: &Theme, node: El, body: El, boxed: bool) -> El {
    let mut n = row().size(24.0, 24.0).center().child(node);
    if boxed {
        n = shadows(n.radius(12.0).fill(t.background), &t.control_shadow);
    }
    row().w_full().min_h(28.0).py(2.0).gap(8.0).items_start().child(n).child(col().grow(1.0).min_w(0.0).pt(2.0).child(body))
}

fn step(t: &Theme, a: &Activity) -> El {
    match a {
        Activity::Thought { text: x, .. } => log_row(
            t,
            text("✻").font(type_::BASE.mono()).color(secondary(t)),
            label(x.clone(), type_::SM.italic(), t.muted_foreground.alpha(0.8)).wrap().max_lines(4),
            false,
        ),
        Activity::Tool { tool, text: x, failed } => {
            let icon = if *failed { ico(&icons::X, 14.0, t.wrong) } else { ico(chat::tool_icon(tool), 14.0, t.foreground.alpha(0.7)) };
            log_row(t, icon, label(x.clone(), type_::SM, if *failed { t.wrong.alpha(0.8) } else { t.foreground.alpha(0.8) }).truncate(), true)
        }
    }
}

/// The steps hung on a thin rail through the node column.
fn rail(t: &Theme, key: &str, rows: Vec<El>) -> El {
    let line = el().pin(Some(11.5), Some(12.0), None, Some(12.0)).w(1.0).fill(t.border);
    col().key(key).w_full().mt(4.0).child(line).children(rows)
}

/// A finished reply's log, folded into "Worked for 12s" until opened.
fn run_trace(s: &App, t: &Theme, i: usize, activity: &[Activity], duration: Option<i64>) -> El {
    if activity.is_empty() {
        return el();
    }
    let open = s.open_logs.contains(&i);
    let tools: Vec<&str> = activity.iter().filter_map(|a| if let Activity::Tool { tool, .. } = a { Some(tool.as_str()) } else { None }).collect();
    let name = format!("{}{}", if tools.is_empty() { "Thought" } else { "Worked" }, duration.map(|d| format!(" for {}", chat::elapsed(d))).unwrap_or_default());
    let mut head = row()
        .key(format!("worked-{i}"))
        .h(24.0)
        .gap(4.0)
        .center_y()
        .radius(6.0)
        .role("button")
        .label(name.clone())
        .expanded(open)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .on_press(move |s: &mut App| {
            if !s.open_logs.remove(&i) {
                s.open_logs.insert(i);
            }
        })
        .child(label(name, type_::SM.features("'tnum' 1"), t.muted_foreground));
    if !tools.is_empty() {
        // Up to four kinds of tool, so the folded row says what kind of work it was.
        let mut kinds: Vec<&'static rune::Icon> = Vec::new();
        for tool in &tools {
            let icon = chat::tool_icon(tool);
            if !kinds.iter().any(|k| std::ptr::eq(*k, icon)) && kinds.len() < 4 {
                kinds.push(icon);
            }
        }
        let mut r = row().pl(4.0).gap(4.0).center_y();
        for icon in kinds {
            r = r.child(ico(icon, 12.0, t.muted_foreground.alpha(0.7)));
        }
        r = r.child(label(format!("{} step{}", tools.len(), if tools.len() == 1 { "" } else { "s" }), type_::XS, t.muted_foreground.alpha(0.7)));
        head = head.child(r);
    }
    head = head.child(ico(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 14.0, t.muted_foreground.alpha(0.6)));
    let mut c = col().w_full().child(head);
    if open {
        let rows = activity.iter().map(|a| step(t, a)).collect();
        c = c.child(col().w_full().pb(8.0).border_sides([0.0, 0.0, 1.0, 0.0], t.border.alpha(0.6)).child(rail(t, &format!("log-{i}"), rows)));
    }
    c
}

/// The log of the turn still running: "Thinking for 4s", the finished steps,
/// and the step under way.
fn live_trace(t: &Theme, p: &Progress, ms: i64, stopping: bool) -> El {
    let head = if stopping { "Stopping".to_string() } else { format!("{} for {}", if p.working() { "Working" } else { "Thinking" }, chat::elapsed(ms)) };
    let mut rows: Vec<El> = p.trace.iter().map(|a| step(t, a)).collect();
    let live = label(p.live(), type_::SM, t.muted_foreground).truncate();
    rows.push(match (p.phase, &p.current_tool) {
        (chat::Phase::Working, Some(tool)) => log_row(t, ico(chat::tool_icon(tool), 14.0, secondary(t)), live, true),
        _ => log_row(t, text("✻").font(type_::BASE.mono()).color(secondary(t)), live, false),
    });
    col()
        .key("working")
        .w_full()
        .role("status")
        .live_region(LiveRegion::Polite)
        .child(label(head, type_::SM.features("'tnum' 1"), t.muted_foreground).h(24.0))
        .child(rail(t, "live-steps", rows))
}

// ---- What a reply points to -------------------------------------------------

fn resources(s: &App, t: &Theme, i: usize, m: &Message) -> El {
    let open = s.open_sources.contains(&i);
    let toggle = label(format!("Resources ({})", m.citations.len()), type_::XS_MEDIUM, t.muted_foreground)
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
                .max_w(288.0)
                .child(ico(if url.is_some() { &icons::GLOBE } else { &icons::FILE_TEXT }, 12.0, t.muted_foreground))
                .child(label(name, type_::XS, t.muted_foreground).truncate());
            if let Some(u) = url {
                chip = chip.role("link").help(u.clone()).cursor(Cursor::Pointer).on_press_tx(move |_s: &mut App, tx| {
                    let _ = tx.open_url(&u);
                });
            }
            chips = chips.child(chip);
        }
        c = c.child(chips);
    }
    c
}

fn tasks(t: &Theme, i: usize, m: &Message, statuses: &std::collections::HashMap<String, String>) -> El {
    let mut c = col().w_full().pt(4.0).gap(6.0);
    for task in &m.tasks {
        let status = statuses.get(&task.id).unwrap_or(&task.status).as_str();
        let icon = match status {
            "RUNNING" => &icons::LOADER,
            "COMPLETED" => &icons::CHECK,
            _ => &icons::X,
        };
        let meta = [Some(chat::role_label(&task.role).to_string()), task.model.clone(), Some(chat::task_status(status).to_string())].into_iter().flatten().collect::<Vec<_>>().join(", ");
        c = c.child(shadows(
            row()
                .key(format!("task-{i}-{}", task.id))
                .w_full()
                .px(14.0)
                .py(10.0)
                .gap(12.0)
                .center_y()
                .radius(10.0)
                .fill(t.card)
                .child(row().size(24.0, 24.0).radius(6.0).center().fill(t.accent).child(ico(icon, 14.0, t.muted_foreground)))
                .child(col().grow(1.0).min_w(0.0).child(label(task.title.clone(), type_::SM_MEDIUM, t.foreground).truncate()).child(label(meta, type_::XS11, t.muted_foreground))),
            &t.card_shadow,
        ));
    }
    c
}

/// The proposals a reply saved that still wait for a decision, each opening in the inbox.
fn decisions(s: &App, t: &Theme, i: usize, m: &Message) -> Vec<El> {
    let mut out = Vec::new();
    for r in &m.decisions {
        let key = r.key();
        let Some(d) = s.decisions.iter().find(|d| d.key == key) else { continue };
        let open = key.clone();
        let summary = if d.summary.is_empty() { None } else { Some(label(d.summary.clone(), type_::SM_13, t.muted_foreground).wrap().max_lines(3)) };
        out.push(shadows(
            col()
                .key(format!("decision-{i}-{key}"))
                .w_full()
                .px(16.0)
                .py(14.0)
                .gap(6.0)
                .radius(12.0)
                .fill(t.card)
                .role("group")
                .label("Waiting for your decision")
                .child(label(d.label.clone(), type_::XS_MEDIUM, t.muted_foreground))
                .child(label(d.title.clone(), type_::BASE_MEDIUM, t.foreground).wrap())
                .children(summary)
                .child(
                    row().pt(6.0).gap(8.0).child(
                        crate::ui::widgets::button(t, &format!("review-{i}-{key}"), "Review and decide", crate::ui::widgets::Variant::Primary).on_press(move |s: &mut App| {
                            s.show_view(View::Workspace);
                            s.show_page(Page::Inbox);
                            s.decision = Some(open.clone());
                        }),
                    ),
                ),
            &t.card_shadow,
        ));
    }
    out
}

// ---- The composer -----------------------------------------------------------

fn composer(s: &App, t: &Theme, business: &str) -> El {
    let working = matches!(s.turn, Turn::Working { .. });
    let blocked = s.model_unavailable();
    let input = text_input(&s.composer, type_::LG)
        .key("composer-input")
        .placeholder(if blocked { "Pick another model to continue" } else { "Describe a task or ask a question" }, t.muted_foreground)
        .label("Message the agent")
        .w_full()
        .max_h(200.0)
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.composer)
        .on_submit(|s: &mut App, tx| s.send_message(tx))
        .autofocus();
    let action = if working {
        let stopping = matches!(s.turn, Turn::Working { stopping: true, .. });
        row()
            .key("stop")
            .size(32.0, 32.0)
            .radius(16.0)
            .center()
            .role("button")
            .label("Stop")
            .help("Stop")
            .disabled(stopping)
            .cursor(Cursor::Pointer)
            .fill(t.primary)
            .on_press(|s: &mut App| s.stop_turn())
            .child(el().size(10.0, 10.0).radius(2.0).fill(t.primary_foreground))
    } else {
        let can_send = !blocked && !s.composer.text.trim().is_empty();
        row()
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
            .child(ico(&icons::ARROW_UP, 18.0, if can_send { t.primary_foreground } else { t.muted_foreground }))
    };
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
            .child(action),
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
        .child(model_trigger(s, t, working));
    col().w_full().items_center().px(24.0).pb(8.0).child(col().w_full().max_w(COLUMN).child(field).child(options))
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
        .on_press(|s: &mut App| {
            if !matches!(s.turn, Turn::Working { .. }) {
                s.open_model_menu();
            }
        });
    if let Some(o) = chosen.filter(|_| !s.model_unavailable()) {
        r = r.child(brands::mark(t, &o.brand, 16.0));
    }
    r.child(label(name, type_::XS, if s.model_unavailable() { t.wrong } else { t.muted_foreground }).truncate()).child(ico(&icons::CHEVRON_DOWN, 14.0, t.muted_foreground))
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
    let mut tabs = row().w_full().min_h(36.0).px(4.0).pt(4.0).gap(4.0).center_y().role("group").label("Model providers");
    for p in &providers {
        let on = filter.as_deref() == Some(p.as_str());
        let logo = if p == "hosted" { options.iter().find(|o| o.provider == "hosted").map(|o| o.brand.clone()).unwrap_or_else(|| "gemini".into()) } else if p == "claude" { "claude-code".into() } else { p.clone() };
        let key = p.clone();
        tabs = tabs.child(
            row()
                .key(format!("provider-{p}"))
                .size(36.0, 36.0)
                .radius(6.0)
                .center()
                .role("button")
                .label(chat::driver_name(p))
                .help(chat::driver_name(p))
                .checked(on)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .opacity(if on || filter.is_none() { 1.0 } else { 0.5 })
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.model_filter = if s.model_filter.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) })
                .child(brands::mark(t, &logo, 20.0)),
        );
    }
    let mut list = col().w_full().px(4.0).py(6.0).gap(1.0).role("listbox").label("Models");
    for o in options.iter().filter(|o| filter.as_deref().is_none_or(|f| f == o.provider)) {
        let on = chosen.as_deref() == Some(o.value.as_str());
        let value = o.value.clone();
        let mut name = col().grow(1.0).min_w(0.0).child(label(o.name.clone(), type_::SM, t.foreground).truncate());
        if let Some(i) = &o.instance {
            name = name.child(label(i.clone(), type_::XS, t.muted_foreground).truncate());
        }
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
            .cursor(Cursor::Pointer)
            .hover(t.accent)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.choose_agent_model(value.clone()))
            .child(brands::mark(t, &o.brand, 16.0))
            .child(name);
        if on {
            r = r.fill(t.accent.alpha(0.5)).child(ico(&icons::CHECK, 16.0, secondary(t)));
        }
        list = list.child(r);
    }
    let status = match &s.catalog {
        Load::Loading | Load::Idle if options.is_empty() => Some("Checking providers…".to_string()),
        Load::Failed(e) => Some(format!("Providers could not load. {e}")),
        _ if options.is_empty() => Some("No agent model is ready. Connect a provider in Settings.".into()),
        _ => None,
    };
    let api = std::env::var(crate::state::API_ENV).unwrap_or_else(|_| crate::state::DEFAULT_API.into());
    let manage = label("Manage providers…", type_::SM, t.foreground)
        .key("manage-providers")
        .w_full()
        .px(8.0)
        .pt(8.0)
        .pb(4.0)
        .role("button")
        .cursor(Cursor::Pointer)
        .on_press_tx(move |s: &mut App, tx| {
            s.menu = None;
            let _ = tx.open_url(&crate::ui::shell::web_url(&api));
        });
    let mut m = shadows(col().key("model-menu").w(336.0).padding(8.0).radius(12.0).fill(t.popover), &t.float_shadow).child(tabs).child(list);
    if let Some(st) = status {
        m = m.child(label(st, type_::XS, t.muted_foreground).px(8.0).py(12.0).wrap());
    }
    if s.model_unavailable() {
        m = m.child(label("The model you used is unavailable now. Pick another one.", type_::XS, t.wrong).px(8.0).py(8.0).wrap());
    }
    m.child(el().w_full().h(1.0).mt(8.0).fill(t.border))
        .child(manage)
        .role("dialog")
        .label("Choose an agent model")
        .anchored("model-picker", Side::Top, Align::End, 8.0)
        .modal(true, |s: &mut App| s.menu = None)
}
