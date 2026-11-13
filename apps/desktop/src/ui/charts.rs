//! Charts in the web Overview's language (`components/charts.tsx`).
//!
//! [`area_trend`] draws one metric over days as a line over a soft area (a
//! rate as its trailing average, each day a faint dot), the comparison as a
//! dashed grey line, an optional dotted comparison line (the
//! trailing average), three faint gridlines, the value axis on the right and
//! a tooltip for the day under the pointer. [`verdict_bar`] is `VerdictBar`.

use rune::{Color, El, LineCap, Shape, canvas, col, el, row};

use crate::format;
use crate::insights::Verdicts;
use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::label;

/// The verdict colours in the web's order (`verdictSeries`), with their names.
pub fn verdict_series(t: &Theme) -> [(&'static str, Color); 5] {
    let c = &t.chart;
    [("Wrong", c.wrong), ("Can't tell", c.unknown), ("Partly right", c.partial), ("Not checked yet", c.unreviewed), ("Correct", c.supported)]
}

fn verdict_values(v: &Verdicts) -> [f64; 5] {
    [v.wrong as f64, v.unknown as f64, v.partial as f64, v.unreviewed as f64, v.supported as f64]
}

fn dot_label(t: &Theme, name: &str, c: Color) -> El {
    row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(4.0).fill(c)).child(label(name.to_string(), type_::XS11, t.muted_foreground))
}

/// The legend entry for a dotted comparison line.
pub fn dotted_label(t: &Theme, name: &str) -> El {
    let dots = Shape::new().stroke_with(vec![[1.0, 1.0], [1.01, 1.0]], false, 1.5, LineCap::Round, t.chart.compare);
    let dots = (1..3).fold(dots, |s, i| s.stroke_with(vec![[1.0 + i as f32 * 5.0, 1.0], [1.01 + i as f32 * 5.0, 1.0]], false, 1.5, LineCap::Round, t.chart.compare));
    row().gap(6.0).center_y().child(canvas(dots).size(12.0, 2.0)).child(label(name.to_string(), type_::XS11, t.muted_foreground))
}

/// One metric's legend under a trend: its dot and, when shown, the average's dots.
pub fn trend_legend(t: &Theme, name: &str, color: Color, average: Option<&str>) -> El {
    let mut r = row().gap(16.0).center_y().flex_wrap().child(dot_label(t, name, color));
    if let Some(a) = average {
        r = r.child(dotted_label(t, a));
    }
    r
}

/// Trailing moving average over the last `window` values that exist.
pub fn trailing(values: &[Option<f64>], window: usize) -> Vec<Option<f64>> {
    (0..values.len())
        .map(|i| {
            let slice: Vec<f64> = values[i.saturating_sub(window - 1)..=i].iter().flatten().copied().collect();
            (!slice.is_empty()).then(|| (slice.iter().sum::<f64>() / slice.len() as f64 * 1000.0).round() / 1000.0)
        })
        .collect()
}

/// The average window the web uses: a week, or three days in a 7-day period.
pub fn window(days: u32) -> usize {
    if days > 7 { 7 } else { 3 }
}

/// What a trend draws.
pub struct Trend<'a> {
    /// Element key, also the hover key.
    pub key: &'a str,
    pub label: &'a str,
    pub dates: &'a [String],
    pub values: &'a [Option<f64>],
    /// The dotted comparison line and its name.
    pub compare: Option<(&'a [Option<f64>], String)>,
    pub color: Color,
    pub height: f32,
    /// A 0 to 100 axis, values shown as whole percents.
    pub percent: bool,
    /// About how wide the chart lays out, for spacing dots and date labels.
    pub width_hint: f32,
}

