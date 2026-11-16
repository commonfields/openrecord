//! Campaigns: the portfolio at a glance, each campaign's progress and
//! readiness, and one campaign's brief, measurement plan, deliverables and
//! results. Saved briefs and adapter-derived preparation runs come from the API.
//! Manual editing uses the same revision-checked save route as the web client.
//! Readiness is a planning check, not proof that anything was published.

use rune::{Color, Cursor, El, col, el, row};

use crate::api::Campaign;
use crate::format;
use crate::state::{App, Load};
use crate::theme::{Theme, type_};
use crate::ui::kit::{self, Column, column};
use crate::ui::widgets::{CONTROL, Variant, button as widget_button, empty_state_plain, failure, label, page_header, skeleton, status_chip};

/// Campaign actions keep their content width even when placed in a full-width column.
pub(super) fn campaign_button(t: &Theme, key: &str, title: &str, variant: Variant) -> El {
    widget_button(t, key, title, variant).self_start()
}

fn ask(request: String) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(&request);
    }
}

fn today() -> String {
    format::iso_date(format::now())
}

/// Whole days from `a` to `b` ("2026-11-01" to "2026-11-10" is 9).
fn days_between(a: &str, b: &str) -> Option<i64> {
    let p = |d: &str| format::parse_iso(&format!("{}T00:00:00", d.get(0..10)?));
    Some((p(b)? - p(a)?) / 86_400)
}

fn status_name(s: &str) -> &'static str {
    match s {
        "ACTIVE" => "Active",
        "REVIEW" => "In review",
        "CLOSED" => "Closed",
        _ => "Draft",
    }
}

fn status_tone(t: &Theme, s: &str) -> (Color, Color) {
    match s {
        "ACTIVE" => (t.supported, t.supported_soft),
        "REVIEW" => (t.partial, t.partial_soft),
        "CLOSED" => (t.muted_foreground, t.accent),
        _ => (t.review, t.review_soft),
    }
}

fn task_tone(t: &Theme, s: &str) -> (&'static str, Color, Color) {
    match s {
        "DONE" => ("Done", t.supported, t.supported_soft),
        "IN_PROGRESS" => ("In progress", t.review, t.review_soft),
        "BLOCKED" => ("Blocked", t.wrong, t.wrong_soft),
        _ => ("To do", t.muted_foreground, t.accent),
    }
}

fn words(s: &str) -> String {
    let lower = s.replace('_', " ").to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn stage_name(s: &str) -> String {
    if s.is_empty() || s == "UNSPECIFIED" { "Not set".into() } else { words(s) }
}

fn decision_name(s: &str) -> &'static str {
    match s {
        "KEEP" => "Keep going",
        "CHANGE" => "Change it",
        "STOP" => "Stop",
        "INCONCLUSIVE" => "Inconclusive",
        _ => "Not decided",
    }
}

fn short(d: &str) -> String {
    if d.is_empty() { "—".into() } else { format::short_day(d) }
}

