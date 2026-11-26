//! A campaign's timing: each deliverable on one scale of days, its plan as a
//! dashed outline up to the due date, the recorded work as a bar, and what ran
//! past the due date or waited on approval in amber. The hosted pages' views
//! and inquiries follow on the same days. A moment nobody recorded is not drawn.

use rune::{Color, El, LineCap, Shape, TextStyle, canvas, col, el, row};

use crate::api::{Campaign, CampaignTask, CampaignTimeline, TaskTimes};
use crate::format;
use crate::icons;
use crate::state::{App, Load};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{ico, label};

const ROW: f32 = 42.0;
const BAR: f32 = 18.0;
const DAY: f64 = 86_400.0;
const TNUM: &str = "'tnum' 1";

/// Seconds for a recorded moment, or for the start of a plain date.
fn at(s: &str) -> Option<f64> {
    if s.len() == 10 { format::parse_iso(&format!("{s}T00:00:00")) } else { format::parse_iso(s) }.map(|x| x as f64)
}

/// A due date lasts the whole day.
fn due(x: &CampaignTask) -> Option<f64> {
    at(&x.due).map(|d| d + DAY)
}

fn days(n: i64) -> String {
    if n == 1 { "1 day".into() } else { format!("{n} days") }
}

/// Whole days late (more than 0) or early (less), by the dates themselves.
fn against(finish: f64, due_end: f64) -> i64 {
    ((finish - due_end) / DAY).floor() as i64 + 1
}

struct Scale {
    from: f64,
    to: f64,
    w: f32,
}

impl Scale {
    fn x(&self, t: f64) -> f32 {
        ((t - self.from) / (self.to - self.from)) as f32 * self.w
    }

    /// Dates along the top, at a whole number of days apart that leaves them room.
    fn ticks(&self) -> Vec<(f32, String)> {
        let span = (self.to - self.from) / DAY;
        let most = (self.w / 78.0).max(1.0) as f64;
        let step = [1.0, 2.0, 3.0, 7.0, 14.0, 28.0, 56.0, 91.0, 182.0].into_iter().find(|s| span / s <= most).unwrap_or(365.0);
        let mut out = Vec::new();
        let mut t = (self.from / DAY).ceil() * DAY;
        while t < self.to {
            if self.x(t) + 44.0 < self.w {
                out.push((self.x(t), format::short_day(&format::iso_date(t as i64))));
            }
            t += step * DAY;
        }
        out
    }
}

fn times<'a>(tl: Option<&'a CampaignTimeline>, x: &CampaignTask) -> Option<&'a TaskTimes> {
    tl?.tasks.iter().find(|t| t.task_id == x.id)
}

/// The days to draw: everything planned or recorded, and today, with room for the labels.
fn range(c: &Campaign, tl: Option<&CampaignTimeline>, now: f64) -> (f64, f64) {
    let mut all: Vec<f64> = [at(&c.launch_date), at(&c.review_date).map(|d| d + DAY), Some(now)].into_iter().flatten().collect();
    all.extend(c.tasks.iter().filter_map(due));
    all.extend(c.tasks.iter().filter_map(|x| at(&x.due)));
    if let Some(tl) = tl {
        for t in &tl.tasks {
            all.extend([&t.added, &t.started, &t.finished, &t.waiting_from].into_iter().flatten().filter_map(|d| at(d)));
        }
        all.extend(tl.days.iter().filter_map(|d| at(&d.day)));
    }
    let (lo, hi) = all.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, x| (a.0.min(*x), a.1.max(*x)));
    let span = (hi - lo).max(7.0 * DAY);
    (lo - span * 0.02, lo + span * 1.16)
}

