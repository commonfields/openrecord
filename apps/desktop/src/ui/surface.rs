//! A generated view in the chat (`crate::surface`): drawn only from the app's
//! own components and tokens, inside a marked container the agent cannot style
//! away, so it always reads as the agent's output, never as the app itself.

use rune::{Color, Cursor, El, col, el, row};

use crate::icons;
use crate::state::App;
use crate::surface::{Action, Gap, Node, Surface, Tone, Trend};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{Variant, button, ico, label, status_chip};

/// The block drawn, or its raw text as code when it is not a valid surface.
pub fn view(s: &App, t: &Theme, key: String, raw: &str) -> El {
    match crate::surface::parse(raw) {
        Ok(surface) => container(s, t, key, &surface),
        Err(_) => col()
            .key(key)
            .w_full()
            .padding(12.0)
            .radius(10.0)
            .fill(t.accent.alpha(0.6))
            .child(label(raw.to_string(), type_::XS.mono(), t.foreground).wrap().selectable(true)),
    }
}

fn container(s: &App, t: &Theme, key: String, surface: &Surface) -> El {
    // Provenance: a hairline frame and a "Generated view" mark the agent cannot remove.
    let mut head = row().w_full().gap(8.0).center_y();
    if let Some(title) = &surface.title {
        head = head.child(label(title.clone(), type_::SM_MEDIUM, t.foreground).wrap().grow(1.0).min_w(0.0));
    } else {
        head = head.child(el().grow(1.0));
    }
    head = head.child(row().gap(4.0).center_y().child(ico(&icons::SPARKLES, 12.0, t.muted_foreground)).child(label("Generated view", type_::XS, t.muted_foreground)));
    let body = node(s, t, surface, &surface.root, &key);
    shadows(
        col().key(key.clone()).w_full().gap(12.0).padding(14.0).radius(12.0).fill(t.card).border(1.0, t.border).role("group").label(surface.title.clone().unwrap_or_else(|| "Generated view".into())).child(head).child(body),
        &t.card_shadow,
    )
}

fn gap(g: Gap) -> f32 {
    match g {
        Gap::Sm => 6.0,
        Gap::Md => 12.0,
        Gap::Lg => 20.0,
    }
}

/// A tone's ink and soft fill, from the app's status tokens.
fn tone(t: &Theme, tn: Tone) -> (Color, Color) {
    match tn {
        Tone::Good => (t.supported, t.supported_soft),
        Tone::Bad => (t.wrong, t.wrong_soft),
        Tone::Warn => (t.partial, t.partial_soft),
        Tone::Info => (t.review, t.review_soft),
        Tone::Neutral => (t.muted_foreground, t.accent),
    }
}