pub fn view(s: &App, t: &Theme) -> El {
    let list = match &s.campaigns {
        Load::Ready(list) => list,
        Load::Failed(e) => return col().w_full().gap(24.0).child(header(t)).child(failure(t, "campaigns-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(24.0).child(header(t)).child(skeleton(t, 3)),
    };
    if let Some(cp) = s.campaign_open.as_ref().and_then(|id| list.iter().find(|c| &c.id == id)) {
        return detail(s, t, cp);
    }
    if list.is_empty() {
        let room = (s.window.1 / s.zoom() - 220.0).max(360.0);
        return col()
            .key("campaigns-page-empty")
            .w_full()
            .gap(24.0)
            .child(header(t))
            .child(
                col()
                    .key("campaigns-empty-shell")
                    .w_full()
                    .h(room)
                    .justify_center()
                    .items_start()
                    .child(empty_state_plain(
                        t,
                        "campaigns-empty",
                        "No campaigns yet",
                        "Start with a brief: define the goal, audience, offer and decision window. Then prepare, distribute, monitor and learn.",
                        Some(campaign_button(t, "new-campaign", "Create campaign brief", Variant::Primary).on_press(|s: &mut App| s.edit_campaign(None))),
                    )),
            );
    }
    let today = today();
    let count = |st: &str| list.iter().filter(|c| c.status == st).count();
    let (done, total) = list.iter().filter(|c| c.status != "CLOSED").fold((0, 0), |a, c| (a.0 + c.done().0, a.1 + c.done().1));
    let blocked = list.iter().filter(|c| c.status != "CLOSED").flat_map(|c| c.tasks.iter()).filter(|t| t.status == "BLOCKED").count();
    let due = list.iter().filter(|c| c.review_due(&today)).count();
    let overdue_tasks = list
        .iter()
        .filter(|c| c.status != "CLOSED")
        .flat_map(|c| c.tasks.iter())
        .filter(|x| x.status != "DONE" && x.status != "BLOCKED" && !x.due.is_empty() && x.due.as_str() < today.as_str())
        .count();
    let strip = kit::responsive_cols(s, vec![
        kit::tile(t, "cp-live", "Active", count("ACTIVE").to_string(), None, Some(format!("{} in review, {} {}", count("REVIEW"), count("DRAFT"), if count("DRAFT") == 1 { "draft" } else { "drafts" }))),
        kit::tile(t, "cp-deliverables", "Deliverables done", if total > 0 { format!("{:.0}%", done as f64 / total as f64 * 100.0) } else { "—".into() }, None, Some(format!("{done} of {total} across open campaigns"))),
        kit::tile(t, "cp-reviews", "Reviews due", due.to_string(), None, Some(if due > 0 { "Results and a decision to record".into() } else { "Nothing waiting on a review".into() })),
        kit::tile(t, "cp-blocked", "Blocked or late", (blocked + overdue_tasks).to_string(), None, Some(format!("{blocked} blocked, {overdue_tasks} past their due date"))),
    ]);

    // The filter, then the portfolio as a table.
    let filter = s.campaign_filter.clone();
    let tab = |name: String, key: &'static str| -> (String, bool, Box<dyn Fn(&mut App)>) { (name, filter == key, Box::new(move |s: &mut App| s.campaign_filter = key.to_string())) };
    let tabs = kit::text_tabs(
        t,
        "cp-filter",
        vec![
            tab(format!("All {}", list.len()), ""),
            tab(format!("Active {}", count("ACTIVE")), "ACTIVE"),
            tab(format!("In review {}", count("REVIEW")), "REVIEW"),
            tab(format!("Drafts {}", count("DRAFT")), "DRAFT"),
            tab(format!("Closed {}", count("CLOSED")), "CLOSED"),
        ],
    );
    let shown: Vec<&Campaign> = list.iter().filter(|c| filter.is_empty() || c.status == filter || (filter == "DRAFT" && !matches!(c.status.as_str(), "ACTIVE" | "REVIEW" | "CLOSED"))).collect();
    const COLS: [Column; 6] = [column("Campaign", 0.0, false), column("Status", 92.0, false), column("Stage", 104.0, false), column("Timeline", 132.0, false), column("Deliverables", 140.0, false), column("Readiness", 110.0, true)];
    let now = format::now();
    let mut rows = Vec::new();
    for c in &shown {
        let (ink, soft) = status_tone(t, &c.status);
        let (d, n) = c.done();
        let blockers = c.blockers().len();
        let readiness = if c.status == "CLOSED" {
            label(decision_name(&c.decision), type_::XS_MEDIUM, t.muted_foreground)
        } else if blockers == 0 {
            label("Brief ready", type_::XS_MEDIUM, t.supported)
        } else {
            label(format!("{blockers} to do"), type_::XS_MEDIUM, if c.status == "ACTIVE" { t.partial } else { t.muted_foreground })
        };
        let timeline = if c.launch_date.is_empty() && c.review_date.is_empty() {
            kit::faint(t, "Not scheduled")
        } else {
            col()
                .gap(0.0)
                .child(label(format!("{} to {}", short(&c.launch_date), short(&c.review_date)), type_::XS.features("'tnum' 1"), t.foreground).truncate())
                .child(label(
                    if c.status == "CLOSED" {
                        "Closed".to_string()
                    } else if c.review_due(&today) {
                        "Review due".to_string()
                    } else {
                        days_between(&today, &c.review_date).map(|k| format!("Review in {k} {}", if k == 1 { "day" } else { "days" })).unwrap_or_default()
                    },
                    type_::XS11,
                    if c.review_due(&today) { t.partial } else { t.muted_foreground },
                )
                .truncate())
        };
        let progress = row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(row().grow(1.0).h(6.0).radius(3.0).fill(t.foreground.alpha(0.06)).child(el().w_frac(if n > 0 { d as f32 / n as f32 } else { 0.0 }).h_full().radius(3.0).fill(t.chart.primary)))
            .child(label(format!("{d}/{n}"), type_::XS.features("'tnum' 1"), t.muted_foreground));
        let title = if c.title.is_empty() { "Untitled campaign".to_string() } else { c.title.clone() };
        let id = c.id.clone();
        rows.push(vec![
            col()
                .w_full()
                .gap(0.0)
                .role("button")
                .label(title.clone())
                .focusable(true)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.open_campaign(&id))
                .child(label(title, type_::SM_MEDIUM, t.foreground).truncate())
                .child(label(
                    if c.goal.is_empty() { format!("Updated {}", format::relative(c.updated_at.as_deref(), now)) } else { c.goal.clone() },
                    type_::XS11,
                    t.muted_foreground,
                )
                .truncate()),
            status_chip(t, status_name(&c.status), ink, soft),
            kit::faint(t, stage_name(&c.funnel_stage)).truncate(),
            timeline,
            progress,
            readiness,
        ]);
    }
    let narrow = kit::analytics_width(s) < 600.0;
    let table = if rows.is_empty() {
        kit::note(t, "No campaigns with this status.")
    } else if narrow {
        let mut cards = col().key("cp-list").w_full().gap(16.0);
        for cells in rows {
            let mut card = col().w_full().gap(10.0).pb(12.0);
            for (index, content) in cells.into_iter().enumerate() {
                card = if index == 0 { card.child(content) } else {
                    card.child(col().w_full().gap(2.0).child(label(COLS[index].name, type_::XS, t.muted_foreground)).child(content))
                };
            }
            cards = cards.child(card);
        }
        cards
    } else {
        kit::table(t, "cp-table", &COLS, rows)
    };
    let portfolio = if narrow {
        kit::panel(t, "cp-portfolio", "Portfolio", Some("Open a campaign for its brief, deliverables and results".into()), None, 0.0,
            col().w_full().gap(16.0).child(row().key("cp-filter-scroll").w_full().min_w(0.0).child(tabs).scroll_x()).child(table))
    } else {
        kit::panel(t, "cp-portfolio", "Portfolio", Some("Open a campaign for its brief, deliverables and results".into()), Some(tabs), 0.0, table)
    };

    // Where the portfolio sits: by funnel stage, by channel, and what needs a look.
    let open: Vec<&Campaign> = list.iter().filter(|c| c.status != "CLOSED").collect();
    let stages = ["AWARENESS", "CONSIDERATION", "CONVERSION", "ACTIVATION", "RETENTION", "EXPANSION", "REFERRAL"];
    let by_stage: Vec<(String, f64, String)> = stages
        .iter()
        .map(|st| (words(st), open.iter().filter(|c| c.funnel_stage == *st).count() as f64))
        .filter(|x| x.1 > 0.0)
        .map(|(n, v)| (n, v, format!("{v:.0}")))
        .collect();
    let stage_card = kit::panel(
        t,
        "cp-stages",
        "Funnel coverage",
        Some("Open campaigns by the stage they work on".into()),
        None,
        260.0,
        if by_stage.is_empty() { kit::note(t, "No funnel stage set on open campaigns yet.") } else { kit::bars(t, "cp-stage-bars", &by_stage, None) },
    );
    let channels = [("WEBSITE", "Website"), ("EMAIL", "Email"), ("PAID", "Paid"), ("SOCIAL", "Social"), ("OTHER", "Other")];
    let mut ch_rows = Vec::new();
    for (k, name) in channels {
        let all: Vec<_> = open.iter().flat_map(|c| c.tasks.iter()).filter(|x| x.channel == k).collect();
        if all.is_empty() {
            continue;
        }
        let done = all.iter().filter(|x| x.status == "DONE").count();
        ch_rows.push((name.to_string(), done as f64 / all.len() as f64, format!("{done} of {} done", all.len())));
    }
    let channel_card = kit::panel(
        t,
        "cp-channels",
        "Deliverables by channel",
        Some("Where the work goes, and how much is done".into()),
        None,
        260.0,
        if ch_rows.is_empty() { kit::note(t, "No deliverables on open campaigns yet.") } else { kit::bars_to(t, "cp-channel-bars", &ch_rows, None, Some(1.0)) },
    );
    let mut queue: Vec<(String, String, Color, String)> = Vec::new();
    for c in &open {
        if c.review_due(&today) {
            queue.push((c.id.clone(), c.title.clone(), t.partial, "Review due: record results and decide".into()));
        }
        for x in c.tasks.iter().filter(|x| x.status == "BLOCKED") {
            queue.push((c.id.clone(), c.title.clone(), t.wrong, format!("Blocked: {}", x.title)));
        }
        for x in c.tasks.iter().filter(|x| x.status != "DONE" && x.status != "BLOCKED" && !x.due.is_empty() && x.due.as_str() < today.as_str()) {
            queue.push((c.id.clone(), c.title.clone(), t.partial, format!("Late: {}, due {}", x.title, short(&x.due))));
        }
    }
    let mut q = col().w_full();
    let qn = queue.len();
    for (k, (id, title, tone, what)) in queue.into_iter().enumerate() {
        let r = row()
            .key(format!("cp-queue-{k}"))
            .w_full()
            .py(9.0)
            .gap(10.0)
            .center_y()
            .role("button")
            .label(title.clone())
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.open_campaign(&id))
            .child(el().size(6.0, 6.0).radius(3.0).fill(tone))
            .child(col().grow(1.0).min_w(0.0).child(label(what, type_::SM_13, t.foreground).truncate()).child(label(title, type_::XS11, t.muted_foreground).truncate()));
        q = q.child(r);
    }
    let queue_card = kit::panel(t, "cp-queue", "Needs attention", Some(format!("{qn} items across open campaigns")), None, 260.0, if qn == 0 { kit::note(t, "Nothing is blocked, late or waiting on a review.") } else { q });

    // What closed campaigns taught.
    let learned: Vec<&Campaign> = list.iter().filter(|c| c.status == "CLOSED" && !c.learning.trim().is_empty()).take(4).collect();
    let mut c = col().w_full().gap(16.0).child(row().w_full().gap(16.0).items_start().flex_wrap().child(col().grow(1.0).min_w(200.0_f32.min(kit::analytics_width(s))).child(header(t))).child(plan_button(t))).child(strip).child(portfolio).child(kit::responsive_cols(s, vec![stage_card, channel_card, queue_card]));
    if !learned.is_empty() {
        let mut l = col().w_full().gap(14.0);
        for (k, cp) in learned.iter().enumerate() {
            l = l.child(
                col()
                    .key(format!("cp-learn-{k}"))
                    .w_full()
                    .gap(4.0)
                    .child(row().w_full().gap(8.0).center_y().child(label(cp.title.clone(), type_::SM_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0)).child(status_chip(t, decision_name(&cp.decision), t.muted_foreground, t.accent)))
                    .child(label(cp.learning.clone(), type_::SM_13, t.muted_foreground).wrap())
                    .children((!cp.next_move.is_empty()).then(|| label(format!("Next: {}", cp.next_move), type_::XS, t.foreground).wrap())),
            );
        }
        c = c.child(kit::panel(t, "cp-learning", "What closed campaigns taught", Some("Recorded by your team; read it as context, not proof".into()), None, 0.0, l));
    }
    c.child(label("Readiness checks the plan, not the work: it does not prove anything was published, sent or caused a result.", type_::XS, t.muted_foreground).wrap())
}

