//! The person's preferences (`lib/preferences.ts`), kept between launches in
//! the app's support folder as the web keeps them in the browser.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemePref {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ChatWidth {
    #[default]
    Comfortable,
    /// "Full" was retired, on the web too: a saved full width reads as Wide.
    #[serde(alias = "full")]
    Wide,
}

impl ChatWidth {
    /// The chat column's widest, as `--chat-max-width` (48rem or 72rem).
    pub fn max(self) -> f32 {
        match self {
            ChatWidth::Comfortable => 768.0,
            ChatWidth::Wide => 1152.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Landing {
    #[default]
    Agent,
    Today,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    #[default]
    Friendly,
    Concise,
    Detailed,
}

impl Style {
    pub fn key(self) -> &'static str {
        match self {
            Style::Friendly => "friendly",
            Style::Concise => "concise",
            Style::Detailed => "detailed",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            Style::Friendly => "The answer first, what it means for your business, and the next step, in plain words.",
            Style::Concise => "Just the answer and one next step.",
            Style::Detailed => "The reasoning and sources behind each point, with alternatives and trade-offs.",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub theme: ThemePref,
    pub chat_width: ChatWidth,
    pub reduce_motion: bool,
    pub landing: Landing,
    pub show_issue_count: bool,
    pub response_style: Style,
    pub enter_to_send: bool,
    /// The composer's microphone, for macOS dictation.
    pub voice_input: bool,
    /// The sidebar's width when open, dragged from its edge (the web's 224 to 448).
    pub sidebar_width: f32,
    /// The Inbox message list, resized independently of the workspace sidebar.
    pub inbox_width: f32,
    /// Opened Inbox items on this device, scoped to server, account and business.
    pub inbox_read: std::collections::BTreeSet<String>,
    /// The share of the card beside the panel (an artifact or a helper session), in percent (30 to 70).
    pub helper_width: f32,
    /// The AI answer review popup, dragged from its edges; kept between launches.
    pub answer_dialog_width: f32,
    pub answer_dialog_height: f32,
    /// When false, the popup opens nearly full-window; set true after the user resizes.
    #[serde(default)]
    pub answer_dialog_custom: bool,
    /// How large the whole interface draws (⌘+ and ⌘−), 1.0 being the web's sizes.
    pub zoom: f32,
    /// The OpenRecord server this app signs in to, when it is not the one on this Mac.
    pub server: Option<String>,
}

/// The zoom steps ⌘+ and ⌘− move through, and where ⌘0 returns.
pub const ZOOMS: [f32; 8] = [0.75, 0.8, 0.85, 0.9, 1.0, 1.1, 1.2, 1.25];
pub const ZOOM_DEFAULT: f32 = 0.9;

pub const SIDEBAR_DEFAULT: f32 = 256.0;
pub const SIDEBAR_MIN: f32 = 224.0;
pub const SIDEBAR_MAX: f32 = 448.0;
pub const INBOX_DEFAULT: f32 = 320.0;
pub const INBOX_MIN: f32 = 240.0;
pub const INBOX_MAX: f32 = 520.0;
pub const HELPER_DEFAULT: f32 = 50.0;
pub const ANSWER_DIALOG_DEFAULT_W: f32 = 1080.0;
pub const ANSWER_DIALOG_DEFAULT_H: f32 = 760.0;
pub const ANSWER_DIALOG_MIN_W: f32 = 640.0;
pub const ANSWER_DIALOG_MIN_H: f32 = 420.0;
/// Padding around the AI answer popup in the scrim (`answer-layer`).
pub const ANSWER_DIALOG_WINDOW_PAD: f32 = 24.0;

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            theme: ThemePref::System,
            chat_width: ChatWidth::Comfortable,
            reduce_motion: false,
            landing: Landing::Agent,
            show_issue_count: true,
            response_style: Style::Friendly,
            enter_to_send: true,
            voice_input: true,
            sidebar_width: SIDEBAR_DEFAULT,
            inbox_width: INBOX_DEFAULT,
            inbox_read: Default::default(),
            helper_width: HELPER_DEFAULT,
            answer_dialog_width: ANSWER_DIALOG_DEFAULT_W,
            answer_dialog_height: ANSWER_DIALOG_DEFAULT_H,
            answer_dialog_custom: false,
            zoom: ZOOM_DEFAULT,
            server: None,
        }
    }
}

impl Prefs {
    pub fn inbox_opened(&self, scope: &str, business: &str, key: &str) -> bool {
        self.inbox_read.contains(&serde_json::to_string(&(scope, business, key)).expect("string tuple"))
    }

    pub fn open_inbox_item(&mut self, scope: &str, business: &str, key: &str) -> bool {
        self.inbox_read.insert(serde_json::to_string(&(scope, business, key)).expect("string tuple"))
    }

    pub fn load() -> Prefs {
        if rune::tooling::headless_run().is_some() {
            return Prefs::default();
        }
        path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        if rune::tooling::headless_run().is_some() {
            return;
        }
        if let (Some(p), Ok(json)) = (path(), serde_json::to_string_pretty(self)) {
            let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
            let _ = std::fs::write(p, json);
        }
    }

    /// The sidebar's width, kept within the web's bounds.
    pub fn sidebar(&self) -> f32 {
        self.sidebar_width.clamp(SIDEBAR_MIN, SIDEBAR_MAX)
    }

    pub fn inbox(&self) -> f32 {
        if self.inbox_width.is_finite() { self.inbox_width.clamp(INBOX_MIN, INBOX_MAX) } else { INBOX_DEFAULT }
    }

    /// The interface's zoom, kept within the steps.
    pub fn zoom(&self) -> f32 {
        if self.zoom.is_finite() { self.zoom.clamp(ZOOMS[0], ZOOMS[ZOOMS.len() - 1]) } else { ZOOM_DEFAULT }
    }

