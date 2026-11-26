//! The campaign brief as one page: the campaign in the person's own words,
//! which the agent can turn into the essential lines, those lines themselves,
//! the deliverables as short rows, and everything else folded under "More
//! detail". Every line can be typed into directly; nothing saves until Save.
use super::campaigns::campaign_button as button;
use super::inbox::{pill, quiet};
use super::kit;
use super::widgets::{CONTROL, Variant, ico, label};
use crate::campaign_edit::{Editor, FIELDS, TaskEdit};
use crate::icons;
use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use rune::{Cursor, El, ScrollSpec, TextEdit, TextStyle, col, el, row, text_input};
use serde_json::json;

/// The lines a brief stands on, in the order a marketer reads them.
const ESSENTIALS: [(&str, &str, &str); 6] = [
    ("Goal", "goal", "What should change, by how much, by when?"),
    ("Who", "audience", "One specific group this is for"),
    ("Offer", "offer", "What they get, and what they should do"),
    ("Message", "message", "The one thing they should believe"),
    ("Where", "primaryChannel", "Channels, such as LinkedIn ads and the email list"),
    ("Measure", "metric", "What is counted, and where"),
];

/// Lines kept out of the way under "More detail".
const DETAIL: [&str; 11] = ["hypothesis", "destination", "rationale", "conversionEvent", "trackingPlan", "cadence", "budget", "owner", "result", "learning", "nextMove"];

type Access = Box<dyn Fn(&mut App) -> &mut TextEdit>;

fn field_at(i: usize) -> Access {
    Box::new(move |s: &mut App| &mut s.campaign_editor.as_mut().expect("editor open").fields[i])
}

/// Text that edits in place, as tall as what it shows (Rune measures an empty
/// input as one line even when its placeholder wraps).
fn editable(t: &Theme, name: &str, hint: &str, edit: &TextEdit, key: String, style: TextStyle, access: Access) -> El {
    let shown = label(if edit.text.is_empty() { hint } else { &edit.text }, style, t.muted_foreground.alpha(0.8))
        .key(format!("{key}-measure"))
        .w_full()
        .wrap()
        .opacity(if edit.text.is_empty() { 1.0 } else { 0.0 })
        .a11y_hidden()
        .inert();
    let text = text_input(edit, style)
        .key(key)
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .w_full()
        .h_full()
        .color(t.foreground)
        .label(name.to_string())
        .help(hint.to_string())
        .on_edit(move |s: &mut App| access(s));
    col().w_full().min_w(0.0).child(shown).child(text)
}

/// A labelled field as "More detail" lists them: the name over the text.
fn stacked(t: &Theme, e: &Editor, key: &str) -> El {
    let i = e.field(key);
    let f = &FIELDS[i];
    col().w_full().gap(4.0)
        .child(label(f.name, type_::XS_MEDIUM, t.muted_foreground))
        .child(editable(t, f.name, f.hint, &e.fields[i], format!("cp-edit-{key}"), type_::SM.lh(22.0), field_at(i)))
}

/// One essential line: its name at the left, the words beside it.
fn line(t: &Theme, name: &str, body: El, k: usize) -> El {
    row().key(format!("cp-line-{k}")).w_full().min_h(44.0).py(11.0).gap(16.0).items_start()
        .child(label(name.to_string(), type_::SM_13, t.muted_foreground).w(76.0).pt(1.0))
        .child(col().grow(1.0).min_w(0.0).child(body))
}

fn choices(t: &Theme, name: &str, values: &[(&'static str, &'static str)], current: &str, set: fn(&mut Editor, String)) -> El {
    let mut r = row().w_full().gap(6.0).flex_wrap();
    for &(value, title) in values {
        r = r.child(
            button(t, &format!("cp-choice-{name}-{value}"), title, if current == value { Variant::Outline } else { Variant::Ghost })
                .on_press(move |s: &mut App| {
                    if let Some(e) = s.campaign_editor.as_mut().filter(|e| !e.busy) {
                        set(e, value.into());
                    }
                }),
        );
    }
    col().w_full().gap(6.0).child(label(name.to_string(), type_::XS_MEDIUM, t.muted_foreground)).child(r)
}