impl<'a> Trend<'a> {
    pub fn new(key: &'a str, label: &'a str, dates: &'a [String], values: &'a [Option<f64>], color: Color) -> Self {
        Trend { key, label, dates, values, compare: None, color, height: 260.0, percent: false, width_hint: 800.0 }
    }
    pub fn compare(mut self, values: &'a [Option<f64>], name: String) -> Self {
        self.compare = Some((values, name));
        self
    }
    pub fn height(mut self, h: f32) -> Self {
        self.height = h;
        self
    }
    pub fn percent(mut self) -> Self {
        self.percent = true;
        self
    }
    pub fn width_hint(mut self, w: f32) -> Self {
        self.width_hint = w;
        self
    }
    fn format(&self, v: f64) -> String {
        if self.percent { format!("{}%", v.round()) } else { format_count((v * 10.0).round() / 10.0) }
    }
}

/// Coordinates inside the plot: x from 0 to 1 across the days, y from 0 (top) to 100.
const VIEW_H: f32 = 100.0;
/// Room above the top gridline, as a share of the plot (the web's 8-point top margin).
const TOP: f32 = 4.0;
const AXIS_W: f32 = 40.0;

fn nice_max(max: f64) -> f64 {
    if max <= 0.0 {
        return 2.0;
    }
    // Two equal whole steps, so all three ticks are round numbers.
    let half = max / 2.0;
    let mag = 10f64.powf(half.log10().floor()).max(1.0);
    let step = [1.0, 2.0, 2.5, 5.0, 10.0].iter().map(|m| m * mag).find(|s| *s >= half && (s.fract() == 0.0)).unwrap_or(10.0 * mag);
    step * 2.0
}

/// The value axis for a line: from zero when the values sit near it, otherwise
/// a round range around them, so a metric that moves between 90 and 140 shows
/// its shape instead of a flat line near the top. Two equal steps, three ticks.
fn nice_range(min: f64, max: f64) -> (f64, f64) {
    if min <= 0.0 || max <= 0.0 || min < max * 0.55 {
        return (0.0, nice_max(max));
    }
    let raw = ((max - min) * 1.15 / 2.0).max(max.abs() * 0.01).max(1e-9);
    let mut mag = 10f64.powf(raw.log10().floor());
    loop {
        for m in [1.0, 2.0, 2.5, 5.0, 10.0] {
            let step = m * mag;
            let lo = (min / step).floor() * step;
            if step >= raw && lo + 2.0 * step >= max {
                return (lo.max(0.0), lo.max(0.0) + 2.0 * step);
            }
        }
        mag *= 10.0;
    }
}

/// Monotone cubic interpolation (d3's `curveMonotoneX`), sampled to a polyline.
fn monotone(pts: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let d: Vec<f32> = pts.windows(2).map(|w| (w[1][1] - w[0][1]) / (w[1][0] - w[0][0]).max(1e-6)).collect();
    let mut m = vec![0.0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
        let h = a * a + b * b;
        if h > 9.0 {
            let tau = 3.0 / h.sqrt();
            m[i] = tau * a * d[i];
            m[i + 1] = tau * b * d[i];
        }
    }
    let mut out = Vec::with_capacity(n * 8);
    for i in 0..n - 1 {
        let ([x0, y0], [x1, y1]) = (pts[i], pts[i + 1]);
        let h = x1 - x0;
        for k in 0..8 {
            let s = k as f32 / 8.0;
            let (h00, h10, h01, h11) = (2.0 * s.powi(3) - 3.0 * s * s + 1.0, s.powi(3) - 2.0 * s * s + s, -2.0 * s.powi(3) + 3.0 * s * s, s.powi(3) - s * s);
            out.push([x0 + s * h, h00 * y0 + h10 * h * m[i] + h01 * y1 + h11 * h * m[i + 1]]);
        }
    }
    out.push(pts[n - 1]);
    out
}

