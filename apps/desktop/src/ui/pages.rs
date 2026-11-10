//! The workspace pages the sidebar opens: Inbox, Overview, Campaigns,
//! AI answers and Channels, read from the same endpoints the web pages use.

use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text_input};

use crate::api::{Channel, Decision, Issue};
use crate::decisions::Act;
use crate::format;
use crate::icons;
use crate::state::{App, Load, Page, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, card, empty_state, failure, ico, label, page_header, skeleton, status_chip};

pub fn view(s: &App, t: &Theme) -> El {
    let body = match s.page {
        Page::Inbox => inbox(s, t),
        Page::Overview => overview(s, t),
        Page::Campaigns => campaigns(s, t),
        Page::AiAnswers => ai_answers(s, t),
        Page::Channels => channels(s, t),
    };
    body.key(format!("page-{}", s.page.key()))
}

/// The header's trailing action on workspace pages.
pub fn ask_agent(t: &Theme) -> El {
    button(t, "ask-agent", "Ask the agent", Variant::Outline).on_press(|s: &mut App| s.show_view(View::Agent))
}

/// Opens the agent with a request typed in the composer, ready to send.
fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.new_chat();
        s.composer.replace_text(request);
    }
}

fn inbox(s: &App, t: &Theme) -> El {
    let items = s.inbox();
    if items.is_empty() {
        return col().w_full().child(empty_state(
            t,
            "inbox-empty",
            &icons::INBOX,
            "Nothing is waiting on you",
            "When the agent needs your decision, it will appear here.",
            Some(button(t, "ask-next", "Ask the agent what to do next", Variant::Outline).on_press(ask(
                "What should we work on next? Check our results and channels and propose the most useful next step for me to approve.",
            ))),
        ));
    }
    let now = format::now();
    let open = s.open_decision().map(|d| d.key.clone());
    let n = items.len();
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
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.select_decision(&key))
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(label(format!("{}, {}", d.business_name, d.label), type_::XS_MEDIUM, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                    .child(label(format::relative(d.created_at.as_deref(), now), type_::XS, t.muted_foreground)),
            )
            .child(label(d.title.clone(), type_::SM_MEDIUM, t.foreground).wrap().max_lines(2))
            .child(label(d.summary.clone(), type_::XS, t.muted_foreground).wrap().max_lines(2));
        if on {
            r = shadows(r.fill(t.accent), &t.control_shadow);
        }
        list = list.child(r);
    }
    let list_card = card(t)
        .w(340.0)
        .clip_rounded(12.0)
        .child(
            row()
                .w_full()
                .px(16.0)
                .py(12.0)
                .center_y()
                .child(label("Inbox", type_::SM_MEDIUM, t.foreground).grow(1.0))
                .child(label(format!("{n} waiting"), type_::XS, t.muted_foreground)),
        )
        .child(list);
    let detail = match s.open_decision() {
        Some(d) => decision_detail(s, t, d, now),
        None => el(),
    };
    col()
        .w_full()
        .gap(24.0)
        .child(page_header(t, "Inbox", "Everything the agent prepared that needs your decision."))
        .child(row().w_full().gap(16.0).items_start().child(list_card).child(detail))
}

