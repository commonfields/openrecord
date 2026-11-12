//! Shared pieces of the analytics pages: one card, one grid, one KPI tile,
//! one table, so every section lines up the same way.
//!
//! Every row of cards is laid out by [`cols`]: the cards share the row's width
//! equally and stretch to the tallest one, so neighbours never end at
//! different edges.

use rune::{Color, Cursor, El, ScrollSpec, col, el, row};

use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, label};

/// The big number on a tile.
pub const VALUE: rune::TextStyle = rune::TextStyle::new(24.0, 600.0).lh(30.0).features("'tnum' 1");
/// Numbers in tables.
pub const NUM: rune::TextStyle = type_::SM_13.features("'tnum' 1");

/// Cards side by side at equal widths, stretched to the tallest.
pub fn cols(cards: Vec<El>) -> El {
    let mut r = row().w_full().gap(16.0).items_stretch();
    for c in cards {
        r = r.child(col().w(0.0).grow(1.0).min_w(0.0).child(c.w_full().min_w(0.0).grow(1.0)));
    }
    r
}

/// A card with a title, an optional line under it and an optional action on
/// the right. `height` > 0 fixes its height and scrolls the body inside.
pub fn panel(t: &Theme, key: &str, title: &str, sub: Option<String>, action: Option<El>, height: f32, body: El) -> El {
    let mut head = row().w_full().gap(12.0).items_start().child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(2.0)
            .child(label(title.to_string(), type_::SM_MEDIUM, t.foreground).role("heading").truncate())
            .children(sub.map(|s| label(s, type_::XS, t.muted_foreground).wrap().max_lines(2))),
    );
    if let Some(a) = action {
        head = head.child(a);
    }
    let c = shadows(col().key(key.to_string()).w_full().radius(12.0).fill(t.card).px(20.0).py(18.0).gap(14.0), &t.card_shadow).child(head);
    if height > 0.0 {
        c.h(height).clip_rounded(12.0).child(col().key(format!("{key}-body")).w_full().grow(1.0).min_h(0.0).child(body).scroll(ScrollSpec { stick_bottom: false }))
    } else {
        c.child(col().key(format!("{key}-body")).w_full().grow(1.0).child(body))
    }
}

/// A section heading between rows of cards.
pub fn heading(t: &Theme, title: &str, sub: &str) -> El {
    col().w_full().gap(2.0).pt(8.0).child(label(title.to_string(), type_::BASE_MEDIUM, t.foreground).role("heading")).child(label(sub.to_string(), type_::XS, t.muted_foreground).wrap())
}

/// A change as a soft chip: green when it went the good way, red when not.
pub fn change_chip(t: &Theme, d: f64, better_up: bool) -> El {
    let (ink, soft) = if d.abs() < 0.005 {
        (t.muted_foreground, t.accent)
    } else if (d >= 0.0) == better_up {
        (t.supported, t.supported_soft)
    } else {
        (t.wrong, t.wrong_soft)
    };
    row().h(20.0).px(6.0).radius(5.0).center().fill(soft).child(label(pct_change(d), type_::XS_MEDIUM.features("'tnum' 1"), ink))
}

/// A change in percentage points, for rates.
pub fn points_chip(t: &Theme, pts: f64, better_up: bool) -> El {
    let (ink, soft) = if pts.abs() < 0.05 {
        (t.muted_foreground, t.accent)
    } else if (pts >= 0.0) == better_up {
        (t.supported, t.supported_soft)
    } else {
        (t.wrong, t.wrong_soft)
    };
    row().h(20.0).px(6.0).radius(5.0).center().fill(soft).child(label(format!("{}{pts:.1} pts", if pts >= 0.0 { "+" } else { "" }), type_::XS_MEDIUM.features("'tnum' 1"), ink))
}

pub fn pct_change(d: f64) -> String {
    format!("{}{:.0}%", if d >= 0.0 { "+" } else { "" }, d * 100.0)
}