/// Dots every `gap` points along a polyline drawn `w` × `h` points.
fn dots(line: &[[f32; 2]], w: f32, h: f32, gap: f32) -> Vec<[f32; 2]> {
    let (sx, sy) = (w, h / VIEW_H);
    let mut out = Vec::new();
    let mut carry = 0.0;
    for seg in line.windows(2) {
        let (dx, dy) = ((seg[1][0] - seg[0][0]) * sx, (seg[1][1] - seg[0][1]) * sy);
        let len = (dx * dx + dy * dy).sqrt();
        let mut at = carry;
        while at < len {
            let f = at / len;
            out.push([seg[0][0] + (seg[1][0] - seg[0][0]) * f, seg[0][1] + (seg[1][1] - seg[0][1]) * f]);
            at += gap;
        }
        carry = at - len;
    }
    out
}

/// The day under the pointer, if it is over this chart.
fn hovered(s: &App, key: &str) -> Option<usize> {
    s.chart_hover.as_ref().filter(|(k, _)| k == key).map(|(_, i)| *i)
}

pub fn area_trend(s: &App, t: &Theme, tr: Trend<'_>) -> El {
    let n = tr.values.len();
    let hover = hovered(s, tr.key);
    let all: Vec<f64> = tr.values.iter().chain(tr.compare.iter().flat_map(|c| c.0.iter())).flatten().copied().collect();
    let (lo, max) = if tr.percent { (0.0, 100.0) } else { nice_range(all.iter().copied().fold(f64::INFINITY, f64::min), all.iter().copied().fold(0.0, f64::max)) };
    let x = |i: usize| if n <= 1 { 0.5 } else { i as f32 / (n - 1) as f32 };
    let y = |v: f64| VIEW_H - (((v - lo) / (max - lo).max(1e-9)) as f32).clamp(0.0, 1.0) * (VIEW_H - TOP);
    let line_of = |vals: &[Option<f64>]| -> Vec<[f32; 2]> { vals.iter().enumerate().filter_map(|(i, v)| v.map(|v| [x(i), y(v)])).collect() };

    let mut shape = Shape::new();
    for k in 0..3 {
        let gy = y(lo + (max - lo) * k as f64 / 2.0);
        shape = shape.line([0.0, gy], [1.0, gy], 1.0, LineCap::Butt, t.chart.grid);
    }
    if let Some(i) = hover {
        shape = shape.line([x(i), TOP], [x(i), VIEW_H], 1.0, LineCap::Butt, t.border);
    }
    // A rate, or a count only taken every few days (mostly zero days), reads as
    // its trailing average, the solid line; each day that has a value is a
    // faint dot behind it. Otherwise the line runs through every day.
    let zeros = tr.values.iter().filter(|v| matches!(v, Some(x) if *x == 0.0)).count();
    let sparse = !tr.percent && zeros * 3 >= n.max(1);
    // A chart compared with its own trailing average is read as that average.
    let averaged = tr.compare.as_ref().is_some_and(|c| c.1.to_lowercase().contains("average"));
    let smooth = (tr.percent || sparse || averaged) && tr.compare.is_some();
    if smooth {
        for p in tr.values.iter().enumerate().filter_map(|(i, v)| v.filter(|v| *v > 0.0 || tr.percent).map(|v| [x(i), y(v)])) {
            shape = shape.stroke_with(vec![p, [p[0] + 0.0001, p[1]]], false, 3.5, LineCap::Round, tr.color.alpha(0.28));
        }
    }
    // The line is always a smooth curve through its days.
    let main = monotone(&line_of(if smooth { tr.compare.as_ref().map(|c| c.0).unwrap_or(&[]) } else { tr.values }));
    let points = if smooth { tr.compare.as_ref().map(|c| c.0.iter().flatten().count()).unwrap_or(0) } else { tr.values.iter().flatten().count() };
    if main.len() >= 2 {
        // A soft wash under the line only when there is enough of it to read as a trend.
        // It fades from the line down to the axis: bands that overlap most just under the line.
        if points >= 5 {
            const BANDS: usize = 18;
            for k in 1..=BANDS {
                let f = k as f32 / BANDS as f32;
                let mut area: Vec<[f32; 2]> = main.clone();
                area.extend(main.iter().rev().map(|p| [p[0], p[1] + (VIEW_H - p[1]) * f]));
                shape = shape.fill(area, tr.color.alpha(0.011));
            }
        }
        // The comparison sits behind the line.
        if let Some((vals, _)) = tr.compare.as_ref().filter(|_| !smooth) {
            let pts = dots(&monotone(&line_of(vals)), tr.width_hint, tr.height, 4.0);
            for pair in pts.chunks(2).filter(|c| c.len() == 2) {
                shape = shape.stroke_with(vec![pair[0], pair[1]], false, 1.25, LineCap::Round, t.chart.compare);
            }
        }
        shape = shape.stroke_with(main.clone(), false, 2.0, LineCap::Round, tr.color);
        // The latest day, marked: where the line stands now.
        if let Some(p) = main.last().filter(|_| hover.is_none()) {
            let q = [p[0] - 0.0001, p[1]];
            shape = shape.stroke_with(vec![q, *p], false, 10.0, LineCap::Round, tr.color.alpha(0.22)).stroke_with(vec![q, *p], false, 5.0, LineCap::Round, tr.color);
        }
    } else if let Some(p) = main.first() {
        shape = shape.stroke_with(vec![*p, [p[0] + 0.0001, p[1]]], false, 5.0, LineCap::Round, tr.color);
    }
    if let Some(v) = hover.and_then(|i| tr.values.get(i).copied().flatten().map(|v| (i, v))) {
        let p = [x(v.0), y(v.1)];
        let q = [p[0] + 0.0001, p[1]];
        shape = shape.stroke_with(vec![p, q], false, 11.0, LineCap::Round, t.card).stroke_with(vec![p, q], false, 7.0, LineCap::Round, tr.color);
    }
    let shape = shape.view_box(1.0, VIEW_H);

    // Hit areas, one per day, that set the hovered day.
    let mut hits = row().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    for i in 0..n {
        let key = tr.key.to_string();
        let mut cell = col().grow(1.0).h_full().key(format!("{}-day-{i}", tr.key)).on_hover_change(move |s: &mut App, inside, _tx| {
            if inside {
                s.chart_hover = Some((key.clone(), i));
            } else if s.chart_hover.as_ref() == Some(&(key.clone(), i)) {
                s.chart_hover = None;
            }
        });
        if hover == Some(i) {
            let card = tooltip(t, &tr, i);
            cell = cell.child(if i > n / 2 { card.pin(None, Some(0.0), Some(14.0), None) } else { card.pin(Some(14.0), Some(0.0), None, None) });
        }
        hits = hits.child(cell);
    }

    let plot = col().grow(1.0).min_w(0.0).h(tr.height).child(canvas(shape).w_full().h_full()).child(hits);
    let mut scale = col().w(AXIS_W).h(tr.height);
    for k in 0..3 {
        let v = lo + (max - lo) * k as f64 / 2.0;
        let top = y(v) / VIEW_H * tr.height - 7.0;
        scale = scale.child(label(tr.format(v), type_::AXIS, t.chart.axis).absolute(8.0, top.max(0.0)));
    }
    col()
        .key(tr.key)
        .w_full()
        .child(row().w_full().child(plot).child(scale))
        .child(row().w_full().pr(AXIS_W).child(axis(t, tr.dates, tr.width_hint)))
}