fn node(s: &App, t: &Theme, surface: &Surface, id: &str, prefix: &str) -> El {
    let key = format!("{prefix}-{id}");
    let Some(n) = surface.nodes.get(id) else { return el() };
    let kids = |children: &[String]| children.iter().map(|c| node(s, t, surface, c, prefix)).collect::<Vec<_>>();
    let _ = &kids;
    match n {
        Node::Column { gap: g, children } => col().key(key).w_full().gap(gap(*g)).children(kids(children)),
        Node::Row { gap: g, children } => {
            // Content shares the row; buttons and badges keep their own width.
            let mut r = row().key(key).w_full().gap(gap(*g)).items_start().flex_wrap();
            for c in children {
                let k = node(s, t, surface, c, prefix);
                let fixed = matches!(surface.nodes.get(c), Some(Node::Button { .. } | Node::Badge { .. }));
                r = r.child(if fixed { k } else { col().grow(1.0).min_w(140.0).child(k) });
            }
            r
        }
        Node::Card { title, children } => {
            let mut c = col().key(key).w_full().gap(8.0).padding(12.0).radius(10.0).fill(t.background.alpha(0.6)).border(1.0, t.border);
            if let Some(tl) = title {
                c = c.child(label(tl.clone(), type_::SM_MEDIUM, t.foreground).wrap());
            }
            c.children(kids(children))
        }
        Node::Heading(x) => label(x.clone(), type_::BASE_MEDIUM, t.foreground).key(key).wrap().role("heading"),
        Node::Text { text, muted } => label(text.clone(), type_::SM_13, if *muted { t.muted_foreground } else { t.foreground.alpha(0.9) }).key(key).wrap().selectable(true),
        Node::Metric { label: l, value, hint, trend } => {
            let mut v = row().gap(6.0).items_end().child(label(value.clone(), type_::TITLE.features("'tnum' 1"), t.foreground));
            if let Some(tr) = trend {
                let (glyph, ink) = match tr {
                    Trend::Up => ("↑", t.supported),
                    Trend::Down => ("↓", t.wrong),
                    Trend::Flat => ("→", t.muted_foreground),
                };
                v = v.child(label(glyph, type_::SM_MEDIUM, ink).pb(1.0));
            }
            let mut c = col().key(key).w_full().gap(2.0).px(12.0).py(10.0).radius(8.0).fill(t.accent.alpha(0.6)).child(label(l.clone(), type_::XS, t.muted_foreground).wrap()).child(v);
            if let Some(h) = hint {
                c = c.child(label(h.clone(), type_::XS, t.muted_foreground).wrap());
            }
            c
        }
        Node::Badge { text, tone: tn } => {
            let (ink, soft) = tone(t, *tn);
            row().key(key).child(status_chip(t, text, ink, soft))
        }
        Node::Progress { label: l, value, hint } => {
            let pct = (value * 100.0).round();
            let bar = row()
                .w_full()
                .h(6.0)
                .radius(3.0)
                .clip_rounded(3.0)
                .fill(t.accent)
                .children((*value > 0.0).then(|| el().h_full().grow(*value as f32).fill(t.chart.primary)))
                .children((*value < 1.0).then(|| el().h_full().grow(1.0 - *value as f32)));
            let mut c = col()
                .key(key)
                .w_full()
                .gap(6.0)
                .label(format!("{l}, {pct}%"))
                .child(row().w_full().gap(8.0).child(label(l.clone(), type_::SM_13, t.foreground).wrap().grow(1.0).min_w(0.0)).child(label(format!("{pct}%"), type_::XS.features("'tnum' 1"), t.muted_foreground)))
                .child(bar);
            if let Some(h) = hint {
                c = c.child(label(h.clone(), type_::XS, t.muted_foreground).wrap());
            }
            c
        }
        Node::List(items) => {
            let mut c = col().key(key).w_full().gap(8.0).role("list");
            for (i, it) in items.iter().enumerate() {
                let dot = match it.tone {
                    Some(tn) => tone(t, tn).0,
                    None => t.muted_foreground.alpha(0.6),
                };
                let mut text_ = col().grow(1.0).min_w(0.0).gap(1.0).child(label(it.title.clone(), type_::SM_13, t.foreground).wrap());
                if let Some(d) = &it.detail {
                    text_ = text_.child(label(d.clone(), type_::XS, t.muted_foreground).wrap());
                }
                c = c.child(row().key(format!("item-{i}")).w_full().gap(10.0).items_start().role("listitem").child(el().mt(7.0).size(6.0, 6.0).radius(3.0).fill(dot)).child(text_));
            }
            c
        }
        Node::Table { columns, rows } => {
            let cell = |x: &str, style, color, n: usize| {
                let c = row().w(0.0).grow(1.0).min_w(0.0).px(8.0).py(6.0).child(label(x.to_string(), style, color).truncate());
                if n == 0 { c } else { c.justify_end() }
            };
            let mut head = row().w_full();
            for (n, h) in columns.iter().enumerate() {
                head = head.child(cell(h, type_::XS_MEDIUM, t.muted_foreground, n));
            }
            let mut c = col().key(key).w_full().role("table").child(head);
            for (r, cells) in rows.iter().enumerate() {
                let mut line = row().key(format!("row-{r}")).w_full().border_sides([1.0, 0.0, 0.0, 0.0], t.border.alpha(0.6));
                for (n, x) in cells.iter().enumerate() {
                    line = line.child(cell(x, type_::XS.features("'tnum' 1"), t.foreground, n));
                }
                c = c.child(line);
            }
            c
        }
        Node::Chart(raw) => crate::ui::visual::view(s, t, key, raw),
        Node::Divider => el().key(key).w_full().h(1.0).fill(t.border),
        Node::Series { label: l, unit, points, items } => crate::ui::series::view(s, t, &key, l.as_deref(), unit, points, items),
        Node::Button { label: l, action } => {
            let b = match action {
                // A follow-up the person reads in the composer, then sends.
                Action::Ask(prompt) => {
                    let p = prompt.clone();
                    button(t, &key, l, Variant::Primary).help("Types this follow-up for you to send").on_press_tx(move |s: &mut App, tx| {
                        s.composer.replace_text(&p);
                        tx.focus("composer-input", false);
                    })
                }
                // An https page, opened only on the person's press.
                Action::Open(url) => {
                    let u = url.clone();
                    button(t, &key, &format!("{l} ↗"), Variant::Outline).help(url.clone()).cursor(Cursor::Pointer).on_press_tx(move |s: &mut App, tx| {
                        s.open_link(&u, tx);
                    })
                }
            };
            row().child(b)
        }
    }
}
