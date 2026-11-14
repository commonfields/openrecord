//! One AI answer's claim on its own page: what the assistant said, the facts
//! it was compared with, the verdict form, its sources and the actions
//! recorded for it. The web splits this between the issue page and the
//! observation's review form; here it is one page.

use rune::{Cursor, El, col, el, row, text_input};

use crate::api::{AnswerDetail, Fact, Intervention};
use crate::format;
use crate::icons;
use crate::state::{ACTION_KINDS, AnswerView, App, Load, VERDICTS};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, card, failure, ico, icon_button, label, skeleton, status_chip};

pub fn view(s: &App, t: &Theme, a: &AnswerView) -> El {
    let body = match &a.detail {
        Load::Ready(d) => detail(s, t, a, d),
        Load::Failed(e) => {
            let claim = a.claim.clone();
            failure(t, "answer-failed", e, move |s: &mut App| s.open_answer(&claim))
        }
        _ => skeleton(t, 3),
    };
    col().key("answer").w_full().gap(20.0).child(top_bar(s, t)).child(body)
}

/// Back to the list, and the claim's place in it with previous and next.
fn top_bar(s: &App, t: &Theme) -> El {
    let back = row()
        .key("answer-back")
        .gap(6.0)
        .h(28.0)
        .px(8.0)
        .radius(6.0)
        .center_y()
        .role("button")
        .label("Back to AI answers")
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .motion(CONTROL)
        .on_press(|s: &mut App| s.close_answer())
        .child(ico(&icons::ARROW_LEFT, 14.0, t.muted_foreground))
        .child(label("AI answers", type_::XS_MEDIUM, t.muted_foreground));
    let mut r = row().w_full().gap(4.0).center_y().child(back).child(el().grow(1.0));
    if let (Some(list), Some(a)) = (s.issues.ready(), &s.answer) {
        if let Some(at) = list.iter().position(|i| i.claim_id == a.claim) {
            r = r.child(label(format!("{} of {}", at + 1, list.len()), type_::XS, t.muted_foreground).mr(4.0));
            for (key, i, name, step) in [("answer-prev", &icons::ARROW_LEFT, "Previous answer", -1), ("answer-next", &icons::ARROW_RIGHT, "Next answer", 1)] {
                let b = icon_button(t, key, i, name, false);
                r = r.child(match s.neighbour_answer(step) {
                    Some(id) => b.on_press(move |s: &mut App| s.open_answer(&id)),
                    None => b.opacity(0.4).cursor(Cursor::Default),
                });
            }
        }
    }
    r
}

pub fn tone(t: &Theme, state: &str) -> (rune::Color, rune::Color, &'static str) {
    match state {
        "WRONG" => (t.wrong, t.wrong_soft, "Wrong"),
        "PARTIAL" => (t.partial, t.partial_soft, "Partly right"),
        "UNKNOWN" => (t.unknown, t.unknown_soft, "Can't tell"),
        "RESOLVED" => (t.supported, t.supported_soft, "Correct"),
        _ => (t.review, t.review_soft, "Not rated yet"),
    }
}

fn verdict_tone(t: &Theme, verdict: &str) -> (rune::Color, rune::Color) {
    match verdict {
        "SUPPORTED" => (t.supported, t.supported_soft),
        "CONTRADICTED" => (t.wrong, t.wrong_soft),
        "PARTIAL" => (t.partial, t.partial_soft),
        _ => (t.unknown, t.unknown_soft),
    }
}

fn verdict_label(v: &str) -> &'static str {
    VERDICTS.iter().find(|x| x.0 == v).map_or("Reviewed", |x| x.1)
}

fn section(t: &Theme, key: &str, title: &str, description: Option<&str>) -> El {
    let mut head = col().w_full().gap(2.0).px(18.0).pt(14.0).pb(12.0).child(label(title, type_::SM_MEDIUM, t.foreground).role("heading"));
    if let Some(d) = description {
        head = head.child(label(d, type_::XS, t.muted_foreground).wrap());
    }
    card(t).key(key).clip_rounded(12.0).child(head)
}

