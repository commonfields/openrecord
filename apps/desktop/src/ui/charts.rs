//! Small charts in the web Overview's style (`components/charts.tsx`): daily
//! stacked bars, a line over an area, and a proportional verdict bar. Bars
//! are laid out as elements; lines are drawn on a stretching canvas.

use rune::{Color, El, Shape, canvas, col, el, row};

use crate::format;
use crate::insights::Verdicts;
use crate::theme::{Theme, type_};
use crate::ui::widgets::label;

/// The verdict colours in the web's order, with their names.
pub fn verdict_series(t: &Theme) -> [(&'static str, Color); 5] {
    [("Supported", t.supported), ("Partially correct", t.partial), ("Wrong", t.wrong), ("Not enough information", t.unknown), ("Needs review", t.review)]
}

fn verdict_values(v: &Verdicts) -> [f64; 5] {
    [v.supported as f64, v.partial as f64, v.wrong as f64, v.unknown as f64, v.unreviewed as f64]
}

/// A legend: a dot and a name per series.
pub fn legend(t: &Theme, series: &[(&str, Color)]) -> El {
    let mut r = row().gap(14.0).flex_wrap();
    for (name, c) in series {
        r = r.child(
            row()
                .gap(6.0)
                .center_y()
                .child(el().size(8.0, 8.0).radius(2.0).fill(*c))
                .child(label(name.to_string(), type_::XS, t.muted_foreground)),
        );
    }
    r
}

/// Dates under a chart: first, middle and last.
fn axis(t: &Theme, dates: &[String]) -> El {
    let pick = |i: usize| dates.get(i).map(|d| format::short_day(d)).unwrap_or_default();
    let n = dates.len();
    row()
        .w_full()
        .pt(6.0)
        .child(label(pick(0), type_::XS2, t.muted_foreground))
        .child(el().grow(1.0))
        .children((n > 2).then(|| label(pick(n / 2), type_::XS2, t.muted_foreground)))
        .child(el().grow(1.0))
        .child(label(if n > 1 { pick(n - 1) } else { String::new() }, type_::XS2, t.muted_foreground))
}

/// One bar per day, its parts stacked from the bottom in the series' colours.
pub fn stacked_bars(t: &Theme, key: &str, dates: &[String], values: &[Vec<f64>], colors: &[Color], height: f32) -> El {
    let max = values.iter().map(|v| v.iter().sum::<f64>()).fold(0.0, f64::max);
    let gap = if dates.len() > 45 { 1.0 } else { 3.0 };
    let mut bars = row().w_full().h(height).gap(gap).items_end();
    for (i, v) in values.iter().enumerate() {
        let total: f64 = v.iter().sum();
        let mut bar = col().grow(1.0).min_w(1.0).h(if max > 0.0 { (total / max) as f32 * height } else { 0.0 }).radius(2.0).clip_rounded(2.0);
        // Top segment first, so the first series sits at the bottom.
        for (j, part) in v.iter().enumerate().rev() {
            if *part > 0.0 {
                bar = bar.child(el().w_full().grow(*part as f32).fill(colors.get(j).copied().unwrap_or(t.muted_foreground)));
            }
        }
        if total == 0.0 {
            bar = col().grow(1.0).min_w(1.0).h(2.0).radius(1.0).fill(t.border);
        }
        let day = dates.get(i).cloned().unwrap_or_default();
        bars = bars.child(bar.key(format!("{key}-bar-{i}")).help(format!("{}: {}", format::short_day(&day), format_count(total))));
    }
    let scale = col()
        .h(height)
        .pr(8.0)
        .child(label(format_count(max), type_::XS2, t.muted_foreground))
        .child(el().grow(1.0))
        .child(label("0", type_::XS2, t.muted_foreground));
    col()
        .key(key)
        .w_full()
        .child(row().w_full().child(scale).child(col().grow(1.0).min_w(0.0).border_sides([0.0, 0.0, 1.0, 0.0], t.border).child(bars)))
        .child(row().w_full().pl(24.0).child(axis(t, dates)))
}

/// Daily answers by verdict.
pub fn verdict_bars(t: &Theme, key: &str, dates: &[String], days: &[Verdicts], height: f32) -> El {
    let colors: Vec<Color> = verdict_series(t).iter().map(|(_, c)| *c).collect();
    let values: Vec<Vec<f64>> = days.iter().map(|v| verdict_values(v).to_vec()).collect();
    stacked_bars(t, key, dates, &values, &colors, height)
}

/// A line over a soft area, for a daily series. Missing days break nothing:
/// the line joins the days that have values.
pub fn line(t: &Theme, key: &str, points: &[(String, f64)], color: Color, height: f32) -> El {
    if points.is_empty() {
        return el();
    }
    let max = points.iter().map(|p| p.1).fold(0.0, f64::max).max(1.0);
    let w = (points.len().max(2) - 1) as f32;
    let h = 100.0;
    let at = |i: usize, v: f64| [if points.len() == 1 { w / 2.0 } else { i as f32 }, h - (v / max) as f32 * (h - 4.0) - 2.0];
    let pts: Vec<[f32; 2]> = points.iter().enumerate().map(|(i, p)| at(i, p.1)).collect();
    let mut area = vec![[pts[0][0], h]];
    area.extend(pts.iter().copied());
    area.push([pts[pts.len() - 1][0], h]);
    let shape = Shape::new().fill(area, color.alpha(0.12)).stroke(pts, 2.0, color).view_box(w, h);
    let scale = col()
        .h(height)
        .pr(8.0)
        .child(label(format_count(max), type_::XS2, t.muted_foreground))
        .child(el().grow(1.0))
        .child(label("0", type_::XS2, t.muted_foreground));
    let dates: Vec<String> = points.iter().map(|p| p.0.clone()).collect();
    col()
        .key(key)
        .w_full()
        .child(
            row()
                .w_full()
                .child(scale)
                .child(col().grow(1.0).min_w(0.0).border_sides([0.0, 0.0, 1.0, 0.0], t.border).child(canvas(shape).w_full().h(height))),
        )
        .child(row().w_full().pl(24.0).child(axis(t, &dates)))
}

/// A thin bar split in proportion to each verdict, empty when nothing was judged.
pub fn verdict_bar(t: &Theme, v: &Verdicts, width: f32) -> El {
    let mut r = row().w(width).h(6.0).radius(3.0).clip_rounded(3.0).fill(t.accent).gap(1.0);
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
