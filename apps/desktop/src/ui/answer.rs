//! One AI answer, in a popup over the AI answers list: which assistant
//! answered and when, the question and its answer with your brand picked out,
//! then the rating, what is true instead, and Save. Saving closes it.
//!
//! The frame is the Settings dialog's: a card on a soft scrim, closed by
//! Escape or a press outside it.

use rune::{Color, Cursor, El, ScrollSpec, Span, TextEdit, col, el, rich, row, text_input};

use crate::api::{AnswerDetail, Fact};
use crate::brands;
use crate::format;
use crate::icons;
use crate::state::{AnswerView, App, Load, VERDICTS};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, failure, ico, icon_button, label, skeleton};

pub fn dialog(s: &App, t: &Theme, k: &rune_kit::Kit, a: &AnswerView) -> Vec<El> {
    let (body, foot) = match &a.detail {
        Load::Ready(d) => (body(s, t, k, a, d), Some(footer(t, a, d))),
        Load::Failed(e) => {
            let claim = a.claim.clone();
            (col().w_full().padding(20.0).child(failure(t, "answer-failed", e, move |s: &mut App| s.open_answer(&claim))), None)
        }
        _ => (col().w_full().padding(20.0).child(skeleton(t, 3)), None),
    };
    // The Settings dialog's frame: the header and footer on the outer frame,
    // the answer and its rating in the inset panel between them.
    let inset = shadows(
        col()
            .key("answer-inset")
            .w_full()
            .radius(10.0)
            .fill(t.background)
            .clip_rounded(10.0)
            .child(col().key("answer-scroll").w_full().max_h(520.0).child(body).scroll(ScrollSpec { stick_bottom: false })),
        &t.panel_shadow,
    );
    let mut frame = col()
        .key("answer-dialog")
        .role("dialog")
        .label("AI answer")
        .w_full()
        .max_w(800.0)
        .padding(8.0)
        .radius(16.0)
        .fill(t.sidebar)
        .border(1.0, t.border)
        .child(header(s, t, a))
        .child(inset);
    if let Some(f) = foot {
        frame = frame.child(f);
    }
    let frame = shadows(frame, &t.float_shadow).modal(true, |s: &mut App| s.close_answer());
    vec![
        el().key("answer-scrim").absolute(0.0, 0.0).w_full().h_full().fill(Color::BLACK.alpha(0.25)).a11y_hidden(),
        el().key("answer-layer").absolute(0.0, 0.0).w_full().h_full().padding(16.0).center().child(frame),
    ]
}

fn state_ink(t: &Theme, verdict: &str) -> Color {
    match verdict {
        "SUPPORTED" => t.supported,
        "CONTRADICTED" => t.wrong,
        "PARTIAL" => t.partial,
        _ => t.unknown,
    }
}

/// The assistant that answered, when, and the way through the list.
fn header(s: &App, t: &Theme, a: &AnswerView) -> El {
    let issue = a.detail.ready().map(|d| &d.issue).or_else(|| s.issues.ready().and_then(|l| l.iter().find(|i| i.claim_id == a.claim)));
    let mut who = row().grow(1.0).min_w(0.0).gap(12.0).center_y();
    if let Some(i) = issue {
        let model = i.observed_model.clone().filter(|m| !m.is_empty());
        let when = format::relative(i.collected_at.as_deref(), format::now());
        who = who
            .child(brands::logo(t, &i.provider, 32.0))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(1.0)
                    .child(label(brands::brand(&i.provider).0, type_::SM_MEDIUM, t.foreground).role("heading"))
                    .child(label(model.map_or(when.clone(), |m| format!("{m}, {when}")), type_::XS, t.muted_foreground).truncate()),
            );
    }
    let mut r = row().key("answer-header").w_full().px(12.0).pt(6.0).pb(12.0).gap(4.0).center_y().child(who);
    if let Some(list) = s.issues.ready() {
        if let Some(at) = list.iter().position(|i| i.claim_id == a.claim) {
            r = r.child(label(format!("{} of {}", at + 1, list.len()), type_::XS.features("'tnum' 1"), t.muted_foreground).mr(4.0));
            for (key, i, name, step) in [("answer-prev", &icons::CHEVRON_LEFT, "Previous answer", -1), ("answer-next", &icons::CHEVRON_RIGHT, "Next answer", 1)] {
                let b = icon_button(t, key, i, name, false);
                r = r.child(match s.neighbour_answer(step) {
                    Some(id) => b.on_press(move |s: &mut App| s.open_answer(&id)),
                    None => b.opacity(0.4).cursor(Cursor::Default),
                });
            }
        }
    }
    r.child(el().w(4.0)).child(icon_button(t, "answer-close", &icons::X, "Close", false).on_press(|s: &mut App| s.close_answer()))
}

/// Byte ranges of `needle` in `hay`, ignoring case.
fn find_all(hay: &str, needle: &str) -> Vec<(usize, usize)> {
    if needle.trim().is_empty() {
        return vec![];
    }
    let (h, n) = (hay.to_lowercase(), needle.to_lowercase());
    if h.len() != hay.len() {
        return vec![];
    }
    h.match_indices(&n).map(|(at, m)| (at, at + m.len())).collect()
}