fn detail(s: &App, t: &Theme, a: &AnswerView, d: &AnswerDetail) -> El {
    let i = &d.issue;
    let (ink, soft, state) = tone(t, &i.state);
    let model = i.observed_model.clone().unwrap_or_else(|| i.provider.clone());
    let when = i.collected_at.as_deref().map(format::date_time).unwrap_or_default();
    let head = col()
        .w_full()
        .gap(10.0)
        .child(row().gap(8.0).center_y().flex_wrap().child(status_chip(t, state, ink, soft)).child(label(format!("{model}, {when}"), type_::XS, t.muted_foreground)))
        .child(label(format!("“{}”", i.claim_text), type_::TITLE, t.foreground).wrap().selectable(true).role("heading"));

    // What the assistant was asked and said.
    let mut answer = col().w_full().gap(10.0).px(18.0).py(14.0);
    if let Some(q) = &i.question_prompt {
        answer = answer.child(col().gap(2.0).child(label("Asked", type_::XS_MEDIUM, t.muted_foreground)).child(label(q.clone(), type_::SM_13, t.foreground).wrap().selectable(true)));
    }
    answer = answer.child(
        col()
            .w_full()
            .gap(2.0)
            .child(label("Answered", type_::XS_MEDIUM, t.muted_foreground))
            .child(label(if i.answer_text.is_empty() { "The answer text was not kept.".to_string() } else { i.answer_text.clone() }, type_::SM_13, t.foreground.alpha(0.9)).wrap().selectable(true)),
    );
    let answer = section(t, "answer-text", "The answer", None).child(answer);

    let main = col().grow(1.0).min_w(0.0).gap(16.0).child(answer).child(review(s, t, a, d)).child(actions(t, a, &d.actions));
    let side = col().w(340.0).gap(16.0).child(compared(t, d)).child(sources(t, d)).children(a.partial.then(|| {
        label("Some details didn't load. Refresh to try again.", type_::XS, t.muted_foreground).wrap()
    }));
    col()
        .w_full()
        .gap(20.0)
        .child(head)
        .child(ask_agent(t, i.claim_text.clone(), i.state.clone()))
        .child(row().w_full().gap(16.0).items_start().child(main).child(side))
}

/// Hands the agent a request to fix the claim, typed in and ready to send.
fn ask_agent(t: &Theme, claim: String, state: String) -> El {
    let request = if state == "RESOLVED" {
        format!("An AI assistant said \"{claim}\" about us, and it was reviewed as supported. Check it is still true and tell me if anything should change.")
    } else {
        format!("An AI assistant said \"{claim}\" about us. Work out why it says this, which of our sources would correct it, and prepare the fix for me to approve.")
    };
    row().w_full().child(button(t, "answer-ask", "Ask the agent to fix this", Variant::Outline).on_press(move |s: &mut App| {
        s.ask_agent(&request);
    }))
}

/// The verdict the claim has and the approved facts it was compared with.
fn compared(t: &Theme, d: &AnswerDetail) -> El {
    let i = &d.issue;
    let mut body = col().w_full().gap(10.0).px(18.0).py(14.0);
    body = body.child(match &i.verdict {
        Some(v) => {
            let (ink, soft) = verdict_tone(t, v);
            row().gap(8.0).center_y().child(label("Your rating", type_::XS_MEDIUM, t.muted_foreground)).child(status_chip(t, verdict_label(v), ink, soft))
        }
        None => label("Not rated yet. Rate it to link the facts it touches.", type_::SM_13, t.muted_foreground).wrap(),
    });
    if i.verdict.is_some() && i.facts.is_empty() {
        body = body.child(label("No fact was linked to this rating.", type_::XS, t.muted_foreground).wrap());
    }
    for f in &i.facts {
        body = body.child(fact_line(t, &f.predicate, &f.value_text, f.version));
    }
    if let Some(n) = i.notes.as_deref().filter(|n| !n.trim().is_empty()) {
        body = body.child(col().gap(2.0).child(label("Reviewer notes", type_::XS_MEDIUM, t.muted_foreground)).child(label(n.to_string(), type_::SM_13, t.foreground).wrap()));
    }
    section(t, "answer-compared", "Compared with approved facts", None).child(body)
}

