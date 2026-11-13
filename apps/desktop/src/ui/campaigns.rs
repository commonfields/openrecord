//! Campaigns, built around the question a marketer opens the page with: what
//! do I do next? The list starts with what needs a person today, then each
//! campaign with its goal, the number it is judged by, where it stands and
//! its next step. A campaign opens to its stage, its next step, the
//! deliverables (each one a hand-off to the agent), the plan and the results.
//! Read from `/api/businesses/:id/campaigns` (the saved briefs). Nothing here
//! is a form: a change is a request to the agent. A deliverable marked done
//! is what the team recorded, not proof that anything was published.

use rune::{Color, Cursor, El, col, el, row};

use crate::api::Campaign;
use crate::format;
use crate::icons;
use crate::state::{App, Load};
use crate::theme::{Theme, type_};
use crate::ui::kit;
use crate::ui::widgets::{CONTROL, Variant, button, empty_state, failure, ico, label, page_header, skeleton, status_chip};

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
        "ACTIVE" => "Live",
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

/// The four stages every campaign moves through, as the plan records them.
const STAGES: [(&str, &str); 4] = [
    ("Plan", "The goal, audience, message and deliverables are agreed."),
    ("Do the work", "Deliverables are drafted, approved and carried out."),
    ("Check results", "Results are compared with the baseline and target."),
    ("Decide", "Keep, change or stop, and what to try next."),
];

fn stage_index(status: &str) -> usize {
    match status {
        "ACTIVE" => 1,
        "REVIEW" => 2,
        "CLOSED" => 3,
        _ => 0,
    }
}

fn title_of(c: &Campaign) -> String {
    if c.title.is_empty() { "Untitled campaign".to_string() } else { c.title.clone() }
}

/// What the plan itself still lacks (never the deliverables' progress).
fn missing(c: &Campaign) -> Vec<&'static str> {
    [
        (&c.goal, "a goal"),
        (&c.audience, "an audience"),
        (&c.offer, "an offer"),
        (&c.message, "a message"),
        (&c.metric, "a success metric"),
        (&c.baseline, "a baseline"),
        (&c.target, "a target"),
        (&c.launch_date, "a launch date"),
        (&c.review_date, "a review date"),
    ]
    .iter()
    .filter(|(v, _)| v.trim().is_empty())
    .map(|(_, l)| *l)
    .chain(c.tasks.is_empty().then_some("deliverables"))
    .collect()
}

fn late(x: &crate::api::CampaignTask, today: &str) -> bool {
    x.status != "DONE" && x.status != "BLOCKED" && !x.due.is_empty() && x.due.as_str() < today
}

/// How urgent a campaign's next step is.
#[derive(Clone, Copy, PartialEq)]
enum Urgency {
    Stuck,
    Due,
    Plan,
    Steady,
    Closed,
}

/// The one thing a campaign needs next, in a sentence, and the request that hands it to the agent.
struct Next {
    urgency: Urgency,
    what: String,
    action: &'static str,
    request: String,
}