pub fn view(s: &App, t: &Theme, c: &Campaign) -> Option<El> {
    if c.tasks.is_empty() {
        return None;
    }
    let tl = s.campaign_timeline.as_ref().filter(|(id, _)| id == &c.id).map(|(_, x)| x);
    let now = format::now() as f64;
    let width = super::kit::analytics_width(s);
    let lead = if width < 620.0 { 150.0 } else { 250.0 };
    // Measured once drawn; an estimate until then.
    let plot = if s.campaign_plot_w > 0.0 { s.campaign_plot_w } else { (width - lead - 72.0).max(120.0) };
    let (from, to) = range(c, tl, now);
    let scale = Scale { from, to, w: plot };

    let late = c.tasks.iter().filter(|x| x.status != "DONE" && times(tl, x).is_none_or(|t| t.finished.is_none()) && due(x).is_some_and(|d| d < now)).count();
    let (done, total) = c.done();
    let head = row().w_full().gap(12.0).center_y().flex_wrap()
        .child(label("Timing", type_::SM_MEDIUM, t.foreground).role("heading"))
        .child(el().grow(1.0))
        .child(row().gap(6.0).center_y()
            .child(label(format!("{done} of {total}"), type_::SM_MEDIUM.features(TNUM), t.foreground))
            .child(label("done", type_::SM_13, t.muted_foreground))
            .children((late > 0).then(|| label(format!("{late} late"), type_::SM_13, t.partial)))
            .children((late == 0 && done < total && c.tasks.iter().filter(|x| x.status != "DONE").all(|x| !x.due.is_empty())).then(|| label("none late", type_::SM_13, t.supported))));

    let mut body = col().key("timing-rows").w_full();
    for (k, x) in c.tasks.iter().enumerate() {
        body = body.child(task_row(t, &scale, x, times(tl, x), now, lead, k));
    }
    let rows_h = ROW * c.tasks.len() as f32;
    let lines = grid(t, &scale, c, now, rows_h, lead);

    // Dates over the rows, each at its line.
    let mut dates = row().key("timing-dates").w_full().h(30.0).pl(lead);
    let mut strip = el().grow(1.0).min_w(0.0).h(30.0);
    for (x, name) in scale.ticks() {
        strip = strip.child(label(name, type_::AXIS, t.muted_foreground).absolute(x + 6.0, 8.0));
    }
    dates = dates.child(strip);

    let chart = col().w_full()
        .child(dates)
        .child(col().w_full().child(lines).child(body))
        .child(markers(t, &scale, c, now, lead))
        // Measures the plot; it draws nothing.
        .child(row().w_full().h(0.0).pl(lead).child(el().key("timing-measure").grow(1.0).min_w(0.0).h(0.0).on_layout(|s: &mut App, r: [f32; 4]| {
            if (s.campaign_plot_w - r[2]).abs() > 0.5 {
                s.campaign_plot_w = r[2];
            }
        })));
    // Only what is drawn is explained.
    let recorded = tl.is_some_and(|x| x.tasks.iter().any(|t| t.started.is_some() || t.finished.is_some()));
    let amber = c.tasks.iter().any(|x| times(tl, x).is_some_and(|v| {
        let start = v.started.as_deref().and_then(at);
        let end = v.finished.as_deref().and_then(at).unwrap_or(now);
        start.is_some() && (due(x).is_some_and(|d| d < end) || v.waiting_from.is_some())
    }));
    let planned = c.tasks.iter().any(|x| !x.due.is_empty());
    let legend = (planned || recorded).then(|| row().w_full().gap(16.0).flex_wrap().center_y()
        .children(planned.then(|| key(t, "Planned", el().border(1.0, t.muted_foreground.alpha(0.5)).border_dash(3.0, 2.0))))
        .children(recorded.then(|| key(t, "Recorded work", el().fill(t.review_soft).border(1.0, t.review.alpha(0.35)))))
        .children(amber.then(|| key(t, "Late or waiting on approval", el().fill(t.partial_soft).border(1.0, t.partial.alpha(0.45))))));
    let note = match tl {
        // Still being read: say nothing yet.
        None if !matches!(s.campaign_runs, Load::Ready(_) | Load::Failed(_)) => None,
        None => Some("Recorded start and finish dates are not available yet, so only due dates are drawn."),
        Some(_) if !recorded => Some("No start or finish is recorded yet. Dates appear as deliverables move on."),
        _ => None,
    };
    let panel = col().key("cp-timing").w_full().radius(12.0).fill(t.card).px(20.0).pt(18.0).pb(18.0).gap(12.0)
        .child(head).child(chart).children(legend)
        .children(note.map(|n| label(n, type_::XS, t.muted_foreground).wrap()))
        .children(tl.and_then(|x| results(t, &scale, x, lead)));
    Some(shadows(panel, &t.card_shadow))
}

fn key(t: &Theme, name: &str, swatch: El) -> El {
    row().gap(7.0).center_y().child(swatch.size(18.0, 10.0).radius(3.0)).child(label(name.to_string(), type_::XS, t.muted_foreground))
}

