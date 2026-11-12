//! Campaigns, as the web's `routes/campaigns.tsx` lays it out: the header with
//! "Plan with the agent" and "Manual brief"; In motion, Reviews due and
//! Learning captured; "Your campaigns" on the left; and on the right the open
//! campaign's brief in its four numbered sections, saved at the revision it was
//! read at, or "Start with a goal, not a form" when none is open.

use rune::{Align, Cursor, El, Side, col, el, row, text_input};

use crate::api::Campaign;
use crate::format;
use crate::icons;
use crate::state::{App, Choice, ChoiceTarget, Load};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{Variant, button, card, failure, ico, label};

/// The web's field labels (`labels`).
fn field_label(k: &str) -> &'static str {
    match k {
        "title" => "Campaign name",
        "goal" => "Business goal",
        "audience" => "Audience / lifecycle stage",
        "offer" => "Offer and call to action",
        "message" => "Core message",
        "hypothesis" => "Hypothesis: we believe… because…",
        "metric" => "Success metric and data source",
        "baseline" => "Baseline, or why unavailable",
        "target" => "Target and evaluation criteria",
        "owner" => "Campaign owner",
        "launchDate" => "Launch date",
        "reviewDate" => "Results review date",
        "result" => "Observed results and evidence links",
        "learning" => "What we learned, including uncertainty",
        "nextMove" => "Next experiment or action",
        "primaryChannel" => "Primary channel",
        "rationale" => "Why this channel",
        "destination" => "Destination or audience segment",
        "cadence" => "Cadence",
        "budget" => "Proposed budget",
        "conversionEvent" => "Conversion event",
        "trackingPlan" => "Tracking plan",
        _ => "",
    }
}

/// "IN_PROGRESS" as "In progress" (the web's option labels).
fn words(s: &str) -> String {
    let lower = s.replace('_', " ").to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn ask(request: String) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| s.ask_agent(&request)
}

/// The web's `Panel` with a `PanelHeader`: a card, its title and description, then its body.
fn panel(t: &Theme, key: &str, title: &str, description: &str, body: El) -> El {
    card(t)
        .key(key.to_string())
        .child(col().w_full().px(20.0).pt(18.0).gap(2.0).child(label(title.to_string(), type_::SM_MEDIUM, t.foreground).role("heading")).child(label(description.to_string(), type_::XS, t.muted_foreground).wrap()))
        .child(col().w_full().padding(20.0).child(body))
}

/// A text field of the open brief (the web's `Input` or `Textarea`).
fn input(t: &Theme, s: &App, key: &str, multiline: bool) -> El {
    let Some(e) = s.campaign_edit.as_ref() else { return el() };
    let Some(edit) = e.fields.get(key) else { return el() };
    let k = key.to_string();
    let placeholder = if key.ends_with("Date") || key.ends_with(".due") { "YYYY-MM-DD" } else { "" };
    let field = text_input(edit, type_::SM)
        .key(format!("cp-field-{key}"))
        .placeholder(placeholder, t.muted_foreground)
        .label(field_label(key).to_string())
        .w_full()
        .color(t.foreground)
        .on_edit(move |s: &mut App| {
            let e = s.campaign_edit.as_mut().expect("campaign open");
            e.dirty = true;
            e.fields.get_mut(&k).expect("field")
        });
    let field = if multiline { field.min_h(60.0).max_h(160.0) } else { field };
    shadows(row().w_full().min_h(36.0).px(10.0).py(8.0).radius(6.0).items_start().fill(t.control).child(field), &t.control_shadow)
}

/// A labelled field, as the web's `<label className="grid gap-2 text-sm font-medium">`.
fn labelled(t: &Theme, name: &str, body: El) -> El {
    col().w_full().gap(8.0).child(label(name.to_string(), type_::SM_MEDIUM, t.foreground)).child(body)
}