fn next_of(c: &Campaign, today: &str) -> Next {
    let title = title_of(c);
    let guard = "Do not publish, send or spend without my approval.";
    if c.status == "CLOSED" {
        return Next {
            urgency: Urgency::Closed,
            what: if c.next_move.trim().is_empty() { format!("Decided: {}.", decision_name(&c.decision).to_lowercase()) } else { format!("Next: {}", c.next_move) },
            action: "Plan the follow-up",
            request: format!("/campaign Plan the follow-up to the closed campaign \"{title}\". Read its result, decision and learning first, then draft the next campaign. {guard}"),
        };
    }
    if let Some(x) = c.tasks.iter().find(|x| x.status == "BLOCKED") {
        return Next {
            urgency: Urgency::Stuck,
            what: format!("Blocked: {}", x.title),
            action: "Unblock it",
            request: format!("/campaign-run The deliverable \"{}\" of the campaign \"{title}\" is blocked. Read the campaign and its current run, tell me exactly what is blocking it and prepare the step that unblocks it. {guard}", x.title),
        };
    }
    if c.review_due(today) {
        return Next {
            urgency: Urgency::Due,
            what: "Review is due: record what happened and decide".into(),
            action: "Review results",
            request: review_request(&title),
        };
    }
    if let Some(x) = c.tasks.iter().find(|x| late(x, today)) {
        return Next {
            urgency: Urgency::Due,
            what: format!("Late: {}, due {}", x.title, short(&x.due)),
            action: "Get it moving",
            request: format!("/campaign-run The deliverable \"{}\" of the campaign \"{title}\" is past its due date. Read the campaign, draft or finish the deliverable and prepare it for my approval. {guard}", x.title),
        };
    }
    let gaps = missing(c);
    if c.status != "ACTIVE" && c.status != "REVIEW" {
        return if gaps.is_empty() {
            Next { urgency: Urgency::Plan, what: "The plan is complete: start the work".into(), action: "Start the work", request: format!("/campaign-run Start the campaign \"{title}\": read its plan, draft each deliverable and prepare the first one for my approval. {guard}") }
        } else {
            Next {
                urgency: Urgency::Plan,
                what: format!("The plan still needs {}", list_of(&gaps, 3)),
                action: "Finish the plan",
                request: format!("/campaign Finish the plan of the campaign \"{title}\". It still needs {}. Research what you can, propose each one and ask me at most one question. {guard}", list_of(&gaps, 9)),
            }
        };
    }
    if c.status == "REVIEW" {
        return Next { urgency: Urgency::Steady, what: "Compare results with the target".into(), action: "Review results", request: review_request(&title) };
    }
    match c.tasks.iter().find(|x| x.status != "DONE") {
        Some(x) => Next {
            urgency: Urgency::Steady,
            what: if x.due.is_empty() { format!("Next: {}", x.title) } else { format!("Next: {}, due {}", x.title, short(&x.due)) },
            action: "Continue the work",
            request: format!("/campaign-run Continue the campaign \"{title}\": work on the deliverable \"{}\" and prepare it for my approval. {guard}", x.title),
        },
        None => Next { urgency: Urgency::Steady, what: "Every deliverable is recorded done: check the results".into(), action: "Review results", request: review_request(&title) },
    }
}

fn review_request(title: &str) -> String {
    format!("/campaign-review Review the campaign \"{title}\": read its plan, deliverables and the goal metric since launch, then propose the results, a decision (keep, change, stop or inconclusive), the learning and the next move for me to approve. Do not invent measurements or claim a cause.")
}

/// "a goal, an audience and 2 more".
fn list_of(items: &[&str], show: usize) -> String {
    let shown: Vec<&str> = items.iter().take(show).copied().collect();
    let rest = items.len().saturating_sub(shown.len());
    match (shown.len(), rest) {
        (0, _) => String::new(),
        (1, 0) => shown[0].to_string(),
        (n, 0) => format!("{} and {}", shown[..n - 1].join(", "), shown[n - 1]),
        (_, r) => format!("{} and {r} more", shown.join(", ")),
    }
}

fn urgency_tone(t: &Theme, u: Urgency) -> Color {
    match u {
        Urgency::Stuck => t.wrong,
        Urgency::Due => t.partial,
        Urgency::Plan => t.review,
        Urgency::Steady => t.supported,
        Urgency::Closed => t.muted_foreground,
    }
}

/// When the campaign runs, and how far the review is.
fn timing(c: &Campaign, today: &str) -> (String, bool) {
    if c.launch_date.is_empty() && c.review_date.is_empty() {
        return ("Not scheduled yet".into(), false);
    }
    let span = format!("{} to {}", short(&c.launch_date), short(&c.review_date));
    if c.status == "CLOSED" {
        return (span, false);
    }
    if c.review_due(today) {
        return (format!("{span}, review due"), true);
    }
    match days_between(today, &c.review_date) {
        Some(k) if k >= 0 => (format!("{span}, review in {k} {}", if k == 1 { "day" } else { "days" }), false),
        _ => (span, false),
    }
}

