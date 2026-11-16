//! A fillable campaign brief in the native workspace.
use super::kit;
use super::campaigns::campaign_button as button;
use super::widgets::{Variant, label};
use crate::campaign_edit::{Editor, FIELDS, SECTIONS, TaskEdit};
use crate::state::App;
use crate::theme::{Theme, type_};
use rune::{El, ScrollSpec, TextEdit, col, row, text_input};
use serde_json::json;

fn input(
    t: &Theme,
    name: &str,
    hint: &str,
    edit: &TextEdit,
    key: String,
    access: impl Fn(&mut App) -> &mut TextEdit + 'static,
) -> El {
    let style = if name == "Campaign name" {
        rune::TextStyle::new(26.0, 600.0).lh(34.0)
    } else {
        type_::SM.lh(22.0)
    };
    // Rune measures empty text inputs as one line even when their placeholder
    // wraps. Measure the displayed paragraph so narrow documents never overlap.
    let paragraph = label(
        if edit.text.is_empty() {
            hint
        } else {
            &edit.text
        },
        style,
        t.muted_foreground,
    )
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
        .on_edit(access);
    let mut field = col().w_full().gap(6.0);
    if name != "Campaign name" {
        field = field.child(label(
            name.to_string(),
            type_::XS_MEDIUM,
            t.muted_foreground,
        ));
    }
    field.child(
        row()
            .w_full()
            .min_h(28.0)
            .py(4.0)
            .child(col().w_full().child(paragraph).child(text)),
    )
}
fn choices(
    t: &Theme,
    name: &str,
    values: &[(&'static str, &'static str)],
    current: &str,
    set: fn(&mut Editor, String),
) -> El {
    let mut options = col().w_full().gap(6.0).child(label(
        name.to_string(),
        type_::XS_MEDIUM,
        t.muted_foreground,
    ));
    // Rows keep all choices reachable in the side pane.
    for chunk in values.chunks(3) {
        let mut r = row().w_full().gap(6.0).flex_wrap();
        for &(value, title) in chunk {
            r = r.child(
                button(
                    t,
                    &format!("cp-choice-{name}-{value}"),
                    title,
                    if current == value {
                        Variant::Outline
                    } else {
                        Variant::Ghost
                    },
                )
                .on_press(move |s: &mut App| {
                    if let Some(e) = &mut s.campaign_editor {
                        if !e.busy {
                            set(e, value.into());
                        }
                    }
                }),
            );
        }
        options = options.child(r);
    }
    options
}
pub fn view(s: &App, t: &Theme) -> El {
    let e = s.campaign_editor.as_ref().expect("campaign editor open");
    let mut document = col()
        .key("campaign-document")
        .w_full()
        .max_w(760.0)
        .gap(32.0)
        .child(input(
            t,
            "Campaign name",
            "Untitled campaign",
            &e.fields[0],
            "cp-edit-title".into(),
            |s| &mut s.campaign_editor.as_mut().expect("editor open").fields[0],
        ));
    for section in 0..SECTIONS.len() {
        let mut form = col().w_full().gap(16.0);
        for (i, f) in FIELDS
            .iter()
            .enumerate()
            .filter(|(_, f)| f.section == section && f.key != "title")
        {
            form = form.child(input(
                t,
                f.name,
                f.hint,
                &e.fields[i],
                format!("cp-edit-{}", f.key),
                move |s| &mut s.campaign_editor.as_mut().expect("editor open").fields[i],
            ));
        }
        if section == 2 {
            form = form
                .child(choices(
                    t,
                    "Motion",
                    &[
                        ("UNSPECIFIED", "Not set"),
                        ("OWNED", "Owned"),
                        ("EARNED", "Earned"),
                        ("PAID", "Paid"),
                        ("PRODUCT_LED", "Product-led"),
                        ("HYBRID", "Hybrid"),
                    ],
                    &e.motion,
                    |e, v| e.motion = v,
                ))
                .child(choices(
                    t,
                    "Funnel stage",
                    &[
                        ("UNSPECIFIED", "Not set"),
                        ("AWARENESS", "Awareness"),
                        ("CONSIDERATION", "Consideration"),
                        ("CONVERSION", "Conversion"),
                        ("ACTIVATION", "Activation"),
                        ("RETENTION", "Retention"),
                        ("EXPANSION", "Expansion"),
                        ("REFERRAL", "Referral"),
                    ],
                    &e.funnel,
                    |e, v| e.funnel = v,
                ));
        }
        if section == 3 {
            form = form.child(choices(t, "Recorded status", &[("DRAFT","Draft"),("ACTIVE","Active"),("REVIEW","Review"),("CLOSED","Closed")], &e.status, |e,v| e.status=v)).child(kit::note(t, "Status is your team's record. Saving never publishes, sends, spends or schedules a review."));
        }
        if section == 5 {
            form = form.child(choices(
                t,
                "Decision",
                &[
                    ("UNDECIDED", "Undecided"),
                    ("KEEP", "Keep"),
                    ("CHANGE", "Change"),
                    ("STOP", "Stop"),
                    ("INCONCLUSIVE", "Inconclusive"),
                ],
                &e.decision,
                |e, v| e.decision = v,
            ));
        }
        if section == 4 {
            form = form.child(kit::note(t, "Prepare landing pages, creative, emails, forms, tracking and follow-up. Record dependencies and draft references in handoff notes. Done is team-attested, not proof of delivery."));
            for (i, task) in e.tasks.iter().enumerate() {
                let mut fields = col()
                    .w_full()
                    .gap(12.0)
                    .child(input(
                        t,
                        "Deliverable",
                        "Landing page, three ads, follow-up sequence…",
                        &task.title,
                        format!("cp-task-{i}-title"),
                        move |s| &mut s.campaign_editor.as_mut().unwrap().tasks[i].title,
                    ))
                    .child(input(
                        t,
                        "Owner",
                        "Responsible person or agent",
                        &task.owner,
                        format!("cp-task-{i}-owner"),
                        move |s| &mut s.campaign_editor.as_mut().unwrap().tasks[i].owner,
                    ))
                    .child(input(
                        t,
                        "Due date",
                        "YYYY-MM-DD",
                        &task.due,
                        format!("cp-task-{i}-due"),
                        move |s| &mut s.campaign_editor.as_mut().unwrap().tasks[i].due,
                    ))
                    .child(input(
                        t,
                        "Draft, dependencies and handoff notes",
                        "Draft reference, approval needed, blocker or dependency",
                        &task.note,
                        format!("cp-task-{i}-note"),
                        move |s| &mut s.campaign_editor.as_mut().unwrap().tasks[i].note,
                    ));
                for (name, vals, current, channel) in [
                    (
                        "Channel",
                        vec![
                            ("WEBSITE", "Website"),
                            ("EMAIL", "Email"),
                            ("PAID", "Paid"),
                            ("SOCIAL", "Social"),
                            ("OTHER", "Other"),
                        ],
                        task.channel.as_str(),
                        true,
                    ),
                    (
                        "Status",
                        vec![
                            ("TODO", "To do"),
                            ("IN_PROGRESS", "In progress"),
                            ("BLOCKED", "Blocked"),
                            ("DONE", "Done"),
                        ],
                        task.status.as_str(),
                        false,
                    ),
                ] {
                    let mut r = col().w_full().gap(6.0).child(label(
                        name,
                        type_::XS_MEDIUM,
                        t.muted_foreground,
                    ));
                    for chunk in vals.chunks(3) {
                        let mut options = row().gap(6.0).flex_wrap();
                        for &(value, title) in chunk {
                            options = options.child(
                                button(
                                    t,
                                    &format!("cp-task-{i}-{name}-{value}"),
                                    title,
                                    if current == value {
                                        Variant::Primary
                                    } else {
                                        Variant::Outline
                                    },
                                )
                                .on_press(move |s: &mut App| {
                                    if let Some(e) = &mut s.campaign_editor {
                                        if !e.busy {
                                            if channel {
                                                e.tasks[i].channel = value.into();
                                            } else {
                                                e.tasks[i].status = value.into();
                                            }
                                        }
                                    }
                                }),
                            );
                        }
                        r = r.child(options);
                    }
                    fields = fields.child(r);
                }
                fields = fields.child(
                    button(
                        t,
                        &format!("cp-task-{i}-remove"),
                        "Remove deliverable",
                        Variant::Ghost,
                    )
                    .disabled(e.busy)
                    .on_press(move |s: &mut App| {
                        if let Some(e) = &mut s.campaign_editor {
                            if !e.busy {
                                e.tasks.remove(i);
                            }
                        }
                    }),
                );
                form = form.child(
                    col()
                        .key(format!("cp-edit-task-{i}"))
                        .w_full()
                        .gap(12.0)
                        .child(label(
                            format!("Deliverable {}", i + 1),
                            type_::SM_MEDIUM,
                            t.foreground,
                        ))
                        .child(fields),
                );
            }
            form = form.child(
                button(t, "cp-add-task", "Add deliverable", Variant::Outline)
                    .disabled(e.busy || e.tasks.len() >= 100)
                    .on_press(|s: &mut App| {
                        if let Some(e) = &mut s.campaign_editor {
                            if !e.busy && e.tasks.len() < 100 {
                                e.tasks.push(TaskEdit::new(json!({})));
                            }
                        }
                    }),
            );
        }
        document = document.child(
            col()
                .key(format!("cp-document-section-{section}"))
                .w_full()
                .gap(16.0)
                .child(label(SECTIONS[section], type_::BASE_MEDIUM, t.foreground).role("heading"))
                .child(form),
        );
    }
    let toolbar = row()
        .key("cp-document-toolbar")
        .w_full()
        .gap(8.0)
        .center_y()
        .flex_wrap()
        .child(label("Campaign brief", type_::SM_MEDIUM, t.muted_foreground).grow(1.0))
        .child(
            button(t, "cp-edit-discard", "Discard", Variant::Ghost)
                .disabled(e.busy)
                .on_press(|s: &mut App| {
                    if s.campaign_editor.as_ref().is_some_and(|e| !e.busy) {
                        s.campaign_editor = None;
                        s.close_tab(&crate::side::SideTab::CampaignBrief);
                        s.refresh();
                    }
                }),
        )
        .child(
            button(
                t,
                "cp-edit-save",
                if e.busy { "Saving…" } else { "Save brief" },
                Variant::Primary,
            )
            .disabled(e.busy)
            .on_press(|s: &mut App| s.save_campaign_brief()),
        );
    let mut body = col()
        .key("campaign-brief-editor")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(toolbar.px(24.0).py(12.0));
    if let Some(error) = &e.error {
        body = body.child(
            label(error.clone(), type_::SM_13, t.wrong)
                .wrap()
                .live_region(rune::LiveRegion::Polite),
        );
    }
    body.child(
        col()
            .key("campaign-document-scroll")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(
                row()
                    .w_full()
                    .padding(24.0)
                    .justify_center()
                    .child(document.disabled(e.busy)),
            )
            .scroll(ScrollSpec {
                stick_bottom: false,
            }),
    )
}