/// Fields two to a row (`sm:grid-cols-2`).
fn two_up(items: Vec<El>) -> El {
    let mut c = col().w_full().gap(16.0);
    let mut it = items.into_iter();
    while let Some(a) = it.next() {
        let b = it.next().unwrap_or_else(el);
        c = c.child(row().w_full().gap(16.0).items_start().child(col().w(0.0).grow(1.0).min_w(0.0).child(a)).child(col().w(0.0).grow(1.0).min_w(0.0).child(b)));
    }
    c
}

/// A select's button (the web's `SelectTrigger`), opening its options.
fn select(t: &Theme, anchor: String, name: &str, current: &str, options: Vec<&'static str>, target: ChoiceTarget) -> El {
    let shown = words(current);
    let c = Choice { anchor: anchor.clone(), options, current: current.to_string(), target };
    shadows(
        row()
            .key(anchor)
            .w_full()
            .h(36.0)
            .px(10.0)
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .fill(t.control)
            .role("button")
            .label(name.to_string())
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.control_hover)
            .on_press(move |s: &mut App| s.open_choice(c.clone()))
            .child(label(shown, type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0))
            .child(ico(&icons::CHEVRON_DOWN, 14.0, t.muted_foreground)),
        &t.control_shadow,
    )
}

/// The open select's options, under its button.
pub fn choice_menu(s: &App, t: &Theme) -> Option<El> {
    let c = s.choice.as_ref()?;
    let mut m = shadows(col().key("choice-menu").min_w(180.0).padding(4.0).gap(1.0).radius(10.0).fill(t.popover), &t.float_shadow).role("listbox");
    for o in &c.options {
        let v = o.to_string();
        let on = c.current == *o;
        m = m.child(
            row()
                .key(format!("choice-{o}"))
                .w_full()
                .h(32.0)
                .px(8.0)
                .gap(8.0)
                .radius(6.0)
                .center_y()
                .role("option")
                .label(words(o))
                .checked(on)
                .cursor(Cursor::Pointer)
                .hover(t.accent)
                .on_press(move |s: &mut App| s.pick_choice(&v))
                .child(label(words(o), type_::SM, t.foreground).grow(1.0))
                .children(on.then(|| ico(&icons::CHECK, 14.0, t.foreground))),
        );
    }
    Some(m.anchored(&c.anchor, Side::Bottom, Align::Start, 4.0).modal(true, |s: &mut App| {
        s.menu = None;
        s.choice = None;
    }))
}