/// Faint lines at the dates, under the rows, with today's and the review's.
fn grid(t: &Theme, scale: &Scale, c: &Campaign, now: f64, h: f32, lead: f32) -> El {
    let mut g = el().key("timing-grid").absolute(0.0, 0.0).w_full().h(h).a11y_hidden();
    for (x, _) in scale.ticks() {
        g = g.child(el().absolute(lead + x, 0.0).size(1.0, h).fill(t.border));
    }
    if let Some(r) = at(&c.review_date) {
        let x = lead + scale.x(r);
        let dashes = (0..(h / 7.0) as usize).fold(Shape::new(), |s, i| s.line([0.5, i as f32 * 7.0], [0.5, i as f32 * 7.0 + 3.0], 1.0, LineCap::Butt, t.muted_foreground.alpha(0.5)));
        g = g.child(canvas(dashes).absolute(x, 0.0).size(1.0, h));
    }
    if c.status != "CLOSED" {
        g = g.child(el().absolute(lead + scale.x(now), 0.0).size(1.5, h).fill(t.supported.alpha(0.7)));
    }
    g
}

/// "Today" and "Review Dec 5" under their lines.
fn markers(t: &Theme, scale: &Scale, c: &Campaign, now: f64, lead: f32) -> El {
    let pill = |text: String, ink: Color, soft: Color, x: f32, w: f32| {
        row().absolute((lead + x - w / 2.0).clamp(lead, lead + (scale.w - w).max(0.0)), 5.0).size(w, 22.0).radius(6.0).center().fill(soft)
            .child(label(text, type_::XS_MEDIUM.features(TNUM), ink))
    };
    let mut m = el().key("timing-markers").w_full().h(32.0);
    let today = scale.x(now);
    let open = c.status != "CLOSED";
    if let Some(r) = at(&c.review_date) {
        let mut x = scale.x(r);
        // Kept clear of today's when the two are close.
        if open && (x - today).abs() < 92.0 {
            x = if x >= today { today + 92.0 } else { today - 92.0 };
        }
        m = m.child(pill(format!("Review {}", format::short_day(&c.review_date)), t.foreground, t.foreground.alpha(0.07), x, 104.0));
    }
    if open {
        m = m.child(pill("Today".into(), t.supported, t.supported_soft, today, 54.0));
    }
    m
}

/// The deliverable's state, as the rows' first mark.
fn mark(t: &Theme, x: &CampaignTask, finished: bool) -> El {
    match x.status.as_str() {
        _ if finished => row().size(16.0, 16.0).radius(8.0).center().border(1.5, t.supported).child(el().size(9.0, 9.0).radius(4.5).fill(t.supported)),
        "BLOCKED" => row().size(16.0, 16.0).center().child(ico(&icons::TRIANGLE_ALERT, 15.0, t.wrong)),
        "IN_PROGRESS" => row().size(16.0, 16.0).radius(8.0).center().border(1.5, t.review).child(el().size(5.0, 5.0).radius(2.5).fill(t.review)),
        _ => row().size(16.0, 16.0).radius(8.0).border(1.5, t.muted_foreground.alpha(0.5)).border_dash(2.5, 2.5),
    }
}