/// The relative change from `before` to `now`, when there was a before.
pub fn change(now: f64, before: f64) -> Option<f64> {
    (before > 0.0).then(|| (now - before) / before)
}

/// One key number: its name with the change on the right, the value, and a short foot.
pub fn tile(t: &Theme, key: &str, name: &str, value: String, change: Option<(f64, bool)>, foot: Option<String>) -> El {
    let mut head = row().w_full().gap(6.0).center_y().child(label(name.to_string(), type_::XS_MEDIUM, t.muted_foreground).truncate().grow(1.0).min_w(0.0));
    if let Some((d, up)) = change {
        head = head.child(change_chip(t, d, up));
    }
    let mut c = shadows(col().key(key.to_string()).w(0.0).grow(1.0).min_w(150.0).h(112.0).px(18.0).py(16.0).gap(6.0).radius(12.0).fill(t.card), &t.card_shadow)
        .child(head)
        .child(label(value, VALUE, t.foreground).truncate());
    if let Some(f) = foot {
        c = c.child(el().grow(1.0)).child(label(f, type_::XS, t.muted_foreground).truncate());
    }
    c
}


/// Tiles in one row, wrapping on narrow windows.
pub fn tiles(list: Vec<El>) -> El {
    let mut r = row().w_full().gap(16.0).flex_wrap();
    for c in list {
        r = r.child(c);
    }
    r
}

/// Tiles in rows of `n`, each row at equal widths.
pub fn rows_of(list: Vec<El>, n: usize) -> El {
    let mut c = col().w_full().gap(16.0);
    let mut it = list.into_iter().peekable();
    while it.peek().is_some() {
        let mut chunk: Vec<El> = it.by_ref().take(n).collect();
        while chunk.len() < n {
            chunk.push(el());
        }
        c = c.child(cols(chunk));
    }
    c
}

/// A table column: its header, width (0 grows to fill) and whether it aligns right.
pub struct Column {
    pub name: &'static str,
    pub width: f32,
    pub right: bool,
}

pub const fn column(name: &'static str, width: f32, right: bool) -> Column {
    Column { name, width, right }
}

fn cell(c: &Column, content: El) -> El {
    let inner = if c.right { row().w_full().child(el().grow(1.0)).child(content) } else { row().w_full().min_w(0.0).child(content) };
    // Fixed columns give way on a narrow window; the growing one keeps room for its text.
    if c.width > 0.0 { inner.w(c.width).shrink() } else { inner.w(0.0).grow(1.0).min_w(120.0) }
}

/// A table: a muted header, then rows with no lines between them; a row shows
/// only under the pointer, as the web's lists do.
pub fn table(t: &Theme, key: &str, columns: &[Column], rows: Vec<Vec<El>>) -> El {
    let mut head = row().w_full().gap(12.0).pb(8.0).px(8.0);
    for c in columns {
        head = head.child(cell(c, label(c.name, type_::XS11, t.muted_foreground)));
    }
    let mut out = col().key(key.to_string()).w_full().child(head);
    for (k, r) in rows.into_iter().enumerate() {
        let mut line = row().key(format!("{key}-{k}")).w_full().gap(12.0).min_h(40.0).py(6.0).px(8.0).radius(8.0).center_y().hover(t.hover_tint);
        for (c, content) in columns.iter().zip(r) {
            line = line.child(cell(c, content));
        }
        out = out.child(line);
    }
    out
}

/// Text for a table cell.
pub fn text(t: &Theme, s: impl Into<String>) -> El {
    label(s.into(), type_::SM_13, t.foreground).truncate()
}

/// A number for a table cell.
pub fn num(t: &Theme, s: impl Into<String>) -> El {
    label(s.into(), NUM, t.foreground)
}

/// A muted number for a table cell.
pub fn faint(t: &Theme, s: impl Into<String>) -> El {
    label(s.into(), NUM, t.muted_foreground)
}