fn body(s: &App, t: &Theme, k: &rune_kit::Kit, a: &AnswerView, d: &AnswerDetail) -> El {
    let i = &d.issue;
    let brand = s.active_business().map(|b| b.name.clone()).unwrap_or_default();

    // The answer, with the brand picked out and the statement under review underlined.
    let claim = i.claim_text.trim();
    let found = (!claim.is_empty()).then(|| i.answer_text.find(claim)).flatten();
    // The full name, or its first word as answers usually shorten it ("Northstar" for "Northstar Analytics").
    let mut mentions = find_all(&i.answer_text, &brand);
    let mut shown = brand.clone();
    if mentions.is_empty() {
        if let Some(first) = brand.split_whitespace().next().filter(|w| w.len() >= 4 && *w != brand) {
            mentions = find_all(&i.answer_text, first);
            shown = first.to_string();
        }
    }
    let answer = if i.answer_text.is_empty() {
        label("The answer text was not kept.", type_::BASE.lh(26.0), t.muted_foreground).wrap()
    } else {
        let mut spans: Vec<Span> = mentions.iter().map(|&(a, b)| Span::new(a, b).weight(600.0).color(t.chart.primary)).collect();
        if let Some(at) = found {
            spans.push(Span::new(at, at + claim.len()).underline(t.muted_foreground));
        }
        spans.sort_by_key(|x| x.start);
        rich(i.answer_text.clone(), spans).font(type_::BASE.lh(26.0)).color(t.foreground).selectable(true).cursor(Cursor::Default)
    };
    let mut said = col().key("answer-quote").w_full().gap(6.0)
        .child(label(i.question_prompt.clone().map(|q| format!("Asked “{q}”")).unwrap_or_else(|| "Question not recorded".into()), type_::SM_13, t.muted_foreground).wrap())
        .child(answer.w_full());
    let mut legend = Vec::new();
    if !mentions.is_empty() {
        legend.push(format!("{shown} is highlighted"));
    }
    if found.is_some() && claim.len() < i.answer_text.trim().len() {
        legend.push("the underlined part is what you are rating".to_string());
    }
    if !legend.is_empty() {
        let text = legend.join(", ");
        let mut c = text.chars();
        said = said.child(label(c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() + ".", type_::XS, t.muted_foreground));
    }
    if !i.answer_text.is_empty() && found.is_none() {
        said = said.child(label(format!("You are rating: {}", i.claim_text), type_::SM_13, t.foreground).key("answer-claim").wrap().mt(4.0));
    }
    if !i.citation_evidence.is_empty() {
        let mut cited = row().key("answer-sources").w_full().gap(8.0).flex_wrap().center_y().mt(6.0);
        for (n, src) in i.citation_evidence.iter().enumerate() {
            let uri = src.uri.clone();
            let rest = src.uri.split_once("://").map_or(src.uri.as_str(), |(_, r)| r);
            let host = rest.split('/').next().unwrap_or(rest).trim_start_matches("www.").to_string();
            // The composer's pill: a rounded outline on the card.
            cited = cited.child(
                row()
                    .key(format!("source-{n}"))
                    .h(28.0)
                    .px(10.0)
                    .gap(6.0)
                    .radius(14.0)
                    .center_y()
                    .border(1.0, t.border)
                    .fill(t.card)
                    .hover(t.accent)
                    .role("link")
                    .focusable(true)
                    .label(host.clone())
                    .help(src.title.clone().filter(|x| !x.trim().is_empty()).map_or(src.uri.clone(), |x| format!("{x}\n{}", src.uri)))
                    .cursor(Cursor::Pointer)
                    .on_press_tx(move |s: &mut App, tx| s.open_link(&uri, tx))
                    .child(ico(&icons::LINK, 14.0, t.muted_foreground))
                    .child(label(host, type_::XS, t.foreground)),
            );
        }
        said = said.child(cited);
    }

    // The rating, as the app's segmented control.
    let mut track = row().key("verdict-options").w_full().h(36.0).padding(3.0).gap(2.0).radius(8.0).fill(t.accent).role("radiogroup").label("Is this right?");
    for &(value, name, _) in VERDICTS.iter() {
        let on = a.verdict == Some(value);
        let tab = row()
            .key(format!("verdict-{value}"))
            .w(0.0)
            .grow(1.0)
            .h_full()
            .gap(6.0)
            .radius(6.0)
            .center()
            .role("radio")
            .label(name)
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.pick_verdict(value))
            .child(el().size(6.0, 6.0).radius(3.0).fill(state_ink(t, value)))
            .child(label(name, type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }));
        track = track.child(if on { shadows(tab.fill(t.control), &t.control_shadow) } else { tab.hover(t.hover_tint) });
    }
    let hint = a.verdict.and_then(|v| VERDICTS.iter().find(|x| x.0 == v)).map_or("Compare it with what you know is true.", |x| x.2);
    let rate = col().key("answer-review").w_full().gap(8.0)
        .child(label("Is this right?", type_::SM_MEDIUM, t.foreground))
        .child(track)
        .child(label(hint, type_::XS, t.muted_foreground));

    // The correction, in the person's words.
    let (title, placeholder) = match a.verdict {
        Some("CONTRADICTED") | Some("PARTIAL") => ("What is true instead?", format!("The correct answer, such as what {} really offers", if brand.is_empty() { "you" } else { brand.as_str() })),
        Some("INSUFFICIENT_EVIDENCE") => ("What is missing?", "What you would need to know to rate it. Optional".to_string()),
        Some(_) => ("Note", "Anything your team should know. Optional".to_string()),
        None => ("Correction", "Pick a rating first, then write what is true".to_string()),
    };
    let correct = col().key("answer-correction").w_full().gap(8.0)
        .child(label(title, type_::SM_MEDIUM, t.foreground))
        .child(note_field(t, "verdict-notes", &a.notes, &placeholder, |s| &mut s.answer.as_mut().expect("answer open").notes))
        .child(fact_picker(t, k, a, &d.facts));

    let mut c = col().key("answer-body").w_full().padding(24.0).gap(24.0).child(said).child(rate).child(correct);
    if let Some(e) = &a.error {
        c = c.child(label(e.clone(), type_::SM_13, t.wrong).wrap().key("verdict-error").live_region(rune::LiveRegion::Polite));
    }
    if a.partial {
        c = c.child(label("Some details didn't load. Refresh to try again.", type_::XS, t.muted_foreground).wrap());
    }
    c
}