pub fn view(s: &App, t: &Theme) -> El {
    let head = row()
        .w_full()
        .gap(12.0)
        .items_start()
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(4.0)
                .child(label("Campaigns", type_::TITLE, t.foreground).role("heading"))
                .child(label("Tell the agent your goal. It prepares the campaign and deliverables here; your team controls external actions.", type_::SM, t.muted_foreground).wrap().max_w(560.0)),
        )
        .child(button(t, "cp-plan", "Plan with the agent →", Variant::Primary).on_press(ask("/campaign".into())))
        .child(button(t, "cp-manual", "+ Manual brief", Variant::Outline).on_press(|s: &mut App| s.open_campaign(None)));
    let list: Vec<Campaign> = s.campaigns.ready().cloned().unwrap_or_default();
    let today = format::iso_date(format::now());
    let stat = |key: &str, name: &str, n: usize| {
        card(t).key(key.to_string()).w(0.0).grow(1.0).min_w(0.0).padding(16.0).gap(8.0).child(label(name.to_string(), type_::XS, t.muted_foreground)).child(label(n.to_string(), rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1"), t.foreground))
    };
    let stats = row()
        .w_full()
        .gap(12.0)
        .child(stat("cp-motion", "In motion", list.iter().filter(|c| c.status == "ACTIVE").count()))
        .child(stat("cp-due", "Reviews due", list.iter().filter(|c| !c.review_date.is_empty() && c.review_date.as_str() <= today.as_str() && c.status != "CLOSED").count()))
        .child(stat("cp-learned", "Learning captured", list.iter().filter(|c| c.status == "CLOSED").count()));
    let mut page = col().w_full().gap(24.0).child(head).child(stats);
    if let Load::Failed(e) = &s.campaigns {
        page = page.child(failure(t, "campaigns-failed", &format!("Campaigns could not load. {e}"), |s: &mut App| s.refresh()));
    }

    // Your campaigns.
    let open_id = s.campaign_edit.as_ref().map(|e| e.campaign.id.clone());
    let mut side = card(t).key("cp-list").w(260.0).padding(12.0).gap(4.0).child(label("YOUR CAMPAIGNS", rune::TextStyle::new(11.0, 500.0).lh(16.0), t.muted_foreground).px(8.0).py(8.0));
    match &s.campaigns {
        Load::Loading | Load::Idle => side = side.child(label("Loading campaigns…", type_::SM, t.foreground).padding(8.0)),
        Load::Ready(l) if l.is_empty() => {
            side = side.child(
                col()
                    .padding(12.0)
                    .gap(12.0)
                    .child(ico(&icons::FLAG, 20.0, t.muted_foreground))
                    .child(label("Start with one campaign, not another dashboard.", type_::SM, t.foreground).wrap())
                    .child(label("Define who it is for, what you will ship, and how you will decide what comes next.", type_::XS, t.muted_foreground).wrap()),
            )
        }
        _ => {}
    }
    for c in &list {
        let on = open_id.as_deref() == Some(c.id.as_str());
        let (done, total) = c.done();
        let pick = c.clone();
        side = side.child(
            col()
                .key(format!("cp-item-{}", c.id))
                .w_full()
                .padding(12.0)
                .gap(4.0)
                .radius(8.0)
                .fill(if on { t.accent } else { t.accent.alpha(0.0) })
                .hover(t.accent)
                .role("button")
                .label(c.title.clone())
                .focusable(true)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.open_campaign(Some(pick.clone())))
                .child(label(if c.title.is_empty() { "Untitled campaign".to_string() } else { c.title.clone() }, type_::SM_MEDIUM, t.foreground).wrap())
                .child(label(format!("{}, {}", c.status.to_lowercase(), if c.owner.is_empty() { "No owner" } else { c.owner.as_str() }), type_::XS, t.muted_foreground))
                .child(label(format!("{done}/{total} deliverables complete"), type_::XS, t.muted_foreground)),
        );
    }
    let right = match &s.campaign_edit {
        Some(_) => editor(s, t),
        None => card(t)
            .key("cp-start")
            .padding(32.0)
            .gap(8.0)
            .child(label("Start with a goal, not a form.", type_::BASE_MEDIUM, t.foreground))
            .child(label("Type /campaign followed by what you want to achieve. The agent saves a brief and draft deliverables. Use /campaign-run to prepare supported actions for approval, or /campaign-review to investigate results.", type_::SM, t.muted_foreground).wrap())
            .child(row().pt(12.0).child(button(t, "cp-plan-empty", "Plan with the agent →", Variant::Primary).on_press(ask("/campaign".into())))),
    };
    page.child(row().w_full().gap(24.0).items_start().child(side).child(col().w(0.0).grow(1.0).min_w(0.0).child(right)))
}