fn header(t: &Theme) -> El {
    page_header(t, "Campaigns", "A goal, an audience, an offer. Prepare the work, reach people, measure and decide.")
}

fn plan_button(t: &Theme) -> El {
    row().key("campaign-actions").gap(8.0).center_y().min_w(0.0).shrink().flex_wrap()
        .child(campaign_button(t, "plan-campaign", "Draft with the agent", Variant::Primary).h(32.0).on_press(|s: &mut App| {
            if s.campaign_editor.is_some() { s.open_campaign_document(); return; }
            s.ask_agent("/campaign Read our business goal and current campaigns. Prepare a campaign brief covering the problem, measurable goal and baseline, audience and fit, offer and CTA, message and proof, concrete assets, channel rationale, tracking checks, owners, launch and review dates, proposed budget, and a decision rule. Ask about unknowns and label suggestions. Save a draft; do not publish, send or spend without approval.");
            s.edit_campaign(None);
        }))
        .child(campaign_button(t, "new-campaign", "Create campaign brief", Variant::Outline).h(32.0).on_press(|s: &mut App| s.edit_campaign(None)))
}

/// One labelled field of the brief; an empty one says so.
fn field(t: &Theme, name: &str, value: &str) -> El {
    col()
        .w_full()
        .gap(2.0)
        .child(label(name.to_string(), type_::XS11, t.muted_foreground))
        .child(if value.trim().is_empty() { label("Not set", type_::SM_13, t.muted_foreground.alpha(0.7)) } else { label(value.to_string(), type_::SM_13, t.foreground).wrap() })
}

