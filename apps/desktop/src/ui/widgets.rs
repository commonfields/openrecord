//! The web app's small parts: buttons, marks, badges, cards and empty states.

use rune::{Color, Cursor, El, Icon, Spring, TextStyle, col, el, icon, row, text};

use crate::state::App;
use crate::theme::{Theme, shadows, type_};

pub const CONTROL: Spring = Spring::new(0.18, 0.0);

/// The web's `transition-[background-color,box-shadow]`: 150 milliseconds.
pub const HOVER: Spring = Spring::new(0.15, 0.0);

/// A menu row's highlight as the web draws it: hovered or picked by the arrows,
/// the accent fill with the control shadow; the chosen one, half the accent.
/// The fill and shadow are always there, transparent at rest, so Rune eases
/// them in and out instead of swapping them.
pub fn highlight(t: &crate::theme::Theme, r: El, hovered: bool, chosen: bool) -> El {
    let fill = if hovered {
        t.accent
    } else if chosen {
        t.accent.alpha(0.5)
    } else {
        t.accent.alpha(0.0)
    };
    let list: Vec<rune::Shadow> = t.control_shadow.iter().map(|s| rune::Shadow { color: if hovered { s.color } else { s.color.alpha(0.0) }, ..*s }).collect();
    shadows(r.fill(fill).motion(HOVER), &list)
}

pub fn ico(i: &'static Icon, size: f32, color: Color) -> El {
    icon(i, size).color(color)
}

pub fn label(s: impl Into<String>, style: TextStyle, color: Color) -> El {
    text(s.into()).font(style).color(color)
}

/// A square ghost button holding an icon (`size="icon-sm"`, 28 points).
pub fn icon_button(t: &Theme, key: &str, i: &'static Icon, name: &str, on: bool) -> El {
    let mut b = row()
        .key(key)
        .size(28.0, 28.0)
        .radius(6.0)
        .center()
        .role("button")
        .label(name)
        .help(name)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .press(t.hover_tint)
        .motion(CONTROL)
        .child(ico(i, 16.0, if on { t.foreground } else { t.sidebar_foreground }));
    if on {
        b = shadows(b.fill(t.sidebar_accent), &t.control_shadow);
    }
    b
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Navy (white in dark mode) with a crisp dark outline.
    Primary,
    /// The control surface with a lit top edge.
    Outline,
}

pub fn button(t: &Theme, key: &str, text_: &str, variant: Variant) -> El {
    let (fill, ink, list) = match variant {
        Variant::Primary => (t.primary, t.primary_foreground, &t.primary_shadow),
        Variant::Outline => (t.control, t.foreground, &t.control_shadow),
    };
    let b = row()
        .key(key)
        .h(32.0)
        .px(12.0)
        .radius(8.0)
        .center()
        .role("button")
        .label(text_)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .fill(fill)
        .hover(if variant == Variant::Primary { Color::WHITE.alpha(0.08) } else { t.hover_tint })
        .press(t.hover_tint)
        .motion(CONTROL)
        .child(label(text_, type_::SM_MEDIUM, ink));
    shadows(b, list)
}

/// A business's mark: its initial on a glossy tile in its colour.
pub fn business_mark(t: &Theme, name: Option<&str>, size: f32, radius: f32) -> El {
    let (bg, fg) = match name {
        Some(n) => t.mark(n),
        None => (t.primary, t.primary_foreground),
    };
    let glyph = name.and_then(|n| n.trim().chars().next()).map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into());
    let font = TextStyle::new((size * 0.42).round().max(10.0), 600.0);
    let tile = row()
        .size(size, size)
        .radius(radius)
        .center()
        .fill(bg)
        .linear_gradient(std::f32::consts::PI, [(0.0, Color::WHITE.alpha(0.3)), (0.5, Color::WHITE.alpha(0.05)), (1.0, Color::BLACK.alpha(0.16))])
        .a11y_hidden()
        .child(label(glyph, font, fg));
    shadows(tile, &t.mark_shadow)
}