fn tooltip(t: &Theme, tr: &Trend<'_>, i: usize) -> El {
    let date = tr.dates.get(i).map(|d| format::short_day(d)).unwrap_or_default();
    let value = |v: Option<f64>| v.map(|v| tr.format(v)).unwrap_or_else(|| "—".into());
    let line = |mark: El, name: String, v: String| {
        row().w_full().gap(8.0).center_y().child(mark).child(label(name, type_::XS, t.muted_foreground).grow(1.0)).child(label(v, type_::XS_MEDIUM.features("'tnum' 1"), t.foreground))
    };
    let mut c = col()
        .min_w(168.0)
        .px(12.0)
        .py(8.0)
        .gap(4.0)
        .radius(8.0)
        .fill(t.popover)
        .child(label(date, type_::XS11, t.muted_foreground))
        .child(line(el().size(12.0, 2.0).radius(1.0).fill(tr.color), tr.label.to_string(), value(tr.values.get(i).copied().flatten())));
    if let Some((vals, name)) = &tr.compare {
        let dots = (0..3).fold(Shape::new(), |s, k| s.stroke_with(vec![[1.0 + k as f32 * 5.0, 1.0], [1.01 + k as f32 * 5.0, 1.0]], false, 1.5, LineCap::Round, t.chart.compare));
        c = c.child(line(canvas(dots).size(12.0, 2.0), name.clone(), value(vals.get(i).copied().flatten())));
    }
    shadows(c, &t.float_shadow)
}