fn detail(s: &App, t: &Theme, c: &Campaign) -> El {
    let today = today();
    let (ink, soft) = status_tone(t, &c.status);
    let (done, total) = c.done();
    let blockers = c.blockers();
    let back = row()
        .key("cp-back")
        .h(28.0)
        .px(8.0)
        .gap(6.0)
        .radius(6.0)
        .center_y()
        .role("button")
        .label("All campaigns")
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .on_press(|s: &mut App| s.campaign_open = None)
        .child(label("← All campaigns", type_::XS_MEDIUM, t.muted_foreground));
    let title = if c.title.is_empty() { "Untitled campaign".to_string() } else { c.title.clone() };
    let (action, phase) = match c.status.as_str() {
        "DRAFT" if !blockers.is_empty() => ("Complete the brief", 0),
        "DRAFT" => ("Prepare distribution", 3),
        "ACTIVE" if !c.review_due(&today) => ("Check early signals", 4),
        "CLOSED" => ("Review learning", 5),
        _ => ("Review and decide", 5),
    };
    let review_req = campaign_request(c, phase);
    let saved = c.clone();
    let head = row()
        .w_full()
        .gap(16.0)
        .items_start()
        .flex_wrap()
        .child(
            col()
                .w(0.0).grow(1.0)
                .min_w(200.0_f32.min(kit::analytics_width(s)))
                .gap(6.0)
                .child(row().w_full().min_w(0.0).gap(10.0).center_y().child(label(title.clone(), type_::TITLE, t.foreground).role("heading").wrap().min_w(0.0).shrink()).child(status_chip(t, status_name(&c.status), ink, soft)))
                .child(label(if c.goal.is_empty() { "No goal written yet.".to_string() } else { c.goal.clone() }, type_::SM, t.muted_foreground).wrap()),
        )
        .child(row().gap(8.0).center_y().flex_wrap().min_w(0.0).shrink().child(campaign_button(t, "cp-edit", "Edit brief", Variant::Outline).h(32.0).on_press(move |s: &mut App| s.edit_campaign(Some(saved.clone())))).child(campaign_button(t, "cp-review", action, Variant::Outline).h(32.0).on_press(ask(review_req))));

    let since = days_between(&c.launch_date, &today).filter(|d| *d >= 0);
    let until = days_between(&today, &c.review_date);
    let timing = match (since, until) {
        (_, Some(u)) if u >= 0 && c.status != "CLOSED" => (format!("{u} days"), format!("Until the review on {}", short(&c.review_date))),
        (_, Some(u)) if c.status != "CLOSED" => (format!("{} days", -u), format!("Review overdue since {}", short(&c.review_date))),
        (Some(s), _) => (format!("Day {s}"), format!("Since launch on {}", short(&c.launch_date))),
        _ => ("—".into(), "Not scheduled".into()),
    };
    let strip = kit::responsive_cols(s, vec![
        kit::tile(t, "cpd-progress", "Deliverables done", format!("{done} of {total}"), None, Some(if total > 0 { format!("{:.0}% complete", done as f64 / total as f64 * 100.0) } else { "No deliverables yet".into() })),
        kit::tile(t, "cpd-timing", "Timeline", timing.0, None, Some(timing.1)),
        kit::tile(t, "cpd-ready", "Brief readiness", if blockers.is_empty() { "Complete".into() } else { format!("{} to do", blockers.len()) }, None, Some(if blockers.is_empty() { "Required brief fields and tasks are complete".into() } else { "Required brief fields and tasks".into() })),
        kit::panel(t, "cpd-budget", "Budget", None, None, 0.0, col().w_full().gap(8.0).child(label(if c.budget.is_empty() { "Not set" } else { &c.budget }, type_::SM_13, t.foreground).wrap()).child(label("For planning, not approval to spend", type_::XS, t.muted_foreground).wrap())),
    ]);

    let brief = kit::panel(
        t,
        "cpd-brief",
        "Brief",
        Some("Who it is for and what it says".into()),
        None,
        0.0,
        col().w_full().gap(12.0).child(field(t, "Audience", &c.audience)).child(field(t, "Offer", &c.offer)).child(field(t, "Message", &c.message)).child(field(t, "Hypothesis", &c.hypothesis)).child(field(t, "Owner", &c.owner)).child(field(t, "Launch date", &c.launch_date)).child(field(t, "Review / decision date", &c.review_date)),
    );
    let measure = kit::panel(
        t,
        "cpd-measure",
        "Measurement and distribution",
        Some("How success is counted, and where the campaign runs".into()),
        None,
        0.0,
        col()
            .w_full()
            .gap(12.0)
            .child(row().w_full().gap(16.0).child(field(t, "Success metric", &c.metric).w(0.0).grow(1.0)).child(field(t, "Conversion event", &c.conversion_event).w(0.0).grow(1.0)))
            .child(row().w_full().gap(16.0).child(field(t, "Baseline", &c.baseline).w(0.0).grow(1.0)).child(field(t, "Target", &c.target).w(0.0).grow(1.0)))
            .child(field(t, "Tracking plan", &c.tracking_plan))
            .child(field(t, "Channel rationale", &c.rationale))
            .child(field(t, "Destination", &c.destination))
            .child(row().w_full().gap(16.0).child(field(t, "Channel", &c.channel).w(0.0).grow(1.0)).child(field(t, "Funnel stage", &stage_name(&c.funnel_stage)).w(0.0).grow(1.0)))
            .child(row().w_full().gap(16.0).child(field(t, "Motion", &stage_name(&c.motion)).w(0.0).grow(1.0)).child(field(t, "Cadence", &c.cadence).w(0.0).grow(1.0))),
    );

    const TASK_COLS: [Column; 5] = [column("Deliverable", 0.0, false), column("Channel", 90.0, false), column("Owner", 100.0, false), column("Due", 90.0, false), column("Status", 110.0, true)];
    let rows: Vec<Vec<El>> = c
        .tasks
        .iter()
        .map(|x| {
            let (name, ink, soft) = task_tone(t, &x.status);
            let late = x.status != "DONE" && !x.due.is_empty() && x.due.as_str() < today.as_str();
            vec![
                col().w_full().gap(4.0).child(kit::text(t, x.title.clone())).children((!x.note.trim().is_empty()).then(|| label(x.note.clone(), type_::XS, t.muted_foreground).wrap())),
                kit::faint(t, words(&x.channel)),
                kit::faint(t, if x.owner.is_empty() { "Unassigned".to_string() } else { x.owner.clone() }),
                label(short(&x.due), type_::SM_13.features("'tnum' 1"), if late { t.wrong } else { t.muted_foreground }),
                status_chip(t, name, ink, soft),
            ]
        })
        .collect();
    let tasks = kit::panel(
        t,
        "cpd-tasks",
        "Deliverables",
        Some(format!("{done} of {total} done")),
        None,
        0.0,
        if rows.is_empty() { kit::note(t, "No deliverables yet. Ask the agent to draft them from the brief.") } else { kit::table(t, "cpd-task-table", &TASK_COLS, rows) },
    );

    let mut checklist = col().w_full().gap(8.0);
    if blockers.is_empty() {
        checklist = checklist.child(kit::note(t, "Required fields and deliverables are complete. Confirm tracking, approvals and delivery evidence before launch."));
    }
    for (k, b) in blockers.iter().take(12).enumerate() {
        checklist = checklist.child(row().key(format!("cpd-block-{k}")).w_full().gap(10.0).center_y().child(el().size(12.0, 12.0).radius(3.0).border(1.0, t.muted_foreground.alpha(0.6))).child(label(b.clone(), type_::SM_13, t.foreground).truncate().grow(1.0).min_w(0.0)));
    }
    if blockers.len() > 12 {
        checklist = checklist.child(label(format!("And {} more", blockers.len() - 12), type_::XS, t.muted_foreground));
    }
    let ready = kit::panel(t, "cpd-ready-list", "Launch readiness", Some("Required brief fields and deliverables; separate from approval and delivery".into()), None, 0.0, checklist);
    let results = kit::panel(
        t,
        "cpd-results",
        "Results and learning",
        Some(format!("Decision: {}", decision_name(&c.decision))),
        None,
        0.0,
        col().w_full().gap(12.0).child(field(t, "Result", &c.result)).child(field(t, "Learning", &c.learning)).child(field(t, "Next move", &c.next_move)),
    );
    col()
        .key(format!("campaign-{}", c.id))
        .w_full()
        .gap(16.0)
        .child(row().child(back))
        .child(head)
        .child(strip)
        .child(campaign_loop(s, t, c))
        .child(kit::responsive_cols(s, vec![brief, measure]))
        .child(delivery(s, t, c))
        .child(tasks)
        .child(kit::responsive_cols(s, vec![ready, results]))
        .child(label(
            format!(
                "Revision {}{}. Results are recorded by your team, not measured by OpenRecord.",
                c.revision,
                match c.created_by.as_str() {
                    "ASSISTANT" => ", drafted by the agent",
                    "OPERATOR" => ", drafted by your team",
                    _ => "",
                }
            ),
            type_::XS,
            t.muted_foreground,
        ))
}


