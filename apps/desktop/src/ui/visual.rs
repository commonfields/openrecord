//! A chart reply drawn in the chat (`ChatVisual`): bars, lines, a donut or
//! stat tiles, in the app's series palette, each plot with a table view.

use rune::{Cursor, El, LineCap, Shape, canvas, col, el, row};

use crate::icons;
use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{icon_button, label};
use crate::visual::{Kind, Series, Spec, format, slices};

const PLOT_H: f32 = 200.0;
const AXIS_W: f32 = 44.0;

/// The axis top: the smallest of 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten that holds `max`.
fn nice_max(max: f64) -> f64 {
    if max <= 0.0 {
        return 1.0;
    }
    let p = 10f64.powf(max.log10().floor());
    [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0].iter().map(|m| m * p).find(|v| *v >= max - 1e-9).unwrap_or(10.0 * p)
}

/// The block drawn, or its raw text as code when it is not a valid spec.
pub fn view(s: &App, t: &Theme, key: String, raw: &str) -> El {
    match crate::visual::parse(raw) {
        Some(spec) => card(s, t, key, &spec),
        None => col()
            .key(key)
            .w_full()
            .padding(12.0)
            .radius(10.0)
            .fill(t.accent.alpha(0.6))
            .child(label(raw.to_string(), type_::XS.mono(), t.foreground).wrap().selectable(true)),
    }
}

fn card(s: &App, t: &Theme, key: String, spec: &Spec) -> El {
    let (title, note) = match spec {
        Spec::Plot { title, note, .. } | Spec::Stats { title, note, .. } => (title, note),
    };
    let table = s.visual_tables.contains(&key);
    let mut head = row().w_full().gap(8.0).center_y().child(label(title.clone(), type_::SM_MEDIUM, t.foreground).wrap().grow(1.0).min_w(0.0));
    if matches!(spec, Spec::Plot { .. }) {
        let k = key.clone();
        head = head.child(
            icon_button(t, &format!("{key}-view"), if table { &icons::CHART_COLUMN } else { &icons::TABLE }, if table { "Show chart" } else { "Show table" }, false).on_press(move |s: &mut App| {
                if !s.visual_tables.remove(&k) {
                    s.visual_tables.insert(k.clone());
                }
            }),
        );
    }
    let body = match spec {
        Spec::Stats { stats, .. } => {
            let mut r = row().w_full().gap(10.0).flex_wrap();
            for (i, st) in stats.iter().enumerate() {
                let mut tile = col()
                    .key(format!("{key}-stat-{i}"))
                    .grow(1.0)
                    .min_w(130.0)
                    .px(12.0)
                    .py(10.0)
                    .gap(2.0)
                    .radius(8.0)
                    .fill(t.accent.alpha(0.6))
                    .child(label(st.label.clone(), type_::XS, t.muted_foreground).wrap())
                    .child(label(st.value.clone(), type_::TITLE.features("'tnum' 1"), t.foreground));
                if let Some(h) = &st.hint {
                    tile = tile.child(label(h.clone(), type_::XS, t.muted_foreground).wrap());
                }
                r = r.child(tile);
            }
            r
        }
        Spec::Plot { labels, series, unit, .. } if table => table_view(t, labels, series, unit.as_deref()),
        Spec::Plot { kind: Kind::Donut, labels, series, unit, .. } => donut(t, labels, &series[0], unit.as_deref()),
        Spec::Plot { kind, labels, series, unit, .. } => {
            let mut c = col().w_full().gap(10.0);
            if series.len() > 1 {
                c = c.child(legend(t, series.iter().enumerate().map(|(i, x)| (x.name.clone(), t.chart.series[i % 12], None)).collect()));
            }
            c.child(plot(t, *kind, labels, series, unit.as_deref()))
        }
    };
    let mut c = col().key(key).w_full().gap(12.0).padding(14.0).radius(10.0).fill(t.card).child(head).child(body);
    if let Some(n) = note {
        c = c.child(label(n.clone(), type_::XS, t.muted_foreground).wrap());
    }
    shadows(c, &t.card_shadow)
}

fn legend(t: &Theme, items: Vec<(String, rune::Color, Option<String>)>) -> El {
    let mut r = row().w_full().gap(14.0).flex_wrap();
    for (name, c, value) in items {
        let mut it = row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(2.0).fill(c)).child(label(name, type_::XS, t.muted_foreground));
        if let Some(v) = value {
            it = it.child(label(v, type_::XS_MEDIUM.features("'tnum' 1"), t.foreground));
        }
        r = r.child(it);
    }
    r
}