/// The campaign in the person's own words, and the button that fills the lines from it.
fn describe(t: &Theme, e: &Editor) -> El {
    let mut fill = pill(t, "brief-fill", if e.suggesting { "Filling in…" } else { "Fill in the brief" }, true, !e.suggesting && !e.describe.text.trim().is_empty());
    if !e.suggesting {
        fill = fill.on_press(|s: &mut App| s.suggest_campaign_brief());
    }
    let words = editable(
        t,
        "Describe the campaign",
        "Describe the campaign in your own words: who it's for, what you're offering, where it runs and what success looks like.",
        &e.describe,
        "cp-describe".into(),
        type_::SM.lh(22.0),
        Box::new(|s: &mut App| &mut s.campaign_editor.as_mut().expect("editor open").describe),
    );
    let foot = row().w_full().gap(12.0).center_y()
        .child(label(e.suggest_note.clone().unwrap_or_else(|| "The agent fills in the empty lines below. You check them, then save.".into()), type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(0.0).live_region(rune::LiveRegion::Polite))
        .child(fill);
    col().key("cp-describe-box").w_full().radius(20.0).fill(t.accent).padding(6.0).child(
        shadows(col().w_full().radius(15.0).fill(t.control).px(16.0).pt(14.0).pb(12.0).gap(14.0).child(words.min_h(66.0)).child(foot), &t.control_shadow),
    )
}

/// The essential lines, the target and dates among them.
fn essentials(t: &Theme, e: &Editor) -> El {
    let mut c = col().key("cp-essentials").w_full();
    for (k, (name, key, hint)) in ESSENTIALS.into_iter().enumerate() {
        let i = e.field(key);
        c = c.child(line(t, name, editable(t, name, hint, &e.fields[i], format!("cp-edit-{key}"), type_::SM.lh(22.0), field_at(i)), k));
    }
    let short = |key: &str, hint: &str, w: Option<f32>| {
        let i = e.field(key);
        let f = editable(t, FIELDS[i].name, hint, &e.fields[i], format!("cp-edit-{key}"), type_::SM.lh(22.0), field_at(i));
        match w { Some(w) => f.w(w).min_w(w), None => f }
    };
    let quiet_word = |w: &str| label(w.to_string(), type_::SM, t.muted_foreground);
    c.child(line(t, "Target", short("target", "The number to reach", None), 6))
        .child(line(t, "Today", short("baseline", "Where it stands now, or why that's unknown", None), 8))
        .child(line(t, "Dates", row().w_full().gap(8.0).items_start().flex_wrap().child(short("launchDate", "Launch YYYY-MM-DD", Some(150.0))).child(quiet_word("to")).child(short("reviewDate", "Review YYYY-MM-DD", Some(150.0))), 7))
}

const STATUSES: [(&str, &str); 4] = [("TODO", "To do"), ("IN_PROGRESS", "In progress"), ("DONE", "Done"), ("BLOCKED", "Blocked")];
const CHANNELS: [(&str, &str); 5] = [("WEBSITE", "Website"), ("EMAIL", "Email"), ("PAID", "Paid"), ("SOCIAL", "Social"), ("OTHER", "Other")];

fn next_of(list: &[(&'static str, &'static str)], current: &str) -> &'static str {
    let at = list.iter().position(|(v, _)| *v == current).unwrap_or(0);
    list[(at + 1) % list.len()].0
}

