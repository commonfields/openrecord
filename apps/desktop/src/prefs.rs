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
            Style::Detailed => "The reasoning and evidence behind each point, with alternatives and trade-offs.",
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
    pub default_provider: String,
    /// The sidebar's width when open, dragged from its edge (the web's 224 to 448).
    pub sidebar_width: f32,
    /// A helper session's share of the conversation split, in percent (30 to 70).
    pub helper_width: f32,
}

pub const SIDEBAR_DEFAULT: f32 = 256.0;
pub const SIDEBAR_MIN: f32 = 224.0;
pub const SIDEBAR_MAX: f32 = 448.0;
pub const HELPER_DEFAULT: f32 = 50.0;

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
            default_provider: "mock".into(),
            sidebar_width: SIDEBAR_DEFAULT,
            helper_width: HELPER_DEFAULT,
        }
    }
}

impl Prefs {
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

    /// The helper's share of the split, kept within 30 to 70 percent.
    pub fn helper(&self) -> f32 {
        self.helper_width.clamp(30.0, 70.0)
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
        let wide: Prefs = serde_json::from_str(r#"{ "sidebar_width": 900, "helper_width": 10 }"#).unwrap();
        assert_eq!((wide.sidebar(), wide.helper()), (SIDEBAR_MAX, 30.0));
    }
}