    /// The next zoom step up (`dir` > 0) or down from the current one.
    pub fn step_zoom(&mut self, dir: i32) {
        let z = self.zoom();
        self.zoom = if dir > 0 { ZOOMS.iter().copied().find(|s| *s > z + 0.001) } else { ZOOMS.iter().rev().copied().find(|s| *s < z - 0.001) }.unwrap_or(z);
    }

    /// The helper's share of the split, kept within 30 to 70 percent.
    pub fn helper(&self) -> f32 {
        self.helper_width.clamp(30.0, 70.0)
    }

    /// Largest size the answer popup may take in the current window.
    pub fn answer_dialog_max(&self, window: (f32, f32), zoom: f32) -> (f32, f32) {
        let z = zoom.max(0.01);
        let max_w = (window.0 / z - ANSWER_DIALOG_WINDOW_PAD).max(ANSWER_DIALOG_MIN_W);
        let max_h = (window.1 / z - ANSWER_DIALOG_WINDOW_PAD).max(ANSWER_DIALOG_MIN_H);
        (max_w, max_h)
    }

    /// Nearly all of the workspace, for the default (non-custom) popup size.
    pub fn answer_dialog_fitted(&self, window: (f32, f32), zoom: f32) -> (f32, f32) {
        let (max_w, max_h) = self.answer_dialog_max(window, zoom);
        let w = (max_w * 0.94).round();
        let h = (max_h * 0.92).round();
        (w.clamp(ANSWER_DIALOG_MIN_W, max_w), h.clamp(ANSWER_DIALOG_MIN_H, max_h))
    }

    /// The answer popup's size: fitted large until the user has resized once.
    pub fn answer_dialog(&self, window: (f32, f32), zoom: f32) -> (f32, f32) {
        if !self.answer_dialog_custom {
            return self.answer_dialog_fitted(window, zoom);
        }
        let (max_w, max_h) = self.answer_dialog_max(window, zoom);
        let w = if self.answer_dialog_width.is_finite() {
            self.answer_dialog_width
        } else {
            ANSWER_DIALOG_DEFAULT_W
        };
        let h = if self.answer_dialog_height.is_finite() {
            self.answer_dialog_height
        } else {
            ANSWER_DIALOG_DEFAULT_H
        };
        (w.clamp(ANSWER_DIALOG_MIN_W, max_w).round(), h.clamp(ANSWER_DIALOG_MIN_H, max_h).round())
    }

    /// Whether to draw dark, given what the system asks for.
    pub fn dark(&self, system_dark: bool) -> bool {
        match self.theme {
            ThemePref::Light => false,
            ThemePref::Dark => true,
            ThemePref::System => system_dark,
        }
    }
}

fn path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Application Support/OpenRecord/preferences.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_defaults() {
        let p: Prefs = serde_json::from_str(r#"{ "theme": "dark", "chat_width": "wide" }"#).unwrap();
        assert_eq!((p.theme, p.chat_width, p.enter_to_send, p.response_style), (ThemePref::Dark, ChatWidth::Wide, true, Style::Friendly));
        // The retired "full" width reads as Wide.
        let full: Prefs = serde_json::from_str(r#"{ "chat_width": "full" }"#).unwrap();
        assert_eq!(full.chat_width, ChatWidth::Wide);
        assert!(p.dark(false));
        assert!(!Prefs::default().dark(false));
        assert_eq!((p.sidebar(), p.helper()), (SIDEBAR_DEFAULT, HELPER_DEFAULT));
        let mut zoomed = Prefs::default();
        zoomed.step_zoom(1);
        assert_eq!(zoomed.zoom(), 1.0);
        zoomed.step_zoom(-1);
        zoomed.step_zoom(-1);
        assert_eq!(zoomed.zoom(), 0.85);
        let wide: Prefs = serde_json::from_str(r#"{ "sidebar_width": 900, "helper_width": 10 }"#).unwrap();
        assert_eq!((wide.sidebar(), wide.helper()), (SIDEBAR_MAX, 30.0));
    }

    #[test]
    fn inbox_read_state_is_idempotent_persisted_and_scoped() {
        let mut p: Prefs = serde_json::from_str("{}").unwrap();
        assert!(!p.inbox_opened("server/account-a", "business-a", "proposal:1"));
        assert!(p.open_inbox_item("server/account-a", "business-a", "proposal:1"));
        assert!(!p.open_inbox_item("server/account-a", "business-a", "proposal:1"));
        let saved: Prefs = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert!(saved.inbox_opened("server/account-a", "business-a", "proposal:1"));
        assert!(!saved.inbox_opened("server/account-b", "business-a", "proposal:1"));
        assert!(!saved.inbox_opened("server/account-a", "business-b", "proposal:1"));
        assert!(!saved.inbox_opened("other-server/account-a", "business-a", "proposal:1"));
        assert!(!saved.inbox_opened("server/account-a", "business-a", "proposal:2"));
    }

    #[test]
    fn inbox_width_is_backward_compatible_bounded_and_saved() {
        let mut p: Prefs = serde_json::from_str(r#"{"sidebar_width":300}"#).unwrap();
        assert_eq!(p.inbox(), INBOX_DEFAULT);
        p.inbox_width = 416.0;
        let saved: Prefs = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(saved.inbox(), 416.0);
        assert_eq!(saved.sidebar(), 300.0);
        p.inbox_width = f32::NAN;
        assert_eq!(p.inbox(), INBOX_DEFAULT);
        p.inbox_width = 1000.0;
        assert_eq!(p.inbox(), INBOX_MAX);
        p.inbox_width = 0.0;
        assert_eq!(p.inbox(), INBOX_MIN);
    }
}