fn task_row(t: &Theme, scale: &Scale, x: &CampaignTask, tm: Option<&TaskTimes>, now: f64, lead: f32, k: usize) -> El {
    let get = |f: fn(&TaskTimes) -> &Option<String>| tm.and_then(|v| f(v).as_deref()).and_then(at);
    let (added, started, finished) = (get(|v| &v.added), get(|v| &v.started), get(|v| &v.finished));
    let (wait_from, wait_until) = (get(|v| &v.waiting_from), get(|v| &v.waiting_until));
    let due_end = due(x);
    let is_done = finished.is_some() || x.status == "DONE";
    // The work runs until it finished, or is still running today.
    let running = matches!(x.status.as_str(), "IN_PROGRESS" | "BLOCKED") || wait_from.is_some();
    let end = finished.or_else(|| (started.is_some() && !is_done && running).then_some(now));
    let top = (ROW - BAR) / 2.0;
    let bar = |a: f64, b: f64, fill: Color, edge: Color| {
        let w = (scale.x(b) - scale.x(a)).max(3.0);
        el().absolute(scale.x(a), top).size(w, BAR).radius((w / 2.0).min(4.0)).fill(fill).border(1.0, edge)
    };
    let mut plot = el().key(format!("timing-plot-{k}")).grow(1.0).min_w(0.0).h(ROW);
    let mut right = 0.0f32;
    // The plan: from when it was added to the end of its due date, or that day alone.
    if let Some(d) = due_end {
        let from = added.filter(|a| *a < d - DAY).unwrap_or(d - DAY);
        plot = plot.child(bar(from, d, Color::TRANSPARENT, t.muted_foreground.alpha(0.45)).border_dash(3.0, 2.5));
        right = right.max(scale.x(d));
    }
    let (blue, blue_edge) = (t.review_soft, t.review.alpha(0.35));
    let (amber, amber_edge) = (t.partial_soft, t.partial.alpha(0.45));
    if let (Some(a), Some(b)) = (started, end) {
        let split = due_end.filter(|d| *d < b && *d > a);
        match (split, due_end) {
            (Some(d), _) => plot = plot.child(bar(a, d, blue, blue_edge)).child(bar(d, b, amber, amber_edge)),
            (None, Some(d)) if d <= a => plot = plot.child(bar(a, b, amber, amber_edge)),
            _ => plot = plot.child(bar(a, b, blue, blue_edge)),
        }
        right = right.max(scale.x(b));
        if let Some(w) = wait_from.filter(|w| *w < b) {
            plot = plot.child(bar(w.max(a), wait_until.unwrap_or(b).clamp(w.max(a), b), amber, amber_edge));
        }
    } else if let Some(b) = finished {
        // Only the finish was recorded: a mark at that moment.
        plot = plot.child(el().absolute(scale.x(b) - 2.0, top).size(4.0, BAR).radius(2.0).fill(t.review));
        right = right.max(scale.x(b) + 2.0);
    }
    let text = match (started, finished) {
        (Some(a), Some(b)) => days((((b - a) / DAY).round() as i64).max(1)),
        (None, Some(b)) => format!("Done {}", format::short_day(&format::iso_date(b as i64))),
        (Some(a), None) if end.is_some() => format!("Day {}", ((now - a) / DAY).floor() as i64 + 1),
        _ if is_done => "Done".into(),
        _ if x.due.is_empty() => "No due date".into(),
        _ => format!("Due {}", format::short_day(&x.due)),
    };
    let chip = match (finished, due_end) {
        (Some(b), Some(d)) => match against(b, d) {
            0 => Some(("On time".to_string(), t.supported, t.supported_soft)),
            n if n > 0 => Some((format!("{} late", days(n)), t.partial, t.partial_soft)),
            n => Some((format!("{} early", days(-n)), t.supported, t.supported_soft)),
        },
        (None, Some(d)) if !is_done && d < now => Some((format!("{} late", days(against(now, d).max(1))), t.partial, t.partial_soft)),
        _ if wait_from.is_some() && wait_until.is_none() && !is_done => Some(("Needs you".into(), t.partial, t.partial_soft)),
        _ if x.status == "BLOCKED" => Some(("Blocked".into(), t.wrong, t.wrong_soft)),
        _ => None,
    };
    // After the bar, or held inside the right edge.
    let chip_w = chip.as_ref().map_or(0.0, |c| c.0.len() as f32 * 6.4 + 20.0);
    let label_w = text.len() as f32 * 6.8 + chip_w;
    let x0 = (right + 9.0).min((scale.w - label_w).max(0.0));
    plot = plot.child(
        // On the card's colour, so a line behind never crosses the words.
        row().absolute(x0 - 3.0, (ROW - 24.0) / 2.0).h(24.0).px(3.0).radius(5.0).gap(8.0).center_y().fill(t.card)
            .child(label(text, type_::SM_13.features(TNUM), t.foreground))
            .children(chip.map(|(name, ink, soft)| row().h(20.0).px(7.0).radius(6.0).center().fill(soft).child(label(name, type_::XS_MEDIUM.features(TNUM), ink)))),
    );
    row().key(format!("timing-{k}")).w_full().h(ROW).center_y()
        .role("group")
        .label(x.title.clone())
        .child(
            row().w(lead).min_w(lead).pr(12.0).gap(11.0).center_y()
                .child(mark(t, x, is_done))
                .child(label(x.title.clone(), type_::SM_13, if is_done || x.status != "TODO" { t.foreground } else { t.muted_foreground }).truncate().grow(1.0).min_w(0.0)),
        )
        .child(plot)
}

/// Views and inquiries on the campaign's live pages, on the same days.
fn results(t: &Theme, scale: &Scale, tl: &CampaignTimeline, lead: f32) -> Option<El> {
    let first = at(&tl.days.first()?.day)?;
    let last = at(&tl.days.last()?.day)?;
    let n = ((last - first) / DAY).round().max(0.0) as usize + 1;
    // A day with no row had no visits: the pages count every one.
    let series = |pick: fn(&crate::api::TimelineDay) -> f64| -> Vec<f64> {
        (0..n).map(|i| {
            let day = format::iso_date((first + i as f64 * DAY) as i64);
            tl.days.iter().find(|d| d.day == day).map_or(0.0, pick)
        }).collect()
    };
    let chart = |name: &str, color: Color, values: Vec<f64>| result_row(t, scale, name, color, first, values, lead);
    Some(
        col().key("timing-results").w_full().pt(18.0).gap(6.0)
            .child(row().w_full().center_y().gap(12.0)
                .child(label("Results on the same days", type_::SM_MEDIUM, t.foreground).role("heading"))
                .child(el().grow(1.0))
                .child(label("Live campaign pages", type_::SM_13, t.muted_foreground)))
            .child(chart("Page views", t.chart.primary, series(|d| d.views)))
            .child(chart("Inquiries", t.chart.tone(1), series(|d| d.inquiries)))
            .child(label("Views are page loads, not people. Nothing here shows the campaign caused a change.", type_::XS, t.muted_foreground).wrap()),
    )
}