fn plot(t: &Theme, kind: Kind, labels: &[String], series: &[Series], unit: Option<&str>) -> El {
    let n = labels.len();
    let all = series.iter().flat_map(|s| s.values.iter().flatten().copied());
    let (lo, hi) = all.fold((0.0f64, 0.0f64), |(lo, hi), v| (lo.min(v), hi.max(v)));
    let max = nice_max(hi);
    let min = if lo < 0.0 { -nice_max(-lo) } else { 0.0 };
    let span = (max - min).max(f64::EPSILON);
    // Plot coordinates: x 0..1 across the labels, y 0 (top) to 100.
    let y = |v: f64| (100.0 - (v - min) / span * 100.0) as f32;
    let axis_unit = if unit == Some("%") { Some("%") } else { None };

    let mut shape = Shape::new();
    for k in 0..3 {
        let gy = y(min + span * k as f64 / 2.0);
        shape = shape.line([0.0, gy], [1.0, gy], 1.0, LineCap::Butt, t.chart.grid);
    }
    let one = series.len() == 1;
    let mut overlay = row().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    match kind {
        Kind::Bar => {
            // Each label is a slot; its bars share the middle three quarters.
            let slot = 1.0 / n as f32;
            let group = slot * 0.76;
            let bar = group / series.len() as f32;
            for (k, s) in series.iter().enumerate() {
                for (i, v) in s.values.iter().enumerate() {
                    let Some(v) = v else { continue };
                    let x0 = i as f32 * slot + (slot - group) / 2.0 + k as f32 * bar;
                    let x1 = x0 + bar * 0.9;
                    let (top, bottom) = (y(v.max(0.0)), y(v.min(0.0)));
                    shape = shape.fill(vec![[x0, top], [x1, top], [x1, bottom], [x0, bottom]], t.chart.series[k % 12]);
                }
            }
            // Direct labels on one series that fits, so the values read without the table.
            if one && n <= 12 {
                for v in &series[0].values {
                    let top = v.map_or(100.0, |v| y(v.max(0.0)));
                    overlay = overlay.child(
                        col().grow(1.0).h_full().items_center().child(el().h((top / 100.0 * PLOT_H - 18.0).max(0.0))).child(label(format(*v, unit), type_::AXIS, t.foreground)),
                    );
                }
            }
        }
        Kind::Line | Kind::Donut => {
            let x = |i: usize| if n <= 1 { 0.5 } else { i as f32 / (n - 1) as f32 };
            for (k, s) in series.iter().enumerate() {
                let c = t.chart.series[k % 12];
                // A gap in the values breaks the line, as connectNulls={false} does.
                let mut run: Vec<[f32; 2]> = Vec::new();
                let flush = |run: &mut Vec<[f32; 2]>, shape: Shape| -> Shape {
                    let out = match run.len() {
                        0 => shape,
                        1 => shape.stroke_with(vec![run[0], [run[0][0] + 0.0001, run[0][1]]], false, 5.0, LineCap::Round, c),
                        _ => shape.stroke(run.clone(), 2.0, c),
                    };
                    run.clear();
                    out
                };
                for (i, v) in s.values.iter().enumerate() {
                    match v {
                        Some(v) => run.push([x(i), y(*v)]),
                        None => shape = flush(&mut run, shape),
                    }
                }
                shape = flush(&mut run, shape);
                if n <= 12 {
                    for (i, v) in s.values.iter().enumerate() {
                        if let Some(v) = v {
                            let p = [x(i), y(*v)];
                            shape = shape.stroke_with(vec![p, [p[0] + 0.0001, p[1]]], false, 6.0, LineCap::Round, c);
                        }
                    }
                }
            }
        }
    }
    let plot = col().grow(1.0).min_w(0.0).h(PLOT_H).child(canvas(shape.view_box(1.0, 100.0)).w_full().h_full()).child(overlay);
    let mut scale = col().w(AXIS_W).h(PLOT_H);
    for k in 0..3 {
        let v = min + span * k as f64 / 2.0;
        let top = y(v) / 100.0 * PLOT_H - 7.0;
        scale = scale.child(label(format(Some(v), axis_unit), type_::AXIS, t.chart.axis).absolute(8.0, top.max(0.0)));
    }
    // Labels under the plot: every one when few, otherwise evenly picked.
    let mut axis = row().w_full().pr(AXIS_W).pt(8.0);
    let shown = n.min(8);
    if kind == Kind::Bar && n <= 12 {
        for l in labels {
            axis = axis.child(col().grow(1.0).min_w(0.0).items_center().child(label(l.clone(), type_::AXIS, t.chart.axis).truncate()));
        }
    } else {
        for j in 0..shown {
            let i = if shown <= 1 { 0 } else { j * (n - 1) / (shown - 1) };
            if j > 0 {
                axis = axis.child(el().grow(1.0));
            }
            axis = axis.child(label(labels[i].clone(), type_::AXIS, t.chart.axis));
        }
    }
    col().w_full().child(row().w_full().child(plot).child(scale)).child(axis)
}