fn campaign_request(c: &Campaign, phase: usize) -> String {
    let work = match phase {
        0 => "Refine the problem, goal, audience fit, baseline, success metric, target and decision window. Ask about unknowns; label suggestions.",
        1 => "Refine the offer, CTA, message, proof points and hypothesis against the selected audience. Do not invent supporting evidence.",
        2 => "Prepare concrete draft assets from the current brief: landing page, creative, emails, forms and follow-up where relevant. Save reviewable artifacts. Record owners, due dates, dependencies and draft references in deliverable notes.",
        3 => "Read current preparation runs and exact linked changes. Identify missing drafts, tracking checks and channel connections. Prepare only supported changes for exact operator approval; explain manual handoffs for unsupported channels. Never treat a task marked done as delivery evidence.",
        4 => "Inspect available early signals, tracking quality and delivery receipts against the baseline and target. Explain unavailable evidence. Recommend creative, offer, channel or budget adjustments for approval; do not change spend automatically.",
        _ => "Review available results for the campaign period against the baseline and target. Separate sourced observations, operator records and measurement gaps. Propose a keep, change, stop or inconclusive decision, learning and next move. Ask before recording a final decision or closing.",
    };
    format!("For campaign ID {} (displayed revision {}), first read the current campaign brief and read_marketing_work scoped to this campaign ID. {} Use the current revision for any proposed edit. Do not publish, send, spend or approve anything without the exact operator approval required by the existing workflow.", c.id, c.revision, work)
}