fn fact_line(t: &Theme, predicate: &str, value: &str, version: i64) -> El {
    row()
        .w_full()
        .gap(8.0)
        .items_start()
        .child(label(predicate.replace('_', " "), type_::XS_MEDIUM, t.muted_foreground).w(110.0).wrap())
        .child(label(value.to_string(), type_::SM_13, t.foreground).wrap().grow(1.0).min_w(0.0))
        .child(label(format!("v{version}"), type_::XS, t.muted_foreground))
}

fn sources(t: &Theme, d: &AnswerDetail) -> El {
    let list = &d.issue.citation_evidence;
    let mut body = col().w_full().gap(8.0).px(18.0).py(14.0);
    if list.is_empty() {
        body = body.child(label("The answer cited no sources.", type_::SM_13, t.muted_foreground));
    }
    for (n, c) in list.iter().enumerate() {
        let uri = c.uri.clone();
        let name = c.title.clone().filter(|x| !x.trim().is_empty()).unwrap_or_else(|| c.uri.clone());
        body = body.child(
            col()
                .key(format!("source-{n}"))
                .w_full()
                .gap(1.0)
                .role("link")
                .label(name.clone())
                .cursor(Cursor::Pointer)
                .on_press_tx(move |s: &mut App, tx| {
                    s.open_link(&uri, tx);
                })
                .child(label(name, type_::SM_13, t.foreground).truncate())
                .child(label(format!("{}{}", host(&c.uri), if c.attributed { ", quoted in the answer" } else { "" }), type_::XS, t.muted_foreground).truncate()),
        );
    }
    section(t, "answer-sources", "Sources", None).child(body)
}

fn host(uri: &str) -> String {
    let rest = uri.split_once("://").map_or(uri, |(_, r)| r);
    rest.split('/').next().unwrap_or(rest).trim_start_matches("www.").to_string()
}

