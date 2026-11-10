//! The web app's design tokens (`apps/web/app/globals.css`), light and dark.
//!
//! Brand: deep navy primary (#020c44) and periwinkle secondary (#7096f9). The
//! window is the sidebar-coloured canvas; content sits on it as one inset,
//! rounded panel lit by a white inner rim (light) or a faint top line (dark).

use rune::{Color, Shadow, TextStyle, oklch, oklcha};

pub fn hex(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::BLACK)
}

fn black(a: f32) -> Color {
    Color::BLACK.alpha(a)
}

fn white(a: f32) -> Color {
    Color::WHITE.alpha(a)
}

const fn sh(x: f32, y: f32, blur: f32, spread: f32, color: Color, inset: bool) -> Shadow {
    Shadow { x, y, blur, spread, color, inset }
}

/// Chart colours (`--chart-*` and `--series-*`).
#[derive(Clone, Debug)]
pub struct Chart {
    pub primary: Color,
    pub compare: Color,
    pub grid: Color,
    pub axis: Color,
    pub supported: Color,
    pub wrong: Color,
    pub partial: Color,
    pub unknown: Color,
    pub unreviewed: Color,
    /// Categorical slots for AI models, in the web's fixed order.
    pub series: [Color; 12],
}

#[derive(Clone, Debug)]
pub struct Theme {
    pub dark: bool,
    pub background: Color,
    pub foreground: Color,
    pub card: Color,
    pub popover: Color,
    pub primary: Color,
    pub primary_foreground: Color,
    pub primary_ink: Color,
    pub muted_foreground: Color,
    pub accent: Color,
    pub border: Color,
    pub ring: Color,
    pub sidebar: Color,
    pub sidebar_foreground: Color,
    pub sidebar_accent: Color,
    pub control: Color,
    pub wrong: Color,
    pub wrong_soft: Color,
    pub partial: Color,
    pub partial_soft: Color,
    pub unknown: Color,
    pub unknown_soft: Color,
    pub review: Color,
    pub review_soft: Color,
    pub supported: Color,
    pub supported_soft: Color,
    pub working: Color,
    pub hover_tint: Color,
    pub chart: Chart,
    pub panel_shadow: Vec<Shadow>,
    pub card_shadow: Vec<Shadow>,
    pub control_shadow: Vec<Shadow>,
    pub primary_shadow: Vec<Shadow>,
    pub float_shadow: Vec<Shadow>,
    pub badge_shadow: Vec<Shadow>,
    pub track_inner: Vec<Shadow>,
    pub mark_shadow: Vec<Shadow>,
}

impl Theme {
    pub fn get(dark: bool) -> Theme {
        if dark { Self::dark() } else { Self::light() }
    }