/// The account sphere: a glossy periwinkle ball, the same in both themes.
pub fn avatar_sphere(t: &Theme, size: f32) -> El {
    let hex = |s: &str| rune::color::hex(s).unwrap_or(Color::BLACK);
    let w = |a: f32| Color::WHITE.alpha(a);
    let base = el()
        .size(size, size)
        .radius(size / 2.0)
        .fill(hex("#6f6b9d"))
        .radial_gradient([0.44, 0.36], size * 0.71, [
            (0.0, hex("#918cba")),
            (0.32, hex("#7e79ab")),
            (0.62, hex("#5a5687")),
            (0.88, hex("#3d3a5f")),
            (1.0, hex("#343157")),
        ])
        .a11y_hidden();
    let shade = el().absolute(0.0, 0.0).size(size, size).radius(size / 2.0).radial_gradient([0.46, 0.78], size * 0.45, [
        (0.0, hex("#141226").alpha(0.5)),
        (1.0, Color::TRANSPARENT),
    ]);
    let wide = el().absolute(0.0, 0.0).size(size, size).radius(size / 2.0).radial_gradient([0.76, 0.30], size * 0.22, [
        (0.0, w(0.9)),
        (0.41, w(0.25)),
        (1.0, w(0.0)),
    ]);
    let small = el().absolute(0.0, 0.0).size(size, size).radius(size / 2.0).radial_gradient([0.26, 0.22], size * 0.14, [(0.0, w(0.75)), (1.0, w(0.0))]);
    let edge = if t.dark { Color::WHITE.alpha(0.04) } else { Color::BLACK.alpha(0.08) };
    base.child(shade).child(wide).child(small).box_shadow(rune::Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 1.0, color: edge, inset: false })
}

/// A small count on a soft red pill (the sidebar's "AI answers 4").
pub fn count_badge(t: &Theme, n: i64) -> El {
    let b = row().px(6.0).h(17.0).radius(9.0).center().fill(t.wrong_soft).label(format!("{n} open")).child(label(n.to_string(), type_::COUNT, t.wrong));
    shadows(b, &t.badge_shadow)
}

/// A verdict or state chip: a soft tint with a dot in the status colour.
pub fn status_chip(text_: &str, ink: Color, soft: Color) -> El {
    row()
        .h(22.0)
        .px(8.0)
        .gap(6.0)
        .radius(11.0)
        .center_y()
        .fill(soft)
        .child(el().size(6.0, 6.0).radius(3.0).fill(ink))
        .child(label(text_, type_::XS_MEDIUM, ink))
}

/// A raised surface: the card colour held by a white rim inside a hairline.
pub fn card(t: &Theme) -> El {
    shadows(col().w_full().radius(12.0).fill(t.card), &t.card_shadow)
}

/// A page's title and the sentence under it.
pub fn page_header(t: &Theme, title: &str, description: &str) -> El {
    col()
        .gap(4.0)
        .max_w(560.0)
        .child(label(title, type_::TITLE, t.foreground).role("heading"))
        .child(label(description, type_::SM, t.muted_foreground).wrap())
}

/// The dashed empty card: a boxed icon, a title, a sentence and an action.
pub fn empty_state(t: &Theme, key: &str, i: &'static Icon, title: &str, body: &str, action: Option<El>) -> El {
    let boxed = shadows(row().size(46.0, 46.0).radius(12.0).center().fill(t.control).child(ico(i, 20.0, t.foreground)), &t.control_shadow);
    let mut c = col()
        .key(key)
        .w_full()
        .py(48.0)
        .px(24.0)
        .gap(6.0)
        .items_center()
        .radius(12.0)
        .border(1.0, t.border)
        .border_dash(4.0, 4.0)
        .child(boxed.mb(14.0))
        .child(label(title, type_::SM_MEDIUM, t.foreground))
        .child(label(body, type_::SM_13, t.muted_foreground).wrap());
    if let Some(a) = action {
        c = c.child(a.mt(14.0));
    }
    c
}

/// Grey bars where text will land, while a page loads.
pub fn skeleton(t: &Theme, rows: usize) -> El {
    let bar = |w: f32, h: f32| el().w(w).h(h).radius(6.0).fill(t.accent);
    let mut c = col().w_full().gap(0.0);
    for i in 0..rows {
        c = c.child(
            col()
                .key(format!("skeleton-{i}"))
                .w_full()
                .gap(10.0)
                .py(18.0)
                .px(18.0)
                .border_sides([0.0, 0.0, if i + 1 < rows { 1.0 } else { 0.0 }, 0.0], t.border)
                .child(bar(120.0, 18.0))
                .child(bar(560.0, 14.0))
                .child(bar(280.0, 10.0)),
        );
    }
    shadows(c.radius(12.0).fill(t.card).clip_rounded(12.0), &t.card_shadow)
}

/// A failed load, in words, with a way to try again.
pub fn failure(t: &Theme, key: &str, message: &str, retry: impl Fn(&mut App) + 'static) -> El {
    col()
        .key(key)
        .w_full()
        .gap(12.0)
        .py(28.0)
        .items_center()
        .child(ico(&crate::icons::TRIANGLE_ALERT, 18.0, t.wrong))
        .child(label(message, type_::SM, t.muted_foreground).wrap())
        .child(button(t, &format!("{key}-retry"), "Try again", Variant::Outline).on_press(retry))
}