fn campaign_loop(s: &App, t: &Theme, c: &Campaign) -> El {
    let phases = [
        ("1  Define", "Problem, goal, audience and success criteria", "Refine the goal"),
        ("2  Shape the offer", "Offer, message, proof and call to action", "Refine the message"),
        ("3  Prepare", "Assets, channels, owners and tracking", "Prepare assets"),
        ("4  Launch & distribute", "Exact approvals, delivery and handoffs", "Prepare distribution"),
        ("5  Monitor & adjust", "Early signals, tracking and proposed changes", "Check early signals"),
        ("6  Measure & decide", "Results, learning and the next experiment", "Review and decide"),
    ];
    let mut content = col().w_full().gap(12.0);
    for (offset, chunk) in phases.chunks(2).enumerate() {
        let mut cards = Vec::new();
        for (i,(title, description, action)) in chunk.iter().enumerate() {
            let index = offset*2+i;
            cards.push(kit::panel(t, &format!("cp-phase-{index}"), title, Some(description.to_string()), None, 0.0,
                row().w_full().child(campaign_button(t, &format!("cp-phase-action-{index}"), action, Variant::Outline).h(32.0).on_press(ask(campaign_request(c,index))))));
        }
        content=content.child(kit::responsive_cols(s, cards));
    }
    kit::panel(t, "cp-loop", "Campaign work loop", Some("Revisit any phase as you learn. Actions start a new main chat with this campaign in a right-panel tab; you review and send the request.".into()), None, 0.0, content)
}