    pub fn light() -> Theme {
        Theme {
            dark: false,
            background: hex("#f9f9f9"),
            foreground: hex("#1a1a1a"),
            card: hex("#f9f9f9"),
            popover: hex("#ffffff"),
            primary: hex("#020c44"),
            primary_foreground: hex("#ffffff"),
            primary_ink: hex("#020c44"),
            muted_foreground: hex("#6b6b6b"),
            accent: hex("#ededed"),
            border: black(0.07),
            ring: oklcha(0.199, 0.105, 265.2, 0.45),
            sidebar: hex("#efefef"),
            sidebar_foreground: hex("#4a4a4a"),
            sidebar_accent: hex("#ededed"),
            control: hex("#ffffff"),
            wrong: oklch(0.55, 0.19, 27.0),
            wrong_soft: oklch(0.97, 0.018, 27.0),
            partial: oklch(0.58, 0.13, 65.0),
            partial_soft: oklch(0.975, 0.03, 85.0),
            unknown: oklch(0.5, 0.13, 285.0),
            unknown_soft: oklch(0.965, 0.02, 285.0),
            review: oklch(0.5, 0.14, 255.0),
            review_soft: oklch(0.965, 0.02, 255.0),
            supported: oklch(0.47, 0.09, 160.0),
            supported_soft: oklch(0.965, 0.025, 160.0),
            working: hex("#0284c7"),
            hover_tint: black(0.035),
            chart: Chart {
                primary: oklch(0.49, 0.091, 241.5),
                compare: oklch(0.581, 0.106, 126.7),
                grid: oklcha(0.912, 0.006, 84.6, 0.7),
                axis: oklcha(0.556, 0.008, 84.6, 0.85),
                supported: hex("#1f9d6a"),
                wrong: hex("#d03b3b"),
                partial: hex("#e09a12"),
                unknown: hex("#8277c9"),
                unreviewed: hex("#2a78d6"),
                series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948", "#0e7c86", "#64748b", "#65a30d", "#7c3aed"].map(hex),
            },
            panel_shadow: vec![
                sh(0.0, 0.0, 0.0, 1.0, white(0.95), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.06), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.04), false),
                sh(0.0, 8.0, 24.0, -12.0, black(0.1), false),
            ],
            card_shadow: vec![
                sh(0.0, 0.0, 0.0, 1.0, white(0.9), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.05), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.04), false),
                sh(0.0, 4.0, 12.0, -6.0, black(0.08), false),
            ],
            control_shadow: vec![
                sh(0.0, 0.0, 0.0, 1.0, white(0.85), true),
                sh(0.0, 1.0, 0.0, 0.0, white(0.9), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.1), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.06), false),
            ],
            primary_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.12), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.8), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.2), false),
            ],
            float_shadow: vec![
                sh(0.0, 0.0, 0.0, 1.0, white(0.95), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.07), false),
                sh(0.0, 4.0, 10.0, -2.0, black(0.07), false),
                sh(0.0, 14.0, 32.0, -8.0, black(0.12), false),
            ],
            badge_shadow: vec![sh(0.0, 1.0, 2.0, 0.0, black(0.06), false), sh(0.0, 1.0, 0.0, 0.0, white(0.5), true)],
            track_inner: vec![sh(0.0, 0.0, 0.0, 1.0, white(0.9), true)],
            mark_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.5), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.1), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.14), false),
            ],
        }
    }

    pub fn dark() -> Theme {
        let border = white(0.05);
        Theme {
            dark: true,
            background: hex("#1a1a1a"),
            // Softer than the web's #eeeeee and #b5b5b5: text drawn natively reads brighter
            // than the browser's at the same value, so dark mode steps both down.
            foreground: hex("#e3e3e3"),
            card: hex("#212121"),
            popover: hex("#212121"),
            primary: hex("#ffffff"),
            primary_foreground: hex("#202020"),
            primary_ink: oklch(0.8, 0.09, 266.0),
            muted_foreground: hex("#a6a6a6"),
            accent: hex("#292929"),
            border,
            ring: oklcha(0.8, 0.09, 266.0, 0.45),
            sidebar: hex("#141414"),
            sidebar_foreground: hex("#a6a6a6"),
            sidebar_accent: hex("#292929"),
            control: hex("#2a2a2a"),
            wrong: oklch(0.74, 0.15, 25.0),
            wrong_soft: oklch(0.3, 0.06, 25.0),
            partial: oklch(0.8, 0.13, 75.0),
            partial_soft: oklch(0.31, 0.05, 75.0),
            unknown: oklch(0.76, 0.1, 285.0),
            unknown_soft: oklch(0.3, 0.05, 285.0),
            review: oklch(0.76, 0.11, 255.0),
            review_soft: oklch(0.3, 0.06, 255.0),
            supported: oklch(0.78, 0.12, 160.0),
            supported_soft: oklch(0.3, 0.05, 160.0),
            working: hex("#7dd3fc").alpha(0.8),
            hover_tint: white(0.04),
            chart: Chart {
                primary: oklch(0.72, 0.1, 241.5),
                compare: oklch(0.74, 0.1, 126.7),
                grid: white(0.07),
                axis: oklcha(0.7, 0.008, 84.6, 0.85),
                supported: hex("#199e70"),
                wrong: hex("#e05a5a"),
                partial: hex("#c98500"),
                unknown: hex("#8579d4"),
                unreviewed: hex("#3d8ae6"),
                series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767", "#2dd4bf", "#94a3b8", "#a3e635", "#a78bfa"].map(hex),
            },
            panel_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.03), true),
                sh(0.0, 0.0, 0.0, 1.0, border, false),
                sh(0.0, 1.0, 3.0, 0.0, black(0.5), false),
                sh(0.0, 10.0, 30.0, -12.0, black(0.6), false),
            ],
            card_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.03), true),
                sh(0.0, 0.0, 0.0, 1.0, border, false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.5), false),
                sh(0.0, 6.0, 16.0, -8.0, black(0.5), false),
            ],
            control_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.07), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.6), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.45), false),
            ],
            primary_shadow: vec![sh(0.0, -1.0, 0.0, 0.0, black(0.15), true), sh(0.0, 1.0, 2.0, 0.0, black(0.5), false)],
            float_shadow: vec![
                sh(0.0, 0.0, 0.0, 1.0, white(0.07), false),
                sh(0.0, 1.0, 3.0, 0.0, black(0.4), false),
                sh(0.0, 8.0, 28.0, 0.0, black(0.45), false),
            ],
            badge_shadow: vec![sh(0.0, 1.0, 2.0, 0.0, black(0.35), false), sh(0.0, 1.0, 0.0, 0.0, white(0.04), true)],
            track_inner: vec![sh(0.0, 0.0, 0.0, 1.0, border, true)],
            mark_shadow: vec![
                sh(0.0, 1.0, 0.0, 0.0, white(0.2), true),
                sh(0.0, 0.0, 0.0, 1.0, black(0.55), false),
                sh(0.0, 1.0, 2.0, 0.0, black(0.4), false),
            ],
        }
    }

    /// The colour pair a business mark uses, picked from its name as the web
    /// app's `markColor` does: blue, primary navy, or rose.
    pub fn mark(&self, name: &str) -> (Color, Color) {
        let mut hash: u32 = 0;
        for unit in name.trim().to_lowercase().encode_utf16() {
            hash = hash.wrapping_mul(31).wrapping_add(unit as u32);
        }
        match hash % 3 {
            0 => (hex("#3b82f6"), Color::WHITE),
            1 => (self.primary, self.primary_foreground),
            _ => (hex("#e58ca1"), Color::WHITE),
        }
    }
}

