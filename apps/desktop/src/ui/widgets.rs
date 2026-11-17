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

/// `autofocus` on a condition, for the item a menu opens on.
pub trait AutofocusIf {
    fn autofocus_if(self, on: bool) -> Self;
}
impl AutofocusIf for El {
    fn autofocus_if(self, on: bool) -> Self {
        if on { self.autofocus() } else { self }
    }
}

/// Text in the interface. All of it can be selected and copied, as on the web:
/// drag across it, double-click a word. It keeps the arrow rather than the
/// I-beam, so a button's name still reads as a button; a press on text inside a
/// row still presses the row, and only a drag selects.
pub fn label(s: impl Into<String>, style: TextStyle, color: Color) -> El {
    text(s.into()).font(style).color(color).selectable(true).cursor(rune::Cursor::Default)
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
    /// `default`: the primary fill with its crisp shadow; 90% under the pointer.
    Primary,
    /// `outline`: the control surface and its shadow; `--control-hover` under the pointer.
    Outline,
    /// `ghost`: no surface until the pointer is over it, then the accent fill.
    Ghost,
}

/// The web's `Button` (`components/ui/button.tsx`): 28 points tall, 6-point
/// corners, 13-point medium text, 12 points either side.
/// Lift the label one point so its visible letters sit at the optical center.
pub fn button(t: &Theme, key: &str, text_: &str, variant: Variant) -> El {
    let (fill, hover, ink) = match variant {
        Variant::Primary => (t.primary, t.primary.alpha(0.9), t.primary_foreground),
        Variant::Outline => (t.control, t.control_hover, t.foreground),
        Variant::Ghost => (t.accent.alpha(0.0), t.accent, t.foreground),
    };
    let b = row()
        .key(key)
        .h(28.0)
        .px(12.0)
        .gap(6.0)
        .radius(6.0)
        .center()
        .role("button")
        .label(text_)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .fill(fill)
        .hover(hover)
        .press(hover)
        .motion(HOVER)
        .child(label(text_, rune::TextStyle::new(13.0, 500.0).lh(18.0), ink).offset(0.0, -1.0));
    match variant {
        Variant::Primary => shadows(b, &t.primary_shadow),
        Variant::Outline => shadows(b, &t.control_shadow),
        Variant::Ghost => b,
    }
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

/// The account's mark: a glossy tile in the colour picked from its email, as a
/// business mark is, with no letter on it.
pub fn account_tile(t: &Theme, email: Option<&str>, size: f32) -> El {
    let (bg, _) = t.mark(email.unwrap_or("account"));
    let tile = el()
        .size(size, size)
        .radius((size * 0.28).round())
        .fill(bg)
        .linear_gradient(std::f32::consts::PI, [(0.0, Color::WHITE.alpha(0.3)), (0.5, Color::WHITE.alpha(0.05)), (1.0, Color::BLACK.alpha(0.16))])
        .a11y_hidden();
    shadows(tile, &t.mark_shadow)
}

/// A small count on a soft red pill (the sidebar's "AI answers 4").
pub fn count_badge(t: &Theme, n: i64) -> El {
    let b = row().px(6.0).h(16.0).radius(8.0).center().fill(t.wrong_soft).label(format!("{n} open")).child(label(n.to_string(), type_::COUNT, t.wrong));
    shadows(b, &t.badge_shadow)
}

/// The web's `Badge` (`components/ui/badge.tsx`): a fully rounded pill, 11-point
/// medium text, a hairline ring in the status colour over its soft fill, and the
/// badge shadow so it sits on the surface.
pub fn status_chip(t: &Theme, text_: &str, ink: Color, soft: Color) -> El {
    badge(t, text_, ink, soft, None)
}

/// [`status_chip`] with a leading 12-point icon, as `IssueStateBadge` draws one.
pub fn badge(t: &Theme, text_: &str, ink: Color, soft: Color, icon_: Option<&'static Icon>) -> El {
    let b = row()
        .h(18.0)
        .px(6.0)
        .gap(4.0)
        .radius(9.0)
        .center_y()
        .fill(soft)
        .border(1.0, ink.alpha(0.2))
        .children(icon_.map(|i| ico(i, 12.0, ink)))
        .child(label(text_, rune::TextStyle::new(11.0, 500.0).lh(16.0), ink));
    shadows(b, &t.badge_shadow)
}

/// The hovered row, by key, for highlights that also carry a shadow (Rune's own
/// hover only swaps a fill).
pub fn track_hover(key: String) -> impl Fn(&mut App, bool, &mut rune::Tx) + 'static {
    move |s: &mut App, inside, _tx| {
        if inside {
            s.row_hover = Some(key.clone());
        } else if s.row_hover.as_deref() == Some(key.as_str()) {
            s.row_hover = None;
        }
    }
}

/// The web's sidebar link and menu row highlight: hovered, the accent at 70%
/// with the control shadow; current, the full accent with the shadow. Both ease.
pub fn nav_highlight(t: &Theme, r: El, hovered: bool, active: bool) -> El {
    let fill = if active { t.sidebar_accent } else if hovered { t.sidebar_accent.alpha(0.7) } else { t.sidebar_accent.alpha(0.0) };
    let on = active || hovered;
    let list: Vec<rune::Shadow> = t.control_shadow.iter().map(|s| rune::Shadow { color: if on { s.color } else { s.color.alpha(0.0) }, ..*s }).collect();
    shadows(r.fill(fill).motion(HOVER), &list)
}

/// The web's `Alert`: a card with a hairline border, 8-point corners, 16 by 12
/// padding and 12-point text.
pub fn alert(t: &Theme, key: &str, title: Option<&str>, body: El) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .px(16.0)
        .py(12.0)
        .gap(2.0)
        .radius(8.0)
        .fill(t.card)
        .border(1.0, t.border)
        .children(title.map(|x| label(x.to_string(), type_::XS_MEDIUM, t.foreground)))
        .child(body)
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

pub const EMPTY_STATE_TEXT_W: f32 = 380.0;

/// Room below a page header for a centered empty block, matching Campaigns.
pub fn empty_viewport_room(s: &App) -> f32 {
    (s.window.1 / s.zoom() - 220.0).max(360.0)
}

/// Centered plain empty block: no icon, no frame, left-aligned copy and action.
pub fn empty_state_plain(t: &Theme, key: &str, title: &str, body: &str, action: Option<El>) -> El {
    let mut c = col()
        .key(key)
        .gap(8.0)
        .max_w(EMPTY_STATE_TEXT_W)
        .items_start()
        .child(label(title, type_::SM_MEDIUM, t.foreground).wrap().w_full())
        .child(label(body, type_::SM_13, t.muted_foreground).wrap().w_full());
    if let Some(a) = action {
        c = c.child(a.mt(6.0));
    }
    c
}

/// Campaign-style region below a page header.
pub fn empty_state_page(shell_key: &str, height: f32, t: &Theme, key: &str, title: &str, body: &str, action: Option<El>) -> El {
    col()
        .key(shell_key)
        .w_full()
        .h(height)
        .justify_center()
        .items_center()
        .child(empty_state_plain(t, key, title, body, action))
}

/// Plain empty block centered in a growing panel (list card, inbox detail, and so on).
pub fn empty_state_panel(shell_key: &str, t: &Theme, key: &str, title: &str, body: &str, action: Option<El>) -> El {
    col()
        .key(shell_key)
        .w_full()
        .grow(1.0)
        .min_h(280.0)
        .justify_center()
        .items_center()
        .child(empty_state_plain(t, key, title, body, action))
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