fn delivery(s: &App, t: &Theme, c: &Campaign) -> El {
    let body = if s.campaign_run_id.as_deref() != Some(c.id.as_str()) {
        kit::note(t, "Open this campaign again to load its delivery evidence.")
    } else { match &s.campaign_runs {
        Load::Ready(runs) if runs.is_empty() => kit::note(t, "No preparation runs recorded. Prepare distribution with the agent to inspect readiness and supported delivery paths."),
        Load::Ready(runs) => {
            let mut list = col().w_full().gap(12.0);
            for run in runs {
                let mut r = col().w_full().gap(6.0).child(label(format!("Revision {}: {}{}",run.campaign_revision,words(&run.status),if run.stale { ", from an earlier campaign revision" } else { "" }),type_::SM_MEDIUM,t.foreground));
                for task in &run.tasks {
                    r = r.child(label(format!("{}: {}",task.title,words(&task.state)),type_::SM_13,t.foreground).wrap())
                        .child(label(task.next.clone(),type_::XS,t.muted_foreground).wrap());
                    let mut actions = row().gap(8.0).flex_wrap();
                    if let Some(artifact) = &task.artifact_id {
                        let id = artifact.clone();
                        actions = actions.child(campaign_button(t, &format!("delivery-artifact-{id}"), "Review artifact", Variant::Outline).on_press(move |s: &mut App| s.open_artifact(&id)));
                    }
                    // An email or post the owner sends: its tracked link, and a way to report it went out.
                    if !task.web {
                        if let Some(link) = &task.tracked_link {
                            r = r.child(label(format!("Tracked link: {link}"), type_::XS, t.muted_foreground).wrap().selectable(true));
                        }
                        if let (Some(task_id), None) = (&task.task_id, &task.handoff) {
                            let (campaign, task_id) = (c.id.clone(), task_id.clone());
                            actions = actions.child(campaign_button(t, &format!("delivery-sent-{task_id}"), "Mark as sent", Variant::Outline).on_press(move |s: &mut App| {
                                if let Some(b) = s.active.clone() { s.net.campaign_handoff(b, campaign.clone(), task_id.clone(), "SENT"); }
                            }));
                        }
                    }
                    if let Some(publication) = &task.publication_id {
                        let id = publication.clone();
                        if task.state == "NEEDS_TRACKING_TEST" || task.state == "AWAITING_APPROVAL" {
                            let id = id.clone();
                            actions = actions.child(campaign_button(t, &format!("delivery-test-{id}"), "Test inquiry form", Variant::Outline).on_press(move |s: &mut App| {
                                if let Some(b) = s.active.clone() { s.net.campaign_publication(b, id.clone(), crate::net::PublicationAction::Test); }
                            }));
                        }
                        if let Some(url) = &task.live_url {
                            let url = url.clone();
                            actions = actions.child(campaign_button(t, &format!("delivery-live-{id}"), "Open live page", Variant::Outline).on_press(move |s: &mut App| s.browser_open_page(&url)));
                            let contacts_id = id.clone();
                            actions = actions.child(campaign_button(t, &format!("delivery-inquiries-{id}"), "Read inquiries", Variant::Outline).on_press(move |s: &mut App| {
                                if let Some(b) = s.active.clone() { s.net.campaign_publication(b, contacts_id.clone(), crate::net::PublicationAction::Inquiries); }
                            }));
                            r = r.child(label(format!("{} recorded inquiries, not counting test submissions", task.inquiries), type_::XS, t.muted_foreground).wrap());
                            let withdraw_id = id.clone();
                            let confirming = s.campaign_withdraw_confirm.as_deref() == Some(id.as_str());
                            actions = actions.child(campaign_button(t, &format!("delivery-withdraw-{id}"), if confirming { "Confirm withdrawal" } else { "Withdraw page" }, Variant::Ghost).on_press(move |s: &mut App| {
                                if confirming { if let Some(b) = s.active.clone() { s.net.campaign_publication(b, withdraw_id.clone(), crate::net::PublicationAction::Withdraw); } s.campaign_withdraw_confirm = None; }
                                else { s.campaign_withdraw_confirm = Some(withdraw_id.clone()); }
                            }));
                            if confirming {
                                r = r.child(label("This stops public access and new inquiries. Existing inquiries remain available for their retention period.", type_::XS, t.wrong).wrap());
                                actions = actions.child(campaign_button(t, &format!("delivery-keep-{id}"), "Keep live", Variant::Outline).on_press(|s: &mut App| s.campaign_withdraw_confirm = None));
                            }
                        }
                        if let Some((shown, text)) = &s.campaign_contacts { if shown == &id {
                            r = r.child(label("Private inquiries, kept for 30 days", type_::XS_MEDIUM, t.foreground))
                                .child(label(text.clone(), type_::SM_13, t.foreground).wrap().selectable(true));
                        }}
                    }
                    r = r.child(actions);
                }
                list=list.child(r);
            }
            list
        },
        Load::Failed(e) => failure(t,"cp-runs-failed",e,|s: &mut App| s.refresh()),
        _ => skeleton(t,2),
    }};
    kit::panel(t,"cp-delivery","Approvals and delivery",Some("Adapter-derived preparation status. Delivery receipts do not establish campaign impact.".into()),Some(campaign_button(t,"cp-open-approvals","Open Inbox",Variant::Outline).on_press(|s: &mut App| s.show_page(crate::state::Page::Inbox))),0.0,body)
}