/// Four small segments: how far the plan says the campaign is.
fn track(t: &Theme, status: &str) -> El {
    let at = stage_index(status);
    let mut r = row().gap(4.0).center_y().label(format!("Step {} of 4: {}", at + 1, STAGES[at].0));
    for i in 0..4 {
        r = r.child(el().w(26.0).h(4.0).radius(2.0).fill(if i <= at { t.chart.primary } else { t.foreground.alpha(0.08) }));
    }
    r
}

/// The number a campaign is judged by: "Trial sign-ups: 40 a week, target 60".
fn scoreline(c: &Campaign) -> Option<String> {
    if c.metric.trim().is_empty() {
        return None;
    }
    let mut s = c.metric.trim().to_string();
    match (c.baseline.trim().is_empty(), c.target.trim().is_empty()) {
        (false, false) => s.push_str(&format!(": {} now, target {}", c.baseline.trim(), c.target.trim())),
        (true, false) => s.push_str(&format!(": target {}", c.target.trim())),
        (false, true) => s.push_str(&format!(": {} now, no target yet", c.baseline.trim())),
        _ => s.push_str(": no baseline or target yet"),
    }
    Some(s)
}

pub fn view(s: &App, t: &Theme) -> El {
    let list = match &s.campaigns {
        Load::Ready(list) => list,
        Load::Failed(e) => return col().w_full().gap(24.0).child(header(t)).child(failure(t, "campaigns-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(24.0).child(header(t)).child(skeleton(t, 3)),
    };
    if let Some(cp) = s.campaign_open.as_ref().and_then(|id| list.iter().find(|c| &c.id == id)) {
        return detail(t, cp);
    }
    if list.is_empty() {
        return col().w_full().gap(24.0).child(header(t)).child(empty_state(
            t,
            "campaigns-empty",
            &icons::BRIEFCASE,
            "No campaigns yet",
            "Tell the agent what you want more of. It saves a plan here with the audience, the message and each piece of work, then prepares the work for you to approve. Planning never publishes, sends or spends anything.",
            Some(button(t, "plan-campaign", "Plan a campaign with the agent", Variant::Primary).on_press(ask(PLAN.into()))),
        ));
    }
    let today = today();

    // What needs a person today, most urgent first.
    let mut urgent: Vec<(&Campaign, Next)> = list.iter().map(|c| (c, next_of(c, &today))).filter(|(_, n)| matches!(n.urgency, Urgency::Stuck | Urgency::Due)).collect();
    urgent.sort_by_key(|(_, n)| if n.urgency == Urgency::Stuck { 0 } else { 1 });
    let mut top = col().w_full().gap(8.0);
    if urgent.is_empty() {
        top = top.child(
            row()
                .key("cp-clear")
                .w_full()
                .px(18.0)
                .py(14.0)
                .gap(12.0)
                .radius(12.0)
                .center_y()
                .fill(t.supported.alpha(0.07))
                .child(ico(&icons::CHECK, 14.0, t.supported))
                .child(label("Nothing is blocked, late or waiting on a review today.", type_::SM_13, t.foreground).wrap().grow(1.0).min_w(0.0)),
        );
    }
    let more = urgent.len().saturating_sub(3);
    for (k, (c, n)) in urgent.into_iter().take(3).enumerate() {
        let id = c.id.clone();
        let open = button(t, &format!("cp-next-open-{k}"), "Open", Variant::Ghost).on_press(move |s: &mut App| s.campaign_open = Some(id.clone()));
        let act = button(t, &format!("cp-next-act-{k}"), n.action, Variant::Primary).on_press(ask(n.request.clone()));
        top = top.child(kit::callout(t, &format!("cp-next-{k}"), urgency_tone(t, n.urgency), n.what.clone(), title_of(c), Some(row().gap(8.0).center_y().child(open).child(act))));
    }
    if more > 0 {
        top = top.child(label(format!("And {more} more below."), type_::XS, t.muted_foreground));
    }
    let needs = col().w_full().gap(10.0).child(label("Needs you today", type_::SM_MEDIUM, t.foreground).role("heading")).child(top);

    // Every campaign, grouped by where it stands.
    let groups: [(&str, &str, fn(&str) -> bool); 3] = [
        ("Running", "Work is under way or results are being checked", |st| st == "ACTIVE" || st == "REVIEW"),
        ("Being planned", "Drafts the agent can finish and start", |st| !matches!(st, "ACTIVE" | "REVIEW" | "CLOSED")),
        ("Finished", "Decided, with what was learned", |st| st == "CLOSED"),
    ];
    let mut sections = col().w_full().gap(16.0);
    for (name, sub, belongs) in groups {
        let members: Vec<&Campaign> = list.iter().filter(|c| belongs(&c.status)).collect();
        if members.is_empty() {
            continue;
        }
        let mut rows = col().w_full();
        for (k, c) in members.iter().enumerate() {
            if k > 0 {
                rows = rows.child(el().w_full().h(1.0).fill(t.foreground.alpha(0.07)));
            }
            rows = rows.child(campaign_row(t, c, &today));
        }
        sections = sections.child(kit::panel(t, &format!("cp-group-{name}"), &format!("{name} ({})", members.len()), Some(sub.into()), None, 0.0, rows));
    }

    // Where the open work goes, and what finished campaigns taught.
    let open: Vec<&Campaign> = list.iter().filter(|c| c.status != "CLOSED").collect();
    let channels = [("WEBSITE", "Website"), ("EMAIL", "Email"), ("PAID", "Paid ads"), ("SOCIAL", "Social"), ("OTHER", "Other")];
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
        "Work by channel",
        Some("Deliverables on open campaigns, and how many are recorded done".into()),
        None,
        0.0,
        if ch_rows.is_empty() { kit::note(t, "No deliverables on open campaigns yet.") } else { kit::bars_to(t, "cp-channel-bars", &ch_rows, None, Some(1.0)) },
    );
    let learned: Vec<&Campaign> = list.iter().filter(|c| c.status == "CLOSED" && !c.learning.trim().is_empty()).take(3).collect();
    let mut l = col().w_full().gap(14.0);
    if learned.is_empty() {
        l = l.child(kit::note(t, "Nothing recorded yet. When a campaign closes, what it taught shows here so the next plan starts from it."));
    }
    for (k, cp) in learned.iter().enumerate() {
        l = l.child(
            col()
                .key(format!("cp-learn-{k}"))
                .w_full()
                .gap(4.0)
                .child(row().w_full().gap(8.0).center_y().child(label(cp.title.clone(), type_::SM_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0)).child(status_chip(t, decision_name(&cp.decision), t.muted_foreground, t.accent)))
                .child(label(cp.learning.clone(), type_::SM_13, t.muted_foreground).wrap().max_lines(4)),
        );
    }
    let learned_card = kit::panel(t, "cp-learning", "What we learned", Some("Recorded by your team when a campaign closed".into()), None, 0.0, l);

    col()
        .w_full()
        .gap(20.0)
        .child(row().w_full().gap(16.0).items_start().child(col().grow(1.0).min_w(0.0).child(header(t))).child(button(t, "plan-campaign", "Plan a campaign", Variant::Primary).on_press(ask(PLAN.into()))))
        .child(needs)
        .child(sections)
        .child(kit::cols(vec![channel_card, learned_card]))
        .child(label("\"Done\" is what your team recorded. It does not prove anything was published, sent or caused a result.", type_::XS, t.muted_foreground).wrap())
        // Room for the decisions stack in the corner, so it never covers the last row.
        .child(el().h(72.0))
}

const PLAN: &str = "/campaign Plan a campaign for our most promising approved idea. Do not publish, send or spend without approval.";

/// One campaign in the list: what it is for, the number it is judged by, where it stands and what comes next.
fn campaign_row(t: &Theme, c: &Campaign, today: &str) -> El {
    let (ink, soft) = status_tone(t, &c.status);
    let (d, n) = c.done();
    let next = next_of(c, today);
    let (when, overdue) = timing(c, today);
    let id = c.id.clone();
    let title = title_of(c);
    let about = col()
        .w(0.0)
        .grow(5.0)
        .min_w(0.0)
        .gap(3.0)
        .child(row().w_full().gap(8.0).center_y().child(label(title.clone(), type_::SM_MEDIUM, t.foreground).truncate().min_w(0.0)).child(status_chip(t, status_name(&c.status), ink, soft)))
        .child(label(if c.goal.is_empty() { "No goal written yet".to_string() } else { c.goal.clone() }, type_::XS, t.muted_foreground).truncate())
        .children(scoreline(c).map(|line| label(line, type_::XS, t.foreground).wrap().max_lines(2)));
    let progress = col()
        .w(0.0)
        .grow(3.0)
        .min_w(0.0)
        .gap(6.0)
        .child(row().w_full().gap(8.0).center_y().child(track(t, &c.status)).child(label(STAGES[stage_index(&c.status)].0, type_::XS_MEDIUM, t.foreground).truncate()))
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(row().w(116.0).h(4.0).radius(2.0).fill(t.foreground.alpha(0.08)).child(el().w_frac(if n > 0 { d as f32 / n as f32 } else { 0.0 }).h_full().radius(2.0).fill(t.supported)))
                .child(label(if n == 0 { "No deliverables yet".to_string() } else { format!("{d} of {n} done") }, type_::XS11.features("'tnum' 1"), t.muted_foreground).truncate()),
        )
        .child(label(when, type_::XS11, if overdue { t.partial } else { t.muted_foreground }).truncate());
    let step = row()
        .w(0.0)
        .grow(4.0)
        .min_w(0.0)
        .gap(8.0)
        .items_start()
        .child(el().size(6.0, 6.0).radius(3.0).fill(urgency_tone(t, next.urgency)).mt(6.0))
        .child(label(next.what, type_::XS, t.foreground).wrap().max_lines(3).grow(1.0).min_w(0.0));
    row()
        .key(format!("cp-row-{}", c.id))
        .w_full()
        .py(14.0)
        .gap(20.0)
        .center_y()
        .role("button")
        .label(title)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .motion(CONTROL)
        .on_press(move |s: &mut App| s.campaign_open = Some(id.clone()))
        .child(about)
        .child(progress)
        .child(step)
        .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground))
}