/// A ranked list drawn as bars: each row's name over a bar sized to its share
/// of the largest value, the value on the right.
pub fn bars(t: &Theme, key: &str, rows: &[(String, f64, String)], tone: Option<Color>) -> El {
    bars_to(t, key, rows, tone, None)
}

/// [`bars`] against a fixed full scale (1.0 for shares) instead of the largest row.
pub fn bars_to(t: &Theme, key: &str, rows: &[(String, f64, String)], tone: Option<Color>, full: Option<f64>) -> El {
    let max = full.unwrap_or_else(|| rows.iter().map(|r| r.1).fold(0.0, f64::max)).max(f64::EPSILON);
    let mut c = col().key(key.to_string()).w_full().gap(12.0);
    for (k, (name, v, shown)) in rows.iter().enumerate() {
        let ink = tone.unwrap_or_else(|| t.chart.tone(k));
        c = c.child(
            col()
                .key(format!("{key}-{k}"))
                .w_full()
                .gap(5.0)
                .child(row().w_full().gap(8.0).center_y().child(label(name.clone(), type_::XS, t.foreground).truncate().grow(1.0).min_w(0.0)).child(label(shown.clone(), type_::XS.features("'tnum' 1"), t.muted_foreground)))
                .child(row().w_full().h(6.0).radius(3.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((v / max).clamp(0.0, 1.0) as f32).h_full().radius(3.0).fill(ink.alpha(0.9)))),
        );
    }
    c
}

/// Columns over a short axis: one per item, its value above and its name under it.
pub fn columns(t: &Theme, key: &str, items: &[(String, f64, String)], height: f32, highlight: Option<usize>) -> El {
    let max = items.iter().map(|i| i.1).fold(0.0, f64::max).max(f64::EPSILON);
    let mut r = row().key(key.to_string()).w_full().h(height + 40.0).gap(8.0).items_end();
    for (k, (name, v, shown)) in items.iter().enumerate() {
        let on = highlight == Some(k);
        let ink = if on { t.chart.primary } else { t.chart.primary.alpha(0.4) };
        r = r.child(
            col()
                .key(format!("{key}-{k}"))
                .w(0.0)
                .grow(1.0)
                .min_w(0.0)
                .gap(4.0)
                .items_center()
                .child(label(shown.clone(), type_::XS11.features("'tnum' 1"), if on { t.foreground } else { t.muted_foreground }))
                .child(el().w_full().h(((v / max) as f32 * height).max(2.0)).radius(4.0).fill(ink))
                .child(label(name.clone(), type_::AXIS, t.chart.axis)),
        );
    }
    r
}

/// Parts of a whole as one rounded bar, with a legend line per part.
pub fn split(t: &Theme, key: &str, parts: &[(String, f64, Color, String)]) -> El {
    let total: f64 = parts.iter().map(|p| p.1).sum();
    let mut bar = row().w_full().h(12.0).radius(6.0).clip_rounded(6.0).gap(2.0).fill(t.foreground.alpha(0.05));
    for p in parts.iter().filter(|p| p.1 > 0.0) {
        bar = bar.child(el().h_full().grow((p.1 / total.max(f64::EPSILON)) as f32).fill(p.2));
    }
    let mut legend = col().w_full();
    for (k, p) in parts.iter().enumerate() {
        legend = legend.child(
            row()
                .key(format!("{key}-{k}"))
                .w_full()
                .h(30.0)
                .gap(10.0)
                .center_y()
                .child(el().size(8.0, 8.0).radius(2.0).fill(p.2))
                .child(label(p.0.clone(), type_::SM_13, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                .child(label(p.3.clone(), NUM, t.foreground))
                .child(row().w(44.0).child(el().grow(1.0)).child(label(if total > 0.0 { format!("{:.0}%", p.1 / total * 100.0) } else { "—".into() }, type_::XS.features("'tnum' 1"), t.muted_foreground))),
        );
    }
    col().key(key.to_string()).w_full().gap(12.0).child(bar).child(legend)
}

/// A highlighted finding with an optional action: what the numbers point at.
pub fn callout(t: &Theme, key: &str, tone: Color, title: String, body: String, action: Option<El>) -> El {
    let mut c = row()
        .key(key.to_string())
        .w_full()
        .gap(14.0)
        .px(18.0)
        .py(14.0)
        .radius(12.0)
        .fill(tone.alpha(0.08))
        .center_y()
        .child(el().w(3.0).h(36.0).radius(2.0).fill(tone))
        .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(title, type_::SM_MEDIUM, t.foreground).wrap()).child(label(body, type_::XS, t.muted_foreground).wrap()));
    if let Some(a) = action {
        c = c.child(a);
    }
    c
}