/// The verdict form, or the verdict it has with a way to change it.
fn review(s: &App, t: &Theme, a: &AnswerView, d: &AnswerDetail) -> El {
    let c = section(t, "answer-review", "Review", Some("Compare what the assistant said with your facts. Answers you mark correct leave this list."));
    if !a.reviewing {
        let v = d.issue.verdict.as_deref().unwrap_or_default();
        let (ink, soft) = verdict_tone(t, v);
        return c.child(
            row()
                .w_full()
                .gap(10.0)
                .px(18.0)
                .py(14.0)
                .center_y()
                .child(label("Recorded as", type_::SM_13, t.muted_foreground))
                .child(status_chip(t, verdict_label(v), ink, soft))
                .child(el().grow(1.0))
                .child(button(t, "change-verdict", "Change rating", Variant::Outline).on_press(|s: &mut App| s.start_review())),
        );
    }
    let mut body = col().w_full().gap(14.0).px(18.0).py(14.0);
    // The four verdicts, two to a row.
    let mut grid = row().w_full().gap(8.0).flex_wrap().role("radiogroup").label("Rating");
    for (value, name, hint) in VERDICTS {
        let on = a.verdict == Some(value);
        let (ink, soft) = verdict_tone(t, value);
        let mut opt = row()
            .key(format!("verdict-{value}"))
            .grow(1.0)
            .min_w(220.0)
            .gap(10.0)
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .items_start()
            .role("radio")
            .label(name)
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.pick_verdict(value))
            .child(el().mt(5.0).size(8.0, 8.0).radius(4.0).fill(ink))
            .child(col().gap(1.0).min_w(0.0).child(label(name, type_::SM_MEDIUM, t.foreground)).child(label(hint, type_::XS, t.muted_foreground).wrap()));
        opt = if on { opt.fill(soft).border(1.0, ink.alpha(0.5)) } else { shadows(opt.fill(t.control).hover(t.hover_tint), &t.control_shadow) };
        grid = grid.child(opt);
    }
    body = body.child(col().w_full().gap(6.0).child(label("Rating", type_::XS_MEDIUM, t.muted_foreground)).child(grid));
    body = body.child(fact_picker(t, a, &d.facts));
    let notes = text_input(&a.notes, type_::SM)
        .key("verdict-notes")
        .placeholder("Optional. A note for your team", t.muted_foreground)
        .label("Reviewer notes")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.answer.as_mut().expect("answer open").notes);
    body = body.child(col().w_full().gap(6.0).child(label("Notes", type_::XS_MEDIUM, t.muted_foreground)).child(field(t, notes)));
    if let Some(e) = &a.error {
        body = body.child(label(e.clone(), type_::SM_13, t.wrong).wrap().key("verdict-error").live_region(rune::LiveRegion::Polite));
    }
    let ready = a.verdict.is_some() && !a.judging;
    let mut bar = row().w_full().gap(8.0).center_y().child(el().grow(1.0));
    if d.issue.verdict.is_some() {
        bar = bar.child(button(t, "verdict-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.cancel_review()));
    }
    let submit = button(t, "verdict-record", if a.judging { "Saving…" } else { "Save rating" }, Variant::Primary).disabled(!ready);
    bar = bar.child(if ready { submit.on_press(|s: &mut App| s.record_verdict()) } else { submit.opacity(0.5).cursor(Cursor::Default) });
    let _ = s;
    c.child(body.child(bar))
}

fn fact_picker(t: &Theme, a: &AnswerView, facts: &[Fact]) -> El {
    let mut c = col().w_full().gap(6.0).child(label("Facts this touches", type_::XS_MEDIUM, t.muted_foreground));
    if facts.is_empty() {
        return c.child(label("No facts yet. Add them on the web under Approved facts, or rate it Can't tell.", type_::SM_13, t.muted_foreground).wrap());
    }
    let mut list = col().w_full().gap(2.0);
    for f in facts {
        let on = a.facts.contains(&f.id);
        let id = f.id.clone();
        let mark = row().size(16.0, 16.0).radius(4.0).center().fill(if on { t.primary } else { t.control }).children(on.then(|| ico(&icons::CHECK, 12.0, t.primary_foreground)));
        let mark = if on { mark } else { shadows(mark, &t.control_shadow) };
        list = list.child(
            row()
                .key(format!("fact-{}", f.id))
                .w_full()
                .gap(10.0)
                .px(8.0)
                .py(6.0)
                .radius(6.0)
                .center_y()
                .role("checkbox")
                .label(format!("{} {}", f.predicate.replace('_', " "), f.value_text))
                .checked(on)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.toggle_verdict_fact(&id))
                .child(mark)
                .child(fact_line(t, &f.predicate, &f.value_text, f.version).grow(1.0).min_w(0.0)),
        );
    }
    c = c.child(list);
    c
}

fn field(t: &Theme, input: El) -> El {
    shadows(row().w_full().h(36.0).px(12.0).radius(8.0).center_y().fill(t.control).child(input), &t.control_shadow)
}