fn editor(s: &App, t: &Theme) -> El {
    let e = s.campaign_edit.as_ref().expect("campaign open");
    let c = e.current();
    let title = if c.title.is_empty() { "New campaign".to_string() } else { c.title.clone() };
    let saved = if e.dirty {
        "Unsaved changes".to_string()
    } else if c.revision > 0 {
        format!("Saved, revision {}", c.revision)
    } else {
        "Not saved yet".to_string()
    };
    let saved = if c.created_by == "ASSISTANT" { format!("{saved}. Agent-prepared draft") } else { saved };
    let mut top = card(t)
        .key("cp-head")
        .padding(20.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .gap(12.0)
                .center_y()
                .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(title, type_::BASE_MEDIUM, t.foreground)).child(label(saved, type_::XS, t.muted_foreground)))
                .child(row().w(150.0).child(select(t, "cp-stage".into(), "Campaign stage", &c.status, vec!["DRAFT", "ACTIVE", "REVIEW", "CLOSED"], ChoiceTarget::Campaign("status"))))
                .child(button(t, "cp-save", if e.saving { "Saving…" } else { "Save campaign" }, Variant::Primary).opacity(if e.saving { 0.5 } else { 1.0 }).on_press(|s: &mut App| s.save_campaign())),
        );
    if let Some(err) = &e.error {
        top = top.child(label(err.clone(), type_::SM, t.wrong).wrap());
    }
    if e.pending.is_some() {
        top = top.child(
            crate::ui::widgets::alert(
                t,
                "cp-discard",
                Some("Discard unsaved campaign changes?"),
                col()
                    .gap(8.0)
                    .child(label("Your saved campaign will not change. Unsaved edits will be lost.", type_::XS, t.muted_foreground))
                    .child(
                        row()
                            .gap(8.0)
                            .child(button(t, "cp-discard-yes", "Discard changes", Variant::Primary).on_press(|s: &mut App| s.discard_campaign_changes()))
                            .child(button(t, "cp-discard-no", "Keep editing", Variant::Outline).on_press(|s: &mut App| {
                                if let Some(e) = s.campaign_edit.as_mut() {
                                    e.pending = None;
                                }
                            })),
                    ),
            ),
        );
    }
    top = top.child(if c.revision > 0 {
        let request = format!("/marketing Work on campaign {}. Read its marketing work queue and current revision, then prepare the next permitted step. Preserve existing decisions. Do not publish, send or spend without approval.", c.id);
        row().child(button(t, "cp-work", "Work on this with the agent →", Variant::Outline).on_press(ask(request)))
    } else {
        label("Save the brief first so the agent can read its durable context.", type_::XS, t.muted_foreground)
    });

    let field = |k: &str, multi: bool| labelled(t, field_label(k), input(t, s, k, multi));
    let brief = panel(
        t,
        "cp-brief",
        "1. Brief",
        "Start with the customer and the business outcome, not a channel.",
        two_up(vec![
            field("title", false),
            field("owner", false),
            field("goal", true),
            field("audience", true),
            field("offer", true),
            field("message", true),
            field("hypothesis", true),
            field("launchDate", false),
        ]),
    );
    let distribution = panel(
        t,
        "cp-distribution",
        "Distribution details",
        "One primary channel first. These are planning notes, not approval to spend, scheduled delivery or verified tracking.",
        two_up(vec![
            field("primaryChannel", true),
            field("rationale", true),
            field("destination", true),
            field("cadence", true),
            field("budget", true),
            field("conversionEvent", true),
            field("trackingPlan", true),
            labelled(t, "Distribution motion", select(t, "cp-motion".into(), "Distribution motion", if c.motion.is_empty() { "UNSPECIFIED" } else { &c.motion }, vec!["UNSPECIFIED", "OWNED", "EARNED", "PAID", "PRODUCT_LED", "HYBRID"], ChoiceTarget::Campaign("motion"))),
            labelled(
                t,
                "Funnel stage",
                select(t, "cp-funnel".into(), "Funnel stage", if c.funnel_stage.is_empty() { "UNSPECIFIED" } else { &c.funnel_stage }, vec!["UNSPECIFIED", "AWARENESS", "CONSIDERATION", "CONVERSION", "ACTIVATION", "RETENTION", "EXPANSION", "REFERRAL"], ChoiceTarget::Campaign("funnelStage")),
            ),
        ]),
    );
    let measure = panel(t, "cp-measure", "2. Measurement plan", "Define success before launch. A change after a campaign does not establish causation.", two_up(vec![field("metric", true), field("baseline", true), field("target", true), field("reviewDate", false)]));

    let mut tasks = col().w_full().gap(16.0);
    for (i, task) in c.tasks.iter().enumerate() {
        let small = |name: &str, body: El| col().w_full().gap(4.0).child(label(name.to_string(), type_::XS, t.foreground)).child(body);
        tasks = tasks.child(
            col()
                .key(format!("cp-task-{i}"))
                .w_full()
                .padding(16.0)
                .gap(12.0)
                .radius(8.0)
                .border(1.0, t.border)
                .child(two_up(vec![
                    small("Deliverable", input(t, s, &format!("task.{i}.title"), false)),
                    small("Owner / human handoff", input(t, s, &format!("task.{i}.owner"), false)),
                    small("Due", input(t, s, &format!("task.{i}.due"), false)),
                    small("Channel", select(t, format!("cp-task-{i}-channel"), "Channel", if task.channel.is_empty() { "WEBSITE" } else { &task.channel }, vec!["WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"], ChoiceTarget::Task(i, "channel"))),
                    small("Status", select(t, format!("cp-task-{i}-status"), "Status", if task.status.is_empty() { "TODO" } else { &task.status }, vec!["TODO", "IN_PROGRESS", "BLOCKED", "DONE"], ChoiceTarget::Task(i, "status"))),
                    small("Blocker, handoff or link", input(t, s, &format!("task.{i}.note"), false)),
                ]))
                .child(row().child(button(t, &format!("cp-task-{i}-remove"), "Remove deliverable", Variant::Ghost).on_press(move |s: &mut App| s.remove_task(i)))),
        );
    }
    tasks = tasks.child(row().child(button(t, "cp-task-add", "+ Add deliverable", Variant::Outline).opacity(if c.tasks.len() >= 100 { 0.5 } else { 1.0 }).on_press(|s: &mut App| s.add_task())));
    let deliverables = panel(t, "cp-tasks", "3. Deliverables & handoffs", "For planning only. Ticking a task off means you say it's done, not that OpenRecord saw it go live.", tasks);

    let blockers = c.blockers();
    let mut ready = card(t).key("cp-ready").padding(20.0).gap(12.0).child(row().gap(8.0).center_y().child(ico(&icons::CIRCLE_CHECK_2, 16.0, t.foreground)).child(label("Launch readiness", type_::SM_MEDIUM, t.foreground)));
    if blockers.is_empty() {
        ready = ready.child(label("Planning checks complete. Record ACTIVE only after the real launch; this does not publish anything.", type_::SM, t.foreground).wrap());
    } else {
        let mut l = col().gap(4.0).pl(8.0);
        for b in &blockers {
            l = l.child(row().gap(8.0).items_start().child(label("•", type_::SM, t.muted_foreground)).child(label(b.clone(), type_::SM, t.muted_foreground).wrap().grow(1.0).min_w(0.0)));
        }
        ready = ready.child(l);
    }

    let results = panel(
        t,
        "cp-results",
        "4. Results → decision → next move",
        "Record what happened, what remains unknown, and what the next campaign should do differently.",
        col()
            .w_full()
            .gap(16.0)
            .child(field("result", true))
            .child(labelled(t, "Decision", row().w(220.0).child(select(t, "cp-decision".into(), "Campaign decision", if c.decision.is_empty() { "UNDECIDED" } else { &c.decision }, vec!["UNDECIDED", "KEEP", "CHANGE", "STOP", "INCONCLUSIVE"], ChoiceTarget::Campaign("decision")))))
            .child(field("learning", true))
            .child(field("nextMove", true))
            .child(row().child(button(t, "cp-next", "Start the next experiment →", Variant::Outline).on_press(|s: &mut App| s.next_experiment()))),
    );
    col().key(format!("cp-editor-{}", c.id)).w_full().gap(20.0).child(top).child(brief).child(distribution).child(measure).child(deliverables).child(ready).child(results)
}