/// The approved facts that back the correction, ticked with the kit's checkbox.
fn fact_picker(t: &Theme, k: &rune_kit::Kit, a: &AnswerView, facts: &[Fact]) -> El {
    let mut c = col().key("answer-facts").w_full().gap(8.0).mt(4.0);
    if facts.is_empty() {
        return c.child(label("You have no approved facts yet. Add them on the web under Approved facts.", type_::XS, t.muted_foreground).wrap());
    }
    c = c.child(label("Backed by your approved facts", type_::XS, t.muted_foreground));
    for f in facts {
        let on = a.facts.contains(&f.id);
        let id = f.id.clone();
        let name = {
            let lower = f.predicate.replace('_', " ");
            let mut ch = lower.chars();
            ch.next().map(|x| x.to_uppercase().collect::<String>() + ch.as_str()).unwrap_or_default()
        };
        c = c.child(
            row().key(format!("fact-{}", f.id)).w_full().child(
                rune_kit::Checkbox::new(on)
                    .label(format!("{name}: {}", f.value_text))
                    .on_toggle(move |s: &mut App| s.toggle_verdict_fact(&id))
                    .build(k),
            ),
        );
    }
    c
}

/// Measure the editable paragraph, including its final empty line, before laying out the input.
fn note_field(t: &Theme, key: &str, edit: &TextEdit, hint: &str, access: fn(&mut App) -> &mut TextEdit) -> El {
    let style = type_::SM.lh(22.0);
    let shown = if edit.text.is_empty() { hint.to_string() } else { format!("{}\u{200b}", edit.text) };
    let measure = label(shown, style, t.muted_foreground).key(format!("{key}-measure"))
        .w_full().wrap().opacity(if edit.text.is_empty() { 1.0 } else { 0.0 }).a11y_hidden().inert();
    let input = text_input(edit, style).key(key.to_string())
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).w_full().h_full()
        .color(t.foreground).label("Correction")
        .on_edit(access).on_submit(move |s: &mut App, _| { access(s).insert("\n"); });
    shadows(col().key(format!("{key}-field")).w_full().px(12.0).py(10.0).radius(8.0).fill(t.control)
        .child(col().w_full().min_h(66.0).child(measure).child(input)), &t.control_shadow)
}

/// Ask the agent, at the left; Cancel and Save at the right.
fn footer(t: &Theme, a: &AnswerView, d: &AnswerDetail) -> El {
    let claim = d.issue.claim_text.clone();
    let request = format!("An AI assistant said \"{claim}\" about us. Work out why it says this, which of our sources would correct it, and prepare the fix for me to approve.");
    let ready = a.verdict.is_some() && !a.judging;
    let save = button(t, "verdict-record", if a.judging { "Saving…" } else { "Save" }, Variant::Primary).disabled(!ready);
    row()
        .key("answer-review-footer")
        .w_full()
        .px(4.0)
        .pt(10.0)
        .pb(2.0)
        .gap(8.0)
        .center_y()
        .child(button(t, "answer-ask", "Ask the agent to fix it", Variant::Ghost).on_press(move |s: &mut App| s.ask_agent(&request)))
        .child(el().grow(1.0))
        .child(button(t, "verdict-cancel", "Cancel", Variant::Outline).on_press(|s: &mut App| s.close_answer()))
        .child(if ready { save.on_press(|s: &mut App| s.record_verdict()) } else { save.opacity(0.5).cursor(Cursor::Default) })
}