/// The hand-kept log of what was done about the claim.
fn actions(t: &Theme, a: &AnswerView, list: &[Intervention]) -> El {
    let toggle = button(t, "record-action", if a.recording { "Close" } else { "Log what you did" }, Variant::Outline).h(28.0).px(10.0).on_press_tx(|s: &mut App, tx| s.toggle_record_action(tx));
    let head = row()
        .w_full()
        .gap(10.0)
        .px(18.0)
        .pt(14.0)
        .pb(12.0)
        .center_y()
        .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label("What you did about it", type_::SM_MEDIUM, t.foreground).role("heading")).child(label("A hand-kept log. It changes no verdict and no observation.", type_::XS, t.muted_foreground).wrap()))
        .child(toggle);
    let mut body = col().w_full().gap(12.0).px(18.0).py(14.0);
    if a.recording {
        body = body.child(action_form(t, a));
    }
    if list.is_empty() {
        body = body.child(label("Nothing logged yet.", type_::SM_13, t.muted_foreground));
    }
    let superseded: std::collections::BTreeSet<&str> = list.iter().filter_map(|x| x.supersedes_id.as_deref()).collect();
    for x in list {
        let kind = ACTION_KINDS.iter().find(|k| k.0 == x.kind).map_or(x.kind.as_str(), |k| k.1);
        let mut line = row().gap(8.0).center_y().flex_wrap().child(status_chip(t, kind, t.muted_foreground, t.accent)).child(label(x.target.clone(), type_::SM_13, t.foreground).wrap().min_w(0.0));
        if superseded.contains(x.id.as_str()) {
            line = line.child(label("superseded, history only", type_::XS, t.muted_foreground));
        }
        let mut item = col().key(format!("action-{}", x.id)).w_full().gap(4.0).child(line);
        if let Some(n) = x.notes.as_deref().filter(|n| !n.trim().is_empty()) {
            item = item.child(label(n.to_string(), type_::XS, t.muted_foreground).wrap());
        }
        if let Some(at) = &x.performed_at {
            item = item.child(label(format::date_time(at), type_::XS, t.muted_foreground));
        }
        body = body.child(item);
    }
    card(t).key("answer-actions").clip_rounded(12.0).child(head).child(body)
}

fn action_form(t: &Theme, a: &AnswerView) -> El {
    let mut kinds = row().w_full().gap(6.0).flex_wrap().role("radiogroup").label("Action type");
    for (n, (_, name)) in ACTION_KINDS.iter().enumerate() {
        let on = a.action_kind == n;
        let chip = row()
            .key(format!("action-kind-{n}"))
            .h(28.0)
            .px(10.0)
            .radius(14.0)
            .center()
            .role("radio")
            .label(*name)
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .fill(if on { t.primary } else { t.control })
            .on_press(move |s: &mut App| s.pick_action_kind(n))
            .child(label(*name, type_::XS_MEDIUM, if on { t.primary_foreground } else { t.foreground }));
        kinds = kinds.child(if on { chip } else { shadows(chip, &t.control_shadow) });
    }
    let target = text_input(&a.action_target, type_::SM)
        .key("action-target")
        .placeholder("What changed, such as https://example.com/pricing", t.muted_foreground)
        .label("Target")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.answer.as_mut().expect("answer open").action_target)
        .on_submit(|s: &mut App, _| s.save_action());
    let notes = text_input(&a.action_notes, type_::SM)
        .key("action-notes")
        .placeholder("Optional. What was done, in one line.", t.muted_foreground)
        .label("Action notes")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.answer.as_mut().expect("answer open").action_notes)
        .on_submit(|s: &mut App, _| s.save_action());
    let ready = !a.action_target.text.trim().is_empty() && !a.saving_action;
    let save = button(t, "action-save", if a.saving_action { "Saving…" } else { "Save" }, Variant::Primary).disabled(!ready);
    let mut c = col()
        .key("action-form")
        .w_full()
        .gap(10.0)
        .padding(12.0)
        .radius(10.0)
        .fill(t.accent.alpha(0.5))
        .child(kinds)
        .child(field(t, target))
        .child(field(t, notes));
    if let Some(e) = &a.action_error {
        c = c.child(label(e.clone(), type_::SM_13, t.wrong).wrap().live_region(rune::LiveRegion::Polite));
    }
    c.child(
        row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(label("Recheck the AI afterward to compare.", type_::XS, t.muted_foreground).grow(1.0).min_w(0.0))
            .child(if ready { save.on_press(|s: &mut App| s.save_action()) } else { save.opacity(0.5).cursor(Cursor::Default) }),
    )
}