fn header(t: &Theme) -> El {
    page_header(t, "Campaigns", "Each campaign is one push toward your goal. The agent plans it and prepares the work; you approve what goes out and decide what it taught.")
}

/// One labelled value of the plan.
fn field(t: &Theme, name: &str, value: &str) -> El {
    col().w_full().gap(2.0).child(label(name.to_string(), type_::XS11, t.muted_foreground)).child(label(value.to_string(), type_::SM_13, t.foreground).wrap())
}

/// One number of the scoreboard; an empty one says what is missing.
fn score(t: &Theme, name: &str, value: &str, empty: &str) -> El {
    let set = !value.trim().is_empty();
    col()
        .w(0.0)
        .grow(1.0)
        .min_w(0.0)
        .px(14.0)
        .py(12.0)
        .gap(4.0)
        .radius(10.0)
        .fill(t.foreground.alpha(0.04))
        .child(label(name.to_string(), type_::XS11, t.muted_foreground))
        .child(label(if set { value.trim().to_string() } else { empty.to_string() }, type_::SM_MEDIUM, if set { t.foreground } else { t.muted_foreground }).wrap().max_lines(3))
}

/// The four stages across the page, with the current one marked.
fn steps(t: &Theme, status: &str) -> El {
    let at = stage_index(status);
    let closed = status == "CLOSED";
    let mut r = row().key("cpd-steps").w_full().gap(10.0).items_start();
    for (i, (name, hint)) in STAGES.iter().enumerate() {
        let reached = closed || i <= at;
        let current = !closed && i == at;
        r = r.child(
            col()
                .w(0.0)
                .grow(1.0)
                .min_w(0.0)
                .gap(6.0)
                .child(el().w_full().h(3.0).radius(2.0).fill(if reached { t.chart.primary } else { t.foreground.alpha(0.08) }))
                .child(
                    row()
                        .gap(6.0)
                        .center_y()
                        .child(label(format!("{}. {name}", i + 1), type_::XS_MEDIUM, if reached { t.foreground } else { t.muted_foreground }))
                        .children(current.then(|| status_chip(t, "Now", t.review, t.review_soft)))
                        .children((reached && !current).then(|| ico(&icons::CHECK, 12.0, t.supported))),
                )
                .child(label(hint.to_string(), type_::XS11, t.muted_foreground).wrap().max_lines(2)),
        );
    }
    r
}