/// A deliverable as one row; its state and channel change with a press each.
fn deliverable(t: &Theme, e: &Editor, i: usize, task: &TaskEdit) -> El {
    let (ink, soft) = match task.status.as_str() {
        "DONE" => (t.supported, t.supported_soft),
        "IN_PROGRESS" => (t.review, t.review_soft),
        "BLOCKED" => (t.wrong, t.wrong_soft),
        _ => (t.muted_foreground, t.foreground.alpha(0.06)),
    };
    let state = STATUSES.iter().find(|(v, _)| *v == task.status).map_or("To do", |(_, n)| n);
    let channel = CHANNELS.iter().find(|(v, _)| *v == task.channel).map_or("Other", |(_, n)| n);
    let chip = |key: String, text: &str, ink, soft, help: &str, min: f32| {
        row().key(key).h(24.0).min_w(min).px(9.0).radius(12.0).center().fill(soft).role("button").label(format!("{text}, {help}")).help(help.to_string())
            .focusable(true).cursor(Cursor::Pointer).motion(CONTROL)
            .child(label(text.to_string(), type_::XS_MEDIUM, ink))
    };
    let small = |what: &'static str, hint: &str, edit: &TextEdit, w: f32| {
        editable(t, what, hint, edit, format!("cp-task-{i}-{}", what.to_lowercase()), type_::SM_13.lh(20.0), Box::new(move |s: &mut App| {
            let task = &mut s.campaign_editor.as_mut().expect("editor open").tasks[i];
            match what { "Owner" => &mut task.owner, "Due" => &mut task.due, _ => &mut task.title }
        })).w(w).min_w(w)
    };
    let set = |f: fn(&mut TaskEdit)| move |s: &mut App| {
        if let Some(e) = s.campaign_editor.as_mut().filter(|e| !e.busy) {
            f(&mut e.tasks[i]);
        }
    };
    let _ = e;
    let title = editable(t, "Deliverable", "Landing page, three ads, a follow-up email…", &task.title, format!("cp-task-{i}-title"), type_::SM_13.lh(20.0),
        Box::new(move |s: &mut App| &mut s.campaign_editor.as_mut().expect("editor open").tasks[i].title));
    let remove = row().key(format!("cp-task-{i}-remove")).size(24.0, 24.0).radius(12.0).center().role("button").label("Remove deliverable").help("Remove deliverable")
        .focusable(true).cursor(Cursor::Pointer).hover(t.hover_tint)
        .on_press(move |s: &mut App| {
            if let Some(e) = s.campaign_editor.as_mut().filter(|e| !e.busy) {
                e.tasks.remove(i);
            }
        })
        .child(ico(&icons::X, 13.0, t.muted_foreground));
    // The title on the first line; who, when and where under it.
    let meta = row().w_full().gap(8.0).center_y().flex_wrap()
        .child(small("Owner", "Owner", &task.owner, 96.0))
        .child(small("Due", "Due YYYY-MM-DD", &task.due, 118.0))
        .child(chip(format!("cp-task-{i}-channel"), channel, t.muted_foreground, t.foreground.alpha(0.06), "Press for the next channel", 64.0).on_press(set(|x| x.channel = next_of(&CHANNELS, &x.channel).into())));
    row().key(format!("cp-edit-task-{i}")).w_full().px(14.0).py(10.0).gap(10.0).items_start().radius(14.0).fill(t.foreground.alpha(0.035))
        .child(chip(format!("cp-task-{i}-status"), state, ink, soft, "Press for the next state", 84.0).on_press(set(|x| x.status = next_of(&STATUSES, &x.status).into())))
        .child(col().w(0.0).grow(1.0).min_w(0.0).gap(6.0).pt(2.0).child(title).child(meta))
        .child(remove)
}

fn section(t: &Theme, name: &str, right: Option<El>) -> El {
    row().w_full().pt(8.0).gap(12.0).center_y().child(label(name.to_string(), type_::SM_MEDIUM, t.foreground).role("heading")).child(el().grow(1.0)).children(right)
}