fn donut(t: &Theme, labels: &[String], s: &Series, unit: Option<&str>) -> El {
    let parts = slices(labels, &s.values);
    let total: f64 = parts.iter().map(|p| p.1).sum();
    let color = |i: usize, name: &str| if name == "Other" { t.muted_foreground } else { t.chart.series[i % 12] };
    let size = 160.0;
    // Each slice is a filled ring sector between the inner (62%) and outer radius.
    let (outer, inner) = (50.0f32, 31.0f32);
    let mut shape = Shape::new();
    let mut start = -std::f64::consts::FRAC_PI_2;
    let gap = if parts.len() > 1 { 0.02 } else { 0.0 };
    for (i, (name, v)) in parts.iter().enumerate() {
        if total <= 0.0 || *v <= 0.0 {
            continue;
        }
        let sweep = v / total * std::f64::consts::TAU;
        let steps = ((sweep / 0.05).ceil() as usize).max(2);
        let (a0, a1) = (start + gap, start + sweep - gap);
        let at = |k: usize| a0 + (a1 - a0) * k as f64 / steps as f64;
        let point = |a: f64, r: f32| [50.0 + r * a.cos() as f32, 50.0 + r * a.sin() as f32];
        let mut pts: Vec<[f32; 2]> = (0..=steps).map(|k| point(at(k), outer)).collect();
        pts.extend((0..=steps).rev().map(|k| point(at(k), inner)));
        shape = shape.fill(pts, color(i, name));
        start += sweep;
    }
    let ring = canvas(shape.view_box(100.0, 100.0)).size(size, size);
    let items = parts
        .iter()
        .enumerate()
        .map(|(i, (name, v))| {
            let share = if total > 0.0 && unit != Some("%") { format!("{}, {}%", format(Some(*v), unit), (v / total * 100.0).round()) } else { format(Some(*v), unit) };
            (name.clone(), color(i, name), Some(share))
        })
        .collect::<Vec<_>>();
    let mut list = col().gap(6.0).min_w(0.0).grow(1.0);
    for (name, c, value) in items {
        list = list.child(
            row()
                .gap(8.0)
                .center_y()
                .child(el().size(8.0, 8.0).radius(2.0).fill(c))
                .child(label(name, type_::XS, t.muted_foreground).grow(1.0).min_w(0.0))
                .child(label(value.unwrap_or_default(), type_::XS_MEDIUM.features("'tnum' 1"), t.foreground)),
        );
    }
    row().w_full().gap(20.0).center_y().child(ring).child(list.max_w(320.0))
}

fn table_view(t: &Theme, labels: &[String], series: &[Series], unit: Option<&str>) -> El {
    let cell = |s: String, style, color, right: bool| {
        let c = row().w(0.0).grow(1.0).min_w(0.0).px(8.0).py(6.0).child(label(s, style, color).truncate());
        if right { c.justify_end() } else { c }
    };
    let mut head = row().w_full().child(cell(String::new(), type_::XS_MEDIUM, t.muted_foreground, false));
    for s in series {
        head = head.child(cell(s.name.clone(), type_::XS_MEDIUM, t.muted_foreground, true));
    }
    let mut c = col().w_full().child(head);
    for (i, l) in labels.iter().enumerate() {
        let mut r = row().key(format!("row-{i}")).w_full().border_sides([1.0, 0.0, 0.0, 0.0], t.border.alpha(0.6)).child(cell(l.clone(), type_::XS, t.foreground, false));
        for s in series {
            r = r.child(cell(format(s.values.get(i).copied().flatten(), unit), type_::XS.features("'tnum' 1"), t.foreground, true));
        }
        c = c.child(r);
    }
    c.cursor(Cursor::Default)
}

#[cfg(test)]
mod tests {
    #[test]
    fn axis_tops_are_tight() {
        assert_eq!(super::nice_max(540.0), 600.0);
        assert_eq!(super::nice_max(47.0), 50.0);
        assert_eq!(super::nice_max(61.0), 80.0);
        assert_eq!(super::nice_max(0.0), 1.0);
    }
}