fn detail(t: &Theme, c: &Campaign) -> El {
    let today = today();
    let (ink, soft) = status_tone(t, &c.status);
    let (done, total) = c.done();
    let title = title_of(c);
    let next = next_of(c, &today);
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
    let (when, overdue) = timing(c, &today);
    let head = row().w_full().gap(16.0).items_start().child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(6.0)
            .child(row().gap(10.0).center_y().child(label(title.clone(), type_::TITLE, t.foreground).role("heading").truncate()).child(status_chip(t, status_name(&c.status), ink, soft)))
            .child(label(if c.goal.is_empty() { "No goal written yet.".to_string() } else { c.goal.clone() }, type_::SM, t.muted_foreground).wrap())
            .child(label(when, type_::XS, if overdue { t.partial } else { t.muted_foreground })),
    );
    let next_card = kit::callout(
        t,
        "cpd-next",
        urgency_tone(t, next.urgency),
        next.what.clone(),
        "The agent does the work and brings back anything that needs your approval.".into(),
        Some(button(t, "cpd-next-act", next.action, Variant::Primary).on_press(ask(next.request.clone()))),
    );

    // Deliverables: each one is a piece of work the agent can pick up.
    let mut items = col().w_full();
    if c.tasks.is_empty() {
        items = items.child(kit::note(t, "No deliverables yet. Ask the agent to draft them from the plan."));
    }
    for (k, x) in c.tasks.iter().enumerate() {
        let (name, tink, tsoft) = task_tone(t, &x.status);
        let overdue = late(x, &today);
        let mut meta = vec![words(&x.channel)];
        meta.push(if x.owner.is_empty() { "no owner".to_string() } else { format!("owner {}", x.owner) });
        meta.push(if x.due.is_empty() { "no due date".to_string() } else { format!("due {}{}", short(&x.due), if overdue { ", late" } else { "" }) });
        let request = format!(
            "/campaign-run Work on the deliverable \"{}\" of the campaign \"{title}\": read the plan, draft it (or finish the draft) and prepare it for my approval. Do not publish, send or spend without my approval.",
            x.title
        );
        let mut body = col()
            .grow(1.0)
            .min_w(0.0)
            .gap(3.0)
            .child(label(x.title.clone(), type_::SM_MEDIUM, t.foreground).wrap().max_lines(2))
            .child(label(meta.join(", "), type_::XS, if overdue { t.partial } else { t.muted_foreground }).truncate());
        if !x.note.trim().is_empty() {
            body = body.child(label(x.note.trim().to_string(), type_::XS, t.muted_foreground).wrap().max_lines(3));
        }
        let mut line = row().key(format!("cpd-task-{k}")).w_full().py(12.0).gap(12.0).items_start().child(el().size(8.0, 8.0).radius(4.0).fill(tink).mt(6.0)).child(body).child(status_chip(t, name, tink, tsoft));
        if x.status != "DONE" {
            line = line.child(button(t, &format!("cpd-task-act-{k}"), if x.status == "BLOCKED" { "Unblock" } else { "Work on this" }, Variant::Outline).on_press(ask(request)));
        }
        if k > 0 {
            items = items.child(el().w_full().h(1.0).fill(t.foreground.alpha(0.07)));
        }
        items = items.child(line);
    }
    let tasks = kit::panel(
        t,
        "cpd-tasks",
        "Deliverables",
        Some(if total == 0 { "The pieces of work this campaign needs".to_string() } else { format!("{done} of {total} recorded done. The agent drafts each one; anything that goes out waits for your approval.") }),
        None,
        0.0,
        items,
    );

    // Results: the number it is judged by, then what happened.
    let decided = c.decision != "UNDECIDED" && !c.decision.is_empty();
    let mut outcome = col()
        .w_full()
        .gap(12.0)
        .child(row().w_full().gap(10.0).items_stretch().child(score(t, "Judged by", &c.metric, "No metric yet")).child(score(t, "Before", &c.baseline, "No baseline")).child(score(t, "Target", &c.target, "No target")));
    outcome = outcome.child(if c.result.trim().is_empty() { kit::note(t, "No results recorded yet, so the impact is unknown.") } else { field(t, "What happened", &c.result) });
    if decided {
        outcome = outcome.child(row().gap(8.0).center_y().child(label("Decision", type_::XS11, t.muted_foreground)).child(status_chip(t, decision_name(&c.decision), t.foreground, t.accent)));
    }
    if !c.learning.trim().is_empty() {
        outcome = outcome.child(field(t, "What it taught", &c.learning));
    }
    if !c.next_move.trim().is_empty() {
        outcome = outcome.child(field(t, "Next move", &c.next_move));
    }
    let results = kit::panel(
        t,
        "cpd-results",
        "Results",
        Some("A change after a campaign is not proof the campaign caused it".into()),
        Some(button(t, "cpd-review", "Review with the agent", Variant::Outline).on_press(ask(review_request(&title)))),
        0.0,
        outcome,
    );

    // The plan: only what is written, then one line for what is not.
    let stage = stage_name(&c.funnel_stage);
    let plan_fields: [(&str, &str); 9] = [
        ("Who it is for", &c.audience),
        ("Offer", &c.offer),
        ("Message", &c.message),
        ("Why we think it works", &c.hypothesis),
        ("Main channel", &c.channel),
        ("Where people land", &c.destination),
        ("Budget (a plan, not approval to spend)", &c.budget),
        ("How it is tracked", &c.tracking_plan),
        ("Owner", &c.owner),
    ];
    let mut plan = col().w_full().gap(12.0);
    for (name, value) in plan_fields.iter().filter(|(_, v)| !v.trim().is_empty()) {
        plan = plan.child(field(t, name, value));
    }
    if stage != "Not set" {
        plan = plan.child(field(t, "Funnel stage", &stage));
    }
    let gaps = missing(c);
    if !gaps.is_empty() {
        plan = plan.child(
            col()
                .w_full()
                .px(12.0)
                .py(10.0)
                .gap(8.0)
                .radius(10.0)
                .fill(t.review.alpha(0.08))
                .child(label(format!("Still missing: {}.", list_of(&gaps, 9)), type_::XS, t.foreground).wrap())
                .child(row().child(button(t, "cpd-fill", "Fill the gaps with the agent", Variant::Outline).on_press(ask(format!(
                    "/campaign Finish the plan of the campaign \"{title}\". It still needs {}. Research what you can, propose each one and ask me at most one question.",
                    list_of(&gaps, 9)
                ))))),
        );
    }
    let plan_panel = kit::panel(
        t,
        "cpd-plan",
        "The plan",
        Some(format!(
            "Revision {}{}",
            c.revision,
            match c.created_by.as_str() {
                "ASSISTANT" => ", drafted by the agent",
                "OPERATOR" => ", drafted by your team",
                _ => "",
            }
        )),
        Some(button(t, "cpd-change", "Change the plan", Variant::Ghost).on_press(ask(format!("/campaign Change the plan of the campaign \"{title}\": ")))),
        0.0,
        plan,
    );

    col()
        .key(format!("campaign-{}", c.id))
        .w_full()
        .gap(16.0)
        .child(row().child(back))
        .child(head)
        .child(steps(t, &c.status))
        .child(next_card)
        .child(
            row()
                .w_full()
                .gap(16.0)
                .items_start()
                .child(col().w(0.0).grow(3.0).min_w(0.0).gap(16.0).child(tasks).child(results))
                .child(col().w(0.0).grow(2.0).min_w(0.0).child(plan_panel)),
        )
        .child(label("\"Done\" and the results are what your team recorded, not measurements OpenRecord made.", type_::XS, t.muted_foreground).wrap())
        .child(el().h(72.0))
}