/// A quiet line of text inside a card.
pub fn note(t: &Theme, s: impl Into<String>) -> El {
    label(s.into(), type_::SM_13, t.muted_foreground).wrap()
}

/// A text-only tab strip: plain labels, the chosen one on a soft pill.
pub fn text_tabs(t: &Theme, key: &str, items: Vec<(String, bool, Box<dyn Fn(&mut App)>)>) -> El {
    let mut r = row().key(key.to_string()).h(28.0).gap(2.0).role("tablist");
    for (i, (name, on, act)) in items.into_iter().enumerate() {
        let mut chip = row()
            .key(format!("{key}-{i}"))
            .h_full()
            .px(10.0)
            .radius(6.0)
            .center()
            .role("tab")
            .label(name.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| act(s))
            .child(label(name, type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }));
        chip = if on { chip.fill(t.accent) } else { chip.hover(t.hover_tint) };
        r = r.child(chip);
    }
    r
}

/// Monday = 0 for a "2026-11-10" day.
pub fn weekday(iso: &str) -> Option<usize> {
    let secs = crate::format::parse_iso(&format!("{}T00:00:00", iso.get(0..10)?))?;
    // 1970-01-01 was a Thursday.
    Some(((secs.div_euclid(86_400) + 3).rem_euclid(7)) as usize)
}

pub const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// The average per weekday over dated values, Monday first; a weekday with no
/// days is None.
pub fn by_weekday(days: &[(String, f64)]) -> [Option<f64>; 7] {
    let mut sum = [0.0; 7];
    let mut count = [0usize; 7];
    for (d, v) in days {
        if let Some(w) = weekday(d) {
            sum[w] += v;
            count[w] += 1;
        }
    }
    let mut out = [None; 7];
    for w in 0..7 {
        if count[w] > 0 {
            out[w] = Some(sum[w] / count[w] as f64);
        }
    }
    out
}

/// The running total, day by day.
pub fn running(values: &[f64]) -> Vec<Option<f64>> {
    let mut acc = 0.0;
    values
        .iter()
        .map(|v| {
            acc += v;
            Some(acc)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekdays_start_on_monday() {
        assert_eq!(weekday("2026-11-09"), Some(0));
        assert_eq!(weekday("2026-11-15"), Some(6));
        assert_eq!(weekday("1970-01-01"), Some(3));
    }

    #[test]
    fn weekday_averages_skip_empty_days() {
        let w = by_weekday(&[("2026-11-09".into(), 4.0), ("2026-11-16".into(), 6.0), ("2026-11-10".into(), 1.0)]);
        assert_eq!(w[0], Some(5.0));
        assert_eq!(w[1], Some(1.0));
        assert_eq!(w[2], None);
    }

    #[test]
    fn running_total_adds_up() {
        assert_eq!(running(&[1.0, 2.0, 3.0]), vec![Some(1.0), Some(3.0), Some(6.0)]);
        assert_eq!(change(120.0, 100.0), Some(0.2));
        assert_eq!(change(5.0, 0.0), None);
    }
}