/// Applies a list of box shadows to an element, in CSS order.
pub fn shadows(mut e: rune::El, list: &[Shadow]) -> rune::El {
    for s in list {
        e = e.box_shadow(*s);
    }
    e
}

/// Type scale: Tailwind's text-xs to text-xl at Inter's web metrics.
pub mod type_ {
    use super::TextStyle;
    pub const XS2: TextStyle = TextStyle::new(10.0, 400.0).lh(14.0);
    /// Chart axis ticks (10.5 px).
    pub const AXIS: TextStyle = TextStyle::new(10.5, 400.0).lh(14.0).features("'tnum' 1");
    /// Chart legends and tooltip dates (0.6875 rem).
    pub const XS11: TextStyle = TextStyle::new(11.0, 400.0).lh(16.0);
    pub const XS: TextStyle = TextStyle::new(12.0, 400.0).lh(16.0);
    pub const XS_MEDIUM: TextStyle = TextStyle::new(12.0, 500.0).lh(16.0);
    pub const SM_13: TextStyle = TextStyle::new(13.0, 400.0).lh(20.0);
    pub const SM: TextStyle = TextStyle::new(14.0, 400.0).lh(20.0);
    pub const SM_MEDIUM: TextStyle = TextStyle::new(14.0, 500.0).lh(20.0);
    pub const BASE: TextStyle = TextStyle::new(16.0, 400.0).lh(24.0);
    pub const BASE_MEDIUM: TextStyle = TextStyle::new(16.0, 500.0).lh(24.0);
    pub const TITLE: TextStyle = TextStyle::new(18.0, 600.0).lh(22.0);
    pub const COUNT: TextStyle = TextStyle::new(10.0, 500.0).lh(14.0).features("'tnum' 1");
}