fn decision_detail(s: &App, t: &Theme, d: &Decision, now: i64) -> El {
    let busy = s.deciding.as_deref() == Some(d.key.as_str());
    let mut c = card(t)
        .key(format!("decision-detail-{}", d.key))
        .grow(1.0)
        .min_w(0.0)
        .px(24.0)
        .py(20.0)
        .gap(16.0)
        .child(
            col()
                .w_full()
                .gap(6.0)
                .child(label(
                    format!("{}, {}, {}", d.business_name, d.label, format::relative(d.created_at.as_deref(), now)),
                    type_::XS,
                    t.muted_foreground,
                ))
                .child(label(d.title.clone(), type_::BASE_MEDIUM, t.foreground).wrap().role("heading"))
                .children((!d.summary.is_empty()).then(|| label(d.summary.clone(), type_::SM_13, t.muted_foreground).wrap())),
        );
    if !d.sections.is_empty() {
        let mut grid = row().w_full().gap(16.0).flex_wrap();
        for (i, sec) in d.sections.iter().enumerate() {
            let mut cell = col().key(format!("section-{i}")).grow(1.0).min_w(240.0).gap(6.0).child(label(sec.label.clone(), type_::XS_MEDIUM, t.muted_foreground));
            if let Some(b) = &sec.before {
                cell = cell.child(
                    col()
                        .w_full()
                        .px(10.0)
                        .py(6.0)
                        .radius(6.0)
                        .fill(t.wrong_soft.alpha(0.5))
                        .gap(2.0)
                        .child(label("Now", type_::XS2, t.muted_foreground))
                        .child(label(if b.is_empty() { "(empty)".to_string() } else { b.clone() }, type_::SM_13, t.muted_foreground).wrap()),
                );
                cell = cell.child(
                    col()
                        .w_full()
                        .px(10.0)
                        .py(6.0)
                        .radius(6.0)
                        .fill(t.supported_soft)
                        .gap(2.0)
                        .child(label("After approval", type_::XS2, t.muted_foreground))
                        .child(label(sec.text.clone(), type_::SM_13, t.foreground).wrap()),
                );
            } else {
                cell = cell.child(label(sec.text.clone(), type_::SM_13, t.foreground).wrap());
            }
            grid = grid.child(cell);
        }
        c = c.child(grid);
    }
    if let Some(body) = &d.body {
        c = c.child(
            col()
                .key("decision-body")
                .w_full()
                .max_h(320.0)
                .px(14.0)
                .py(12.0)
                .radius(8.0)
                .fill(t.accent.alpha(0.6))
                .child(label(body.clone(), type_::SM_13, t.foreground).wrap().selectable(true))
                .scroll(ScrollSpec { stick_bottom: false }),
        );
    }
    if d.act == Act::Check {
        c = c.child(model_picker(s, t));
    }
    if let Some((key, err)) = &s.decision_error {
        if key == &d.key {
            c = c.child(label(err.clone(), type_::SM_13, t.wrong).wrap().key("decision-error").live_region(rune::LiveRegion::Polite));
        }
    }
    let blocked = d.blocked(s.model.as_deref());
    let note = blocked.map(str::to_string).or_else(|| d.note.clone());
    if s.declining {
        let input = text_input(&s.decline_reason, type_::SM)
            .key("decline-reason")
            .placeholder("Why not? Optional, saved for the agent", t.muted_foreground)
            .label("Reason for declining")
            .w_full()
            .color(t.foreground)
            .on_edit(|s: &mut App| &mut s.decline_reason)
            .on_submit(|s: &mut App, _| s.confirm_decline());
        let field = shadows(row().w_full().h(36.0).px(12.0).radius(8.0).center_y().fill(t.control).child(input), &t.control_shadow);
        c = c.child(
            col()
                .w_full()
                .gap(10.0)
                .child(field)
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(el().grow(1.0))
                        .child(button(t, "decline-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.cancel_decline()))
                        .child(action(t, "decline-confirm", if busy { "Declining…" } else { d.decline.as_str() }, Variant::Primary, !busy, |s: &mut App| s.confirm_decline())),
                ),
        );
    } else {
        let mut bar = row().w_full().gap(8.0).center_y().flex_wrap();
        bar = bar.child(match note {
            Some(n) => label(n, type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(200.0),
            None => el().grow(1.0),
        });
        bar = bar
            .child(
                button(t, "decline", d.decline.as_str(), Variant::Outline)
                    .disabled(busy)
                    .on_press_tx(|s: &mut App, tx| s.start_decline(tx)),
            )
            .child(action(
                t,
                "approve",
                if busy { "Working…" } else { d.approve.as_str() },
                Variant::Primary,
                !busy && blocked.is_none(),
                |s: &mut App| s.approve_decision(),
            ));
        c = c.child(bar);
    }
    if d.conversation_id.is_some() {
        c = c.child(label("The agent proposed this in a chat. Open the Agent tab to see the conversation.", type_::XS, t.muted_foreground.alpha(0.8)));
    }
    c
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

fn stat(t: &Theme, key: &str, name: &str, value: String, dot: Option<Color>) -> El {
    let mut head = row().gap(6.0).center_y();
    if let Some(c) = dot {
        head = head.child(el().size(6.0, 6.0).radius(3.0).fill(c));
    }
    head = head.child(label(name, type_::SM_13, t.muted_foreground));
    shadows(
        col()
            .key(key)
            .grow(1.0)
            .min_w(140.0)
            .px(16.0)
            .py(12.0)
            .gap(6.0)
            .radius(12.0)
            .fill(t.card)
            .child(head)
            .child(label(value, type_::TITLE.features("'tnum' 1"), t.foreground)),
        &t.card_shadow,
    )
}

fn overview(s: &App, t: &Theme) -> El {
    let header = page_header(t, "Overview", "How AI assistants answer about this business, from the checks run so far.");
    let body = match &s.overview {
        Load::Ready(o) => {
            let now = format::now();
            row()
                .w_full()
                .gap(12.0)
                .flex_wrap()
                .child(stat(t, "stat-attention", "Needs attention", o.needs_attention.to_string(), Some(t.wrong)))
                .child(stat(t, "stat-unreviewed", "Not reviewed yet", o.unreviewed.to_string(), Some(t.review)))
                .child(stat(t, "stat-completed", "Checks completed", o.completed.to_string(), Some(t.supported)))
                .child(stat(t, "stat-last", "Last checked", format::relative(o.last_checked.as_deref(), now), None))
        }
        Load::Failed(e) => failure(t, "overview-failed", e, |s: &mut App| s.refresh()),
        _ => skeleton(t, 1),
    };
    let next = card(t)
        .px(20.0)
        .py(18.0)
        .gap(10.0)
        .child(label("Results, revenue and AI discovery", type_::SM_MEDIUM, t.foreground))
        .child(label("The full charts and the funnel are on the web for now. Ask the agent for a summary of what changed.", type_::SM_13, t.muted_foreground).wrap())
        .child(
            row().pt(4.0).child(
                button(t, "ask-summary", "Summarize this week", Variant::Outline)
                    .on_press(ask("Summarize what changed this week for this business: results, AI answers and channels.")),
            ),
        );
    col().w_full().gap(24.0).child(header).child(body).child(next)
}

fn campaigns(s: &App, t: &Theme) -> El {
    let header = page_header(t, "Campaigns", "Plans the agent drafted with you, and what was measured against each one.");
    let body = match &s.campaigns {
        Load::Ready(list) if list.is_empty() => empty_state(
            t,
            "campaigns-empty",
            &icons::BRIEFCASE,
            "No campaigns yet",
            "Plan one from an approved idea. The agent drafts it and asks before anything is published, sent or spent.",
            Some(button(t, "plan-campaign", "Plan a campaign with the agent", Variant::Outline).on_press(ask(
                "/campaign Plan a campaign for our most promising approved idea. Do not publish, send or spend without approval.",
            ))),
        ),
        Load::Ready(list) => {
            let now = format::now();
            let mut c = card(t).clip_rounded(12.0);
            let n = list.len();
            for (i, cp) in list.iter().enumerate() {
                let mut r = col()
                    .key(format!("campaign-{}", cp.id))
                    .w_full()
                    .px(18.0)
                    .py(16.0)
                    .gap(6.0)
                    .child(
                        row()
                            .gap(8.0)
                            .center_y()
                            .child(label(if cp.title.is_empty() { "Untitled campaign".to_string() } else { cp.title.clone() }, type_::SM_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0))
                            .child(status_chip(&title_case(&cp.stage), t.review, t.review_soft))
                            .child(label(format::relative(cp.updated_at.as_deref(), now), type_::XS, t.muted_foreground)),
                    );
                if !cp.goal.is_empty() {
                    r = r.child(label(cp.goal.clone(), type_::SM_13, t.muted_foreground).wrap().max_lines(2));
                }
                if i + 1 < n {
                    r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
                }
                c = c.child(r);
            }
            c
        }
        Load::Failed(e) => failure(t, "campaigns-failed", e, |s: &mut App| s.refresh()),
        _ => skeleton(t, 2),
    };
    col().w_full().gap(24.0).child(header).child(body)
}

fn tone(t: &Theme, state: &str) -> (Color, Color, &'static str) {
    match state {
        "WRONG" => (t.wrong, t.wrong_soft, "Wrong"),
        "PARTIAL" => (t.partial, t.partial_soft, "Partially correct"),
        "UNKNOWN" => (t.unknown, t.unknown_soft, "Not enough information"),
        _ => (t.review, t.review_soft, "Needs review"),
    }
}

fn ai_answers(s: &App, t: &Theme) -> El {
    let header = page_header(t, "AI answers", "Review open claims from AI answers. Each one shows what the assistant said and the question that drew it.");
    let body = match &s.issues {
        Load::Ready(list) => {
            let count = |st: &str| list.iter().filter(|i| i.state == st).count().to_string();
            let tiles = row()
                .w_full()
                .gap(12.0)
                .flex_wrap()
                .child(stat(t, "tile-all", "All open", list.len().to_string(), None))
                .child(stat(t, "tile-review", "Needs review", count("NEEDS_REVIEW"), Some(t.review)))
                .child(stat(t, "tile-wrong", "Wrong", count("WRONG"), Some(t.wrong)))
                .child(stat(t, "tile-partial", "Partially correct", count("PARTIAL"), Some(t.partial)))
                .child(stat(t, "tile-unknown", "Not enough information", count("UNKNOWN"), Some(t.unknown)));
            let rows = if list.is_empty() {
                empty_state(t, "issues-empty", &icons::CIRCLE_CHECK, "No open claims", "Every claim from the AI answers checked so far has been reviewed.", None)
            } else {
                let mut c = card(t).clip_rounded(12.0);
                let n = list.len();
                for (i, issue) in list.iter().enumerate() {
                    c = c.child(issue_row(t, issue, i + 1 < n));
                }
                c
            };
            col().w_full().gap(16.0).child(tiles).child(rows)
        }
        Load::Failed(e) => failure(t, "issues-failed", e, |s: &mut App| s.refresh()),
        _ => skeleton(t, 3),
    };
    col().w_full().gap(24.0).child(header).child(body)
}

fn issue_row(t: &Theme, i: &Issue, rule: bool) -> El {
    let (ink, soft, name) = tone(t, &i.state);
    let model = i.observed_model.clone().unwrap_or_else(|| i.provider.clone());
    let mut r = col()
        .key(format!("issue-{}", i.claim_id))
        .w_full()
        .px(18.0)
        .py(16.0)
        .gap(8.0)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(status_chip(name, ink, soft))
                .child(el().grow(1.0))
                .child(label(model, type_::XS, t.muted_foreground)),
        )
        .child(label(format!("“{}”", i.claim_text), type_::SM_MEDIUM, t.foreground).wrap());
    if let Some(q) = &i.question_prompt {
        r = r.child(
            row()
                .gap(6.0)
                .child(label("Asked", type_::XS_MEDIUM, t.muted_foreground))
                .child(label(q.clone(), type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(0.0)),
        );
    }
    if !i.answer_text.is_empty() {
        r = r.child(
            col()
                .w_full()
                .px(12.0)
                .py(10.0)
                .radius(8.0)
                .fill(t.accent.alpha(0.6))
                .child(label(i.answer_text.clone(), type_::SM_13, t.foreground.alpha(0.85)).wrap().max_lines(4)),
        );
    }
    if rule {
        r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
    }
    r
}

fn channels(s: &App, t: &Theme) -> El {
    let header = page_header(t, "Channels", "The accounts the agent works through, and what it can do with each one.");
    let body = match &s.channels {
        Load::Ready(list) if list.is_empty() => {
            empty_state(t, "channels-empty", &icons::PLUG, "No channels yet", "Connect a website or an account on the web to give the agent something to work with.", None)
        }
        Load::Ready(list) => {
            let mut c = card(t).clip_rounded(12.0);
            let n = list.len();
            for (i, ch) in list.iter().enumerate() {
                c = c.child(channel_row(t, ch, i + 1 < n));
            }
            c
        }
        Load::Failed(e) => failure(t, "channels-failed", e, |s: &mut App| s.refresh()),
        _ => skeleton(t, 3),
    };
    col().w_full().gap(24.0).child(header).child(body)
}

fn channel_row(t: &Theme, ch: &Channel, rule: bool) -> El {
    let (ink, soft, state) = match ch.state.as_str() {
        "CONNECTED" | "ACTIVE" => (t.supported, t.supported_soft, "Connected"),
        "DISCOVERED" => (t.review, t.review_soft, "Found"),
        "UNSUPPORTED" => (t.muted_foreground, t.accent, "Not available here"),
        "PERMISSION_REQUIRED" | "RECONNECT" => (t.partial, t.partial_soft, "Needs access"),
        _ => (t.muted_foreground, t.accent, "Not connected"),
    };
    let i: &'static rune::Icon = if ch.key == "website" { &icons::GLOBE } else { &icons::PLUG };
    let mut r = row()
        .key(format!("channel-{}", ch.key))
        .w_full()
        .px(18.0)
        .py(14.0)
        .gap(14.0)
        .items_start()
        .child(shadows(row().size(32.0, 32.0).radius(8.0).center().fill(t.control).child(ico(i, 16.0, t.foreground)), &t.control_shadow))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(3.0)
                .child(
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(label(ch.label.clone(), type_::SM_MEDIUM, t.foreground).truncate().min_w(0.0))
                        .child(status_chip(state, ink, soft)),
                )
                .child(label(ch.identity.clone().unwrap_or_default(), type_::XS, t.muted_foreground).truncate())
                .child(label(ch.note.clone(), type_::SM_13, t.muted_foreground).wrap()),
        );
    if rule {
        r = r.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
    }
    r
}

fn title_case(s: &str) -> String {
    let s = s.replace('_', " ").to_lowercase();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Draft".into(),
    }
}