fn result_row(t: &Theme, scale: &Scale, name: &str, color: Color, first: f64, values: Vec<f64>, lead: f32) -> El {
    const H: f32 = 104.0;
    const TOP: f32 = 30.0;
    let total: f64 = values.iter().sum();
    let (peak_at, peak) = values.iter().copied().enumerate().fold((0, 0.0), |a, (i, v)| if v > a.1 { (i, v) } else { a });
    let x = |i: usize| scale.x(first + i as f64 * DAY);
    let y = |v: f64| H - 6.0 - (v / peak.max(1.0)) as f32 * (H - 6.0 - TOP);
    let pts: Vec<[f32; 2]> = values.iter().enumerate().map(|(i, v)| [x(i), y(*v)]).collect();
    let mut shape = Shape::new().line([0.0, H - 6.0], [scale.w, H - 6.0], 1.0, LineCap::Butt, t.border);
    if pts.len() > 1 {
        let line = super::charts::monotone(&pts);
        let mut area = line.clone();
        area.push([pts[pts.len() - 1][0], H - 6.0]);
        area.push([pts[0][0], H - 6.0]);
        shape = shape.fill(area, color.alpha(0.13)).stroke_with(line, false, 1.75, LineCap::Round, color);
    }
    let mut plot = el().grow(1.0).min_w(0.0).h(H);
    for (gx, _) in scale.ticks() {
        plot = plot.child(el().absolute(gx, 0.0).size(1.0, H).fill(t.border));
    }
    if peak > 0.0 {
        let p = [x(peak_at), y(peak)];
        let q = [p[0] + 0.01, p[1]];
        shape = shape.stroke_with(vec![p, q], false, 9.0, LineCap::Round, color).stroke_with(vec![p, q], false, 5.0, LineCap::Round, t.card);
        plot = plot.child(canvas(shape).absolute(0.0, 0.0).size(scale.w, H));
        plot = plot.child(row().absolute((p[0] - 22.0).clamp(0.0, (scale.w - 44.0).max(0.0)), p[1] - 28.0).size(44.0, 19.0).radius(5.0).center().fill(color.alpha(0.16))
            .child(label(crate::insights::int(peak), type_::XS11.features(TNUM), t.foreground)));
    } else {
        plot = plot.child(canvas(shape).absolute(0.0, 0.0).size(scale.w, H));
    }
    let side = col().w(lead).min_w(lead).h(H).justify_center().gap(2.0)
        .child(row().gap(8.0).center_y().child(el().size(9.0, 9.0).radius(2.5).fill(color)).child(label(name.to_string(), type_::SM_13, t.muted_foreground)))
        .child(row().gap(6.0).items_end()
            .child(label(crate::insights::int(total), TextStyle::new(20.0, 600.0).lh(26.0).features(TNUM), t.foreground))
            .child(label("in total", type_::XS.lh(22.0), t.muted_foreground)))
        .child(label(format!("{} a day on average", crate::insights::int((total / values.len().max(1) as f64).round())), type_::XS, t.muted_foreground));
    row().w_full().h(H).center_y().child(side).child(plot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_early_on_time_and_late_follow_the_calendar() {
        let d = at("2026-11-10").unwrap() + DAY;
        assert_eq!(against(at("2026-11-10T15:00:00.000Z").unwrap(), d), 0);
        assert_eq!(against(at("2026-11-11T01:00:00.000Z").unwrap(), d), 1);
        assert_eq!(against(at("2026-11-08T09:00:00.000Z").unwrap(), d), -2);
    }

    #[test]
    fn the_range_holds_everything_planned_and_today() {
        let mut s = App::new();
        crate::fixtures::campaign_open(&mut s);
        let c = s.campaigns.ready().unwrap()[0].clone();
        let now = format::now() as f64;
        let (lo, hi) = range(&c, None, now);
        assert!(lo < now && now < hi);
        assert!(c.tasks.iter().filter_map(due).all(|d| lo < d && d < hi));
    }
}
