//! A generated "series" view: a value over time read like a statement. The
//! latest value (or the day under the pointer) as a large figure with its date,
//! a stepped line of every day over a dotted field, a dot where the value
//! moved (filled up, hollow down), and under it the movements that explain it.

use rune::{El, LineCap, Shape, canvas, col, el, row};

use crate::format;
use crate::state::App;
use crate::surface::{Movement, Unit};
use crate::theme::{Theme, type_};
use crate::ui::widgets::label;

const VIEW_H: f32 = 100.0;
const HEIGHT: f32 = 200.0;

/// The value as text, split where the faint part starts: "$411,283" and ".41".
fn split_value(unit: &Unit, v: f64) -> (String, String) {
    match unit {
        Unit::Money(c) => {
            let full = crate::insights::money(v, c);
            match full.rfind('.') {
                Some(i) => (full[..i].to_string(), full[i..].to_string()),
                None => (full, String::new()),
            }
        }
        Unit::Percent => (format!("{:.1}", v).trim_end_matches(".0").to_string(), "%".into()),
        Unit::Count => (crate::insights::int(v), String::new()),
    }
}

fn amount(unit: &Unit, v: f64) -> String {
    let sign = if v < 0.0 { "−" } else { "+" };
    match unit {
        Unit::Money(c) => format!("{sign}{}", crate::insights::money(v.abs(), c)),
        Unit::Percent => format!("{sign}{:.1} pts", v.abs()),
        Unit::Count => format!("{sign}{}", crate::insights::int(v.abs())),
    }
}

pub fn view(s: &App, t: &Theme, key: &str, name: Option<&str>, unit: &Unit, points: &[(String, f64)], items: &[Movement]) -> El {
    let n = points.len();
    let hover = s.chart_hover.as_ref().filter(|(k, _)| k == key).map(|(_, i)| *i).filter(|i| *i < n);
    let at = hover.unwrap_or(n - 1);
    let (lo, hi) = points.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
    let pad = ((hi - lo) * 0.15).max(hi.abs() * 0.01).max(1e-9);
    let (lo, hi) = (lo - pad, hi + pad);
    let x = |i: usize| if n <= 1 { 0.5 } else { i as f32 / (n - 1) as f32 };
    let y = |v: f64| VIEW_H - ((v - lo) / (hi - lo)) as f32 * VIEW_H;
    let ink = t.chart.primary;

    // The headline: the value, its faint tail, and the day it is for.
    let (whole, tail) = split_value(unit, points[at].1);
    let big = rune::TextStyle::new(30.0, 600.0).lh(38.0).features("'tnum' 1");
    let headline = row()
        .key(format!("{key}-head"))
        .gap(0.0)
        .items_end()
        .child(label(whole, big, t.foreground))
        .child(label(tail, big, t.muted_foreground))
        .child(label(format!(" on {}", format::short_day(&points[at].0)), big, t.muted_foreground));

    // The dotted field, the stepped line, its wash, and the moves.
    let mut sh = Shape::new();
    for gy in 0..=8 {
        for gx in 0..=48 {
            let p = [gx as f32 / 48.0, gy as f32 / 8.0 * VIEW_H];
            sh = sh.stroke_with(vec![p, [p[0] + 0.0001, p[1]]], false, 1.6, LineCap::Round, t.foreground.alpha(0.07));
        }
    }
    let mut line: Vec<[f32; 2]> = Vec::with_capacity(n * 2);
    for (i, p) in points.iter().enumerate() {
        let py = y(p.1);
        if i > 0 {
            line.push([x(i), line.last().map(|l| l[1]).unwrap_or(py)]);
        }
        line.push([x(i), py]);
    }
    let mut wash = vec![[0.0, VIEW_H]];
    wash.extend(line.iter().copied());
    wash.push([1.0, VIEW_H]);
    sh = sh.fill(wash, ink.alpha(0.06));
    sh = sh.stroke(line, 2.0, ink);
    for i in 1..n {
        let (a, b) = (points[i - 1].1, points[i].1);
        if (b - a).abs() < f64::EPSILON {
            continue;
        }
        let p = [x(i), y(b)];
        let q = [p[0] + 0.0001, p[1]];
        sh = sh.stroke_with(vec![p, q], false, 7.0, LineCap::Round, ink);
        if b < a {
            // A fall: a hollow ring.
            sh = sh.stroke_with(vec![p, q], false, 4.0, LineCap::Round, t.background);
        }
    }
    if let Some(i) = hover {
        let hx = x(i);
        let mut yy = 0.0;
        while yy < VIEW_H {
            sh = sh.stroke_with(vec![[hx, yy], [hx, (yy + 2.5).min(VIEW_H)]], false, 1.0, LineCap::Butt, t.muted_foreground.alpha(0.7));
            yy += 5.0;
        }
        let p = [hx, y(points[i].1)];
        let q = [p[0] + 0.0001, p[1]];
        sh = sh.stroke_with(vec![p, q], false, 13.0, LineCap::Round, t.background).stroke_with(vec![p, q], false, 10.0, LineCap::Round, ink);
    }

    // One hover cell per day.
    let mut hits = row().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    for i in 0..n {
        let k = key.to_string();
        hits = hits.child(col().grow(1.0).h_full().key(format!("{key}-day-{i}")).help(format::date(&points[i].0)).on_hover_change(move |s: &mut App, inside, _| {
            if inside {
                s.chart_hover = Some((k.clone(), i));
            } else if s.chart_hover.as_ref() == Some(&(k.clone(), i)) {
                s.chart_hover = None;
            }
        }));
    }
    let plot = col().key(format!("{key}-plot")).w_full().h(HEIGHT).child(canvas(sh.view_box(1.0, VIEW_H)).w_full().h_full()).child(hits);

    let mut c = col().key(key.to_string()).w_full().gap(16.0).role("img").label(format!("{}: {}", name.unwrap_or("Value over time"), points.iter().map(|p| format!("{} {}", p.0, p.1)).collect::<Vec<_>>().join(", ")));
    if let Some(l) = name {
        c = c.child(label(l.to_string(), type_::XS_MEDIUM, t.muted_foreground));
    }
    c = c.child(headline).child(plot);
    if !items.is_empty() {
        let mut list = col().w_full().gap(10.0).pt(8.0);
        for (k, m) in items.iter().enumerate() {
            let rise = m.amount >= 0.0 && !m.muted;
            list = list.child(
                row()
                    .key(format!("{key}-item-{k}"))
                    .w_full()
                    .gap(12.0)
                    .center_y()
                    .child(label(m.label.clone(), type_::BASE, if m.muted { t.muted_foreground } else { t.foreground }).truncate().grow(1.0).min_w(0.0))
                    .child(label(amount(unit, m.amount), type_::BASE.features("'tnum' 1"), if rise { ink } else { t.muted_foreground })),
            );
        }
        c = c.child(list);
    }
    c.child(el().h(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_faint_tail() {
        assert_eq!(split_value(&Unit::Money("USD".into()), 411283.41), ("$411,283".into(), ".41".into()));
        assert_eq!(amount(&Unit::Money("USD".into()), -2011.05), "−$2,011.05");
        assert_eq!(amount(&Unit::Count, 3.0), "+3");
    }
}