fn more(t: &Theme, e: &Editor) -> El {
    let toggle = quiet(t, "brief-more", if e.more { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, "More detail")
        .expanded(e.more)
        .self_start()
        .ml(-8.0)
        .on_press(|s: &mut App| {
            if let Some(e) = &mut s.campaign_editor {
                e.more = !e.more;
            }
        });
    let mut c = col().key("cp-more-detail").w_full().gap(12.0).child(
        row().w_full().gap(10.0).center_y().child(toggle).children((!e.more).then(|| label("Hypothesis, landing page, tracking, budget, owner, status and results", type_::XS, t.muted_foreground).truncate().min_w(0.0))),
    );
    if !e.more {
        return c;
    }
    let mut body = col().w_full().gap(18.0).pl(2.0);
    for key in DETAIL {
        body = body.child(stacked(t, e, key));
    }
    body = body
        .child(choices(t, "Motion", &[("UNSPECIFIED", "Not set"), ("OWNED", "Owned"), ("EARNED", "Earned"), ("PAID", "Paid"), ("PRODUCT_LED", "Product-led"), ("HYBRID", "Hybrid")], &e.motion, |e, v| e.motion = v))
        .child(choices(t, "Funnel stage", &[("UNSPECIFIED", "Not set"), ("AWARENESS", "Awareness"), ("CONSIDERATION", "Consideration"), ("CONVERSION", "Conversion"), ("ACTIVATION", "Activation"), ("RETENTION", "Retention"), ("EXPANSION", "Expansion"), ("REFERRAL", "Referral")], &e.funnel, |e, v| e.funnel = v))
        .child(choices(t, "Recorded status", &[("DRAFT", "Draft"), ("ACTIVE", "Active"), ("REVIEW", "Review"), ("CLOSED", "Closed")], &e.status, |e, v| e.status = v))
        .child(choices(t, "Decision", &[("UNDECIDED", "Undecided"), ("KEEP", "Keep"), ("CHANGE", "Change"), ("STOP", "Stop"), ("INCONCLUSIVE", "Inconclusive")], &e.decision, |e, v| e.decision = v))
        .child(kit::note(t, "Status is your team's record. Saving never publishes, sends, spends or schedules a review."));
    for (i, task) in e.tasks.iter().enumerate() {
        let name = if task.title.text.trim().is_empty() { format!("Deliverable {}", i + 1) } else { task.title.text.clone() };
        body = body.child(col().w_full().gap(4.0)
            .child(label(format!("Notes for {name}"), type_::XS_MEDIUM, t.muted_foreground).truncate())
            .child(editable(t, "Draft, dependencies and handoff notes", "Draft reference, approval needed, blocker or dependency", &task.note, format!("cp-task-{i}-note"), type_::SM.lh(22.0),
                Box::new(move |s: &mut App| &mut s.campaign_editor.as_mut().expect("editor open").tasks[i].note))));
    }
    c = c.child(body);
    c
}

pub fn view(s: &App, t: &Theme) -> El {
    let e = s.campaign_editor.as_ref().expect("campaign editor open");
    let title_at = e.field("title");
    let status = match e.status.as_str() { "ACTIVE" => "Active", "REVIEW" => "In review", "CLOSED" => "Closed", _ => "Draft" };
    let head = row().w_full().gap(12.0).items_start()
        .child(col().grow(1.0).min_w(0.0).child(editable(t, "Campaign name", "Untitled campaign", &e.fields[title_at], "cp-edit-title".into(), TextStyle::new(24.0, 600.0).lh(32.0), field_at(title_at))))
        .child(row().mt(6.0).h(22.0).px(9.0).radius(11.0).center().fill(t.review_soft).child(label(status, type_::XS_MEDIUM, t.review)));

    let mut tasks = col().key("cp-deliverables").w_full().gap(6.0);
    for (i, task) in e.tasks.iter().enumerate() {
        tasks = tasks.child(deliverable(t, e, i, task));
    }
    let add = quiet(t, "brief-add-task", &icons::PLUS, "Add deliverable").ml(-8.0).self_start().on_press(|s: &mut App| {
        if let Some(e) = s.campaign_editor.as_mut().filter(|e| !e.busy && e.tasks.len() < 100) {
            e.tasks.push(TaskEdit::new(json!({})));
        }
    });
    let (done, total) = (e.tasks.iter().filter(|x| x.status == "DONE").count(), e.tasks.len());

    let document = col()
        .key("campaign-document")
        .w_full()
        .max_w(720.0)
        .gap(20.0)
        .child(head)
        .child(describe(t, e))
        .child(col().w_full().child(section(t, "The brief", None)).child(essentials(t, e)))
        .child(col().w_full().gap(10.0)
            .child(section(t, "Deliverables", (total > 0).then(|| label(format!("{done} of {total} done"), type_::XS, t.muted_foreground))))
            .children((total == 0).then(|| label("What has to be made: a landing page, ads, an email.", type_::SM_13, t.muted_foreground)))
            .child(tasks)
            .child(add))
        .child(more(t, e));

    let toolbar = row()
        .key("cp-document-toolbar")
        .w_full()
        .gap(8.0)
        .center_y()
        .child(label("Campaign brief", type_::SM_MEDIUM, t.muted_foreground).grow(1.0))
        .child(button(t, "cp-edit-discard", "Discard", Variant::Ghost).disabled(e.busy).on_press(|s: &mut App| {
            if s.campaign_editor.as_ref().is_some_and(|e| !e.busy) {
                s.campaign_editor = None;
                s.close_tab(&crate::side::SideTab::CampaignBrief);
                s.refresh();
            }
        }))
        .child(button(t, "cp-edit-save", if e.busy { "Saving…" } else { "Save brief" }, Variant::Primary).disabled(e.busy).on_press(|s: &mut App| s.save_campaign_brief()));
    let mut body = col().key("campaign-brief-editor").w_full().grow(1.0).min_h(0.0).child(toolbar.px(24.0).py(12.0));
    if let Some(error) = &e.error {
        body = body.child(label(error.clone(), type_::SM_13, t.wrong).wrap().px(24.0).pb(8.0).live_region(rune::LiveRegion::Polite));
    }
    body.child(
        col()
            .key("campaign-document-scroll")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(row().w_full().px(24.0).pt(8.0).pb(40.0).justify_center().child(document.disabled(e.busy)))
            .scroll(ScrollSpec { stick_bottom: false }),
    )
}