/// Dates under a chart, spaced as the web's axis spaces them (at least 40 points apart).
fn axis(t: &Theme, dates: &[String], width: f32) -> El {
    let n = dates.len();
    let mut r = row().w_full().pt(10.0);
    if n == 0 {
        return r;
    }
    let k = ((width / 90.0).floor() as usize).clamp(2, 8).min(n);
    for j in 0..k {
        let i = if k == 1 { 0 } else { j * (n - 1) / (k - 1) };
        if j > 0 {
            r = r.child(el().grow(1.0));
        }
        r = r.child(label(format::short_day(&dates[i]), type_::AXIS, t.chart.axis));
    }
    r
}

/// A thin bar split in proportion to each verdict, empty when nothing was judged.
pub fn verdict_bar(t: &Theme, v: &Verdicts, width: f32) -> El {
    verdict_bar_fill(t, v).w(width)
}

/// [`verdict_bar`] that fills its parent's width.
pub fn verdict_bar_fill(t: &Theme, v: &Verdicts) -> El {
    let mut r = row().w_full().h(6.0).radius(3.0).clip_rounded(3.0).fill(t.accent).gap(1.0);
    for ((_, c), x) in verdict_series(t).iter().zip(verdict_values(v)) {
        if x > 0.0 {
            r = r.child(el().h_full().grow(x as f32).fill(*c));
        }
    }
    r
}

pub fn format_count(x: f64) -> String {
    if x >= 10_000.0 {
        format!("{:.0}k", x / 1000.0)
    } else if x.fract() == 0.0 {
        crate::insights::int(x)
    } else {
        format!("{x:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_average_skips_missing_days() {
        let v = [Some(2.0), None, Some(4.0), Some(6.0)];
        assert_eq!(trailing(&v, 3), vec![Some(2.0), Some(2.0), Some(3.0), Some(5.0)]);
    }

    #[test]
    fn a_line_far_from_zero_gets_a_round_range_around_it() {
        assert_eq!(nice_range(92.0, 138.0), (50.0, 150.0));
        assert_eq!(nice_range(10.2, 12.6), (10.0, 14.0));
        // Near zero, or spanning most of the way to it, the axis starts at zero.
        assert_eq!(nice_range(3.0, 41.0), (0.0, 50.0));
        assert_eq!(nice_range(0.0, 7.0), (0.0, 10.0));
        let (lo, hi) = nice_range(1180.0, 1320.0);
        assert!(lo <= 1180.0 && hi >= 1320.0 && lo > 0.0);
    }

    #[test]
    fn axis_ends_on_round_steps() {
        assert_eq!(nice_max(3.0), 4.0);
        assert_eq!(nice_max(7.0), 10.0);
        assert_eq!(nice_max(41.0), 50.0);
        assert_eq!(nice_max(0.0), 2.0);
    }

    #[test]
    fn monotone_passes_through_its_points() {
        let pts = [[0.0, 10.0], [1.0, 20.0], [2.0, 15.0]];
        let out = monotone(&pts);
        assert_eq!(out.first(), Some(&pts[0]));
        assert_eq!(out.last(), Some(&pts[2]));
        assert!(out.contains(&pts[1]));
    }
}
