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
        Page::Overview => crate::ui::overview::view(s, t),
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
    if d.conversation_id.is_some() {
        body = body.child(label("The agent suggested this in a chat. Open Agent to see the conversation.", type_::XS, t.muted_foreground.alpha(0.8)));
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

fn ai_answers(s: &App, t: &Theme) -> El {
    if let Some(a) = &s.answer {
        return crate::ui::answer::view(s, t, a);
    }
    let header = page_header(t, "AI answers", "What AI assistants said about you that still needs a look, with the question that prompted it.");
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
                .child(stat(t, "tile-partial", "Partly right", count("PARTIAL"), Some(t.partial)))
                .child(stat(t, "tile-unknown", "Can't tell", count("UNKNOWN"), Some(t.unknown)));
            let rows = if list.is_empty() {
                empty_state(t, "issues-empty", &icons::CIRCLE_CHECK, "All caught up", "Every answer checked so far has been rated.", None)
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
    let (ink, soft, name) = crate::ui::answer::tone(t, &i.state);
    let model = i.observed_model.clone().unwrap_or_else(|| i.provider.clone());
    let claim = i.claim_id.clone();
    let mut r = col()
        .key(format!("issue-{}", i.claim_id))
        .role("button")
        .label(format!("Open: {}", i.claim_text))
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .on_press(move |s: &mut App| s.open_answer(&claim))
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
                .child(label(model, type_::XS, t.muted_foreground))
                .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground)),
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
    let header = page_header(t, "Channels", "The services OpenRecord works with for this business, and what it can do in each.");
    let body = match &s.channels {
        Load::Ready(list) if list.is_empty() => {
            empty_state(t, "channels-empty", &icons::PLUG, "Nothing connected yet", "Add your website or connect an account on the web to get started.", None)
        }
        Load::Ready(list) => {
            let group = |c: &Channel| match c.state.as_str() {
                "CONNECTED" | "ACTIVE" => 0,
                "PERMISSION_REQUIRED" | "RECONNECT" | "UNHEALTHY" | "REVOKED" => 1,
                "DISCOVERED" => 2,
                _ => 3,
            };
            let count = |g: usize| list.iter().filter(|c| group(c) == g).count();
            let stat = |key: &str, name: &str, n: usize, dot: Color| {
                card(t).key(key.to_string()).w(0.0).grow(1.0).min_w(160.0).h(88.0).px(18.0).py(14.0).gap(6.0)
                    .child(row().gap(8.0).center_y().child(el().size(8.0, 8.0).radius(4.0).fill(dot)).child(label(name.to_string(), type_::XS_MEDIUM, t.muted_foreground)))
                    .child(label(n.to_string(), rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1"), t.foreground))
            };
            let mut c = col().w_full().gap(32.0).child(
                row().w_full().gap(16.0).flex_wrap()
                    .child(stat("ch-connected", "Connected", count(0), t.supported))
                    .child(stat("ch-attention", "Needs your attention", count(1), t.partial))
                    .child(stat("ch-found", "Found on your website", count(2), t.review))
                    .child(stat("ch-unavailable", "Not available yet", count(3), t.muted_foreground.alpha(0.5))),
            );
            let business = s.active.clone().unwrap_or_default();
            for (g, title) in [(0, "Connected"), (1, "Needs your attention"), (2, "Found on your website"), (3, "Not available yet")] {
                let items: Vec<&Channel> = list.iter().filter(|c| group(c) == g).collect();
                if items.is_empty() {
                    continue;
                }
                let mut grid = row().w_full().gap(16.0).flex_wrap();
                for ch in items {
                    grid = grid.child(channel_card(t, ch, &business));
                }
                c = c.child(col().w_full().gap(12.0).child(label(title, type_::SM_MEDIUM, t.foreground).role("heading")).child(grid));
            }
            c
        }
        Load::Failed(e) => failure(t, "channels-failed", e, |s: &mut App| s.refresh()),
        _ => skeleton(t, 3),
    };
    col().w_full().gap(24.0).child(header).child(body)
}

/// What OpenRecord can do through a channel, in plain words.
fn capability(c: &str) -> &'static str {
    match c {
        "READ" => "Reads your numbers",
        "MEASURE" => "Tracks results",
        "DISCOVER" => "Finds pages",
        "PROPOSE" => "Suggests fixes",
        "VERIFY" => "Checks fixes",
        "EXECUTE" => "Publishes changes",
        _ => "Works with it",
    }
}

/// One service on a fixed-size card: its logo and state, the account, a short
/// note, what OpenRecord does with it, and where to manage it.
fn channel_card(t: &Theme, ch: &Channel, business: &str) -> El {
    let (ink, soft, state) = match ch.state.as_str() {
        "CONNECTED" | "ACTIVE" => (t.supported, t.supported_soft, "Connected"),
        "DISCOVERED" => (t.review, t.review_soft, "Found"),
        "UNSUPPORTED" => (t.muted_foreground, t.accent, "Not available yet"),
        "PERMISSION_REQUIRED" => (t.partial, t.partial_soft, "Needs access"),
        "RECONNECT" | "UNHEALTHY" | "REVOKED" => (t.partial, t.partial_soft, "Reconnect"),
        _ => (t.muted_foreground, t.accent, "Not connected"),
    };
    let mark = match crate::channel_marks::for_channel(&ch.key) {
        Some(i) => rune::icon(i, 20.0).color(t.foreground),
        None if ch.key == "profile:EMAIL" => ico(&icons::MAIL, 20.0, t.muted_foreground),
        None => ico(&icons::GLOBE, 20.0, t.muted_foreground),
    };
    let connected = matches!(ch.state.as_str(), "CONNECTED" | "ACTIVE");
    let mut abilities = row().gap(6.0).flex_wrap();
    for a in ch.active.iter().take(3) {
        abilities = abilities.child(row().h(22.0).px(8.0).radius(6.0).center().fill(t.accent).child(label(capability(a), type_::XS2.lh(14.0), t.muted_foreground)));
    }
    let path = format!("/businesses/{business}/channels");
    let action = button(t, &format!("channel-open-{}", ch.key), if connected { "Manage" } else if ch.state == "UNSUPPORTED" { "Learn more" } else { "Connect" }, Variant::Outline)
        .h(30.0)
        .on_press_tx(move |_s: &mut App, tx| {
            let api = std::env::var(crate::state::API_ENV).unwrap_or_else(|_| crate::state::DEFAULT_API.into());
            let _ = tx.open_url(&format!("{}{path}", crate::ui::web_url(&api)));
        });
    card(t)
        .key(format!("channel-{}", ch.key))
        .w(344.0)
        .h(184.0)
        .px(18.0)
        .py(16.0)
        .gap(10.0)
        .child(
            row().w_full().gap(12.0).center_y()
                .child(shadows(row().size(40.0, 40.0).radius(10.0).center().fill(t.accent.alpha(0.7)).child(mark), &t.control_shadow))
                .child(col().grow(1.0).min_w(0.0).gap(2.0)
                    .child(label(ch.label.clone(), type_::SM_MEDIUM, t.foreground).truncate())
                    .child(label(ch.identity.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| "No account linked".into()), type_::XS, t.muted_foreground).truncate()))
                .child(status_chip(state, ink, soft)),
        )
        .child(label(ch.note.clone(), type_::XS.lh(18.0), t.muted_foreground).wrap().max_lines(2))
        .child(el().grow(1.0))
        .child(row().w_full().gap(8.0).center_y().child(abilities.grow(1.0).min_w(0.0)).child(action))
}

fn title_case(s: &str) -> String {
    let s = s.replace('_', " ").to_lowercase();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Draft".into(),
    }
}
