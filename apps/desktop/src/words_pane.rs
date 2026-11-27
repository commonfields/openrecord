//! Agent transcript drawn with `@pierre/words` in a WKWebView.

use std::cell::RefCell;

use serde::Serialize;

thread_local! {
    static LAST_PAYLOAD: RefCell<Option<String>> = const { RefCell::new(None) };
    static LAST_RECT: RefCell<Option<[f32; 4]>> = const { RefCell::new(None) };
}

use crate::chat;
use crate::state::{App, Load, Turn};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn or_words_show(x: f64, y: f64, w: f64, h: f64);
    fn or_words_hide();
    fn or_words_update(json: *const std::ffi::c_char);
    fn or_words_pass_through(on: i32);
    fn or_words_clear();
}

#[derive(Serialize)]
struct PaneMessage {
    role: &'static str,
    text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    fresh: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    divider: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    dark: bool,
    reduce_motion: bool,
    chat_max_px: f32,
    messages: Vec<PaneMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_answer: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<&'a str>,
}

pub fn hide() {
    LAST_PAYLOAD.with(|p| *p.borrow_mut() = None);
    LAST_RECT.with(|r| *r.borrow_mut() = None);
    #[cfg(target_os = "macos")]
    unsafe {
        or_words_hide();
    }
}

pub fn clear() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_words_clear();
    }
}

pub fn pass_through(on: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_words_pass_through(on as i32);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = on;
}

pub fn sync(s: &App, dark: bool) {
    #[cfg(not(target_os = "macos"))]
    let _ = (s, dark);
    #[cfg(target_os = "macos")]
    {
        let Some(rect) = s.words_rect else {
            // Layout may not have run yet; do not tear down an existing pane.
            return;
        };
        if rect[2] <= 0.0 || rect[3] <= 0.0 {
            return;
        }
        if !s.chat_shown() || s.settings.is_some() || !s.prefs.words_webview {
            hide();
            return;
        }
        let rect = s.gliding(0, rect);
        let payload = payload(s, dark);
        let Ok(json) = serde_json::to_string(&payload) else { return };
        let rect_changed = LAST_RECT.with(|r| r.borrow().map_or(true, |prev| prev != rect));
        let payload_changed = LAST_PAYLOAD.with(|p| p.borrow().as_deref() != Some(json.as_str()));
        if !rect_changed && !payload_changed {
            return;
        }
        LAST_RECT.with(|r| *r.borrow_mut() = Some(rect));
        if payload_changed {
            LAST_PAYLOAD.with(|p| *p.borrow_mut() = Some(json.clone()));
        }
        let Ok(c) = std::ffi::CString::new(json) else { return };
        unsafe {
            if rect_changed {
                or_words_show(rect[0] as f64, rect[1] as f64, rect[2] as f64, rect[3] as f64);
            }
            if payload_changed {
                or_words_update(c.as_ptr());
            }
        }
    }
}

fn payload<'a>(s: &'a App, dark: bool) -> Payload<'a> {
    let messages = s.transcript();
    let mut out = Vec::new();
    match &s.conversation {
        Load::Loading if messages.is_empty() => {
            return Payload {
                dark,
                reduce_motion: s.prefs.reduce_motion,
                chat_max_px: s.prefs.chat_width.max(),
                messages: out,
                pending_answer: None,
                loading: Some("Opening the chat…"),
            };
        }
        _ => {}
    }
    for (i, m) in messages.iter().enumerate() {
        if m.origin.as_ref().is_some_and(|o| o.kind == "wake") {
            let title = m.origin.as_ref().and_then(|o| o.title.clone()).unwrap_or_else(|| "Helper results arrived. Continuing".into());
            out.push(PaneMessage { role: "user", text: String::new(), fresh: false, muted: false, divider: Some(title) });
            continue;
        }
        if m.role == "user" && chat::is_brief_request(&m.text) {
            out.push(PaneMessage { role: "user", text: String::new(), fresh: false, muted: false, divider: Some("Scheduled weekly brief".into()) });
            continue;
        }
        if m.role == "user" {
            if !m.text.is_empty() {
                out.push(PaneMessage { role: "user", text: m.text.clone(), fresh: false, muted: false, divider: None });
            }
            continue;
        }
        let muted = m.run.as_ref().is_some_and(|r| r.status != "COMPLETED" && !r.status.is_empty());
        let fresh = s.words_revealing(&m.text);
        out.push(PaneMessage { role: "agent", text: m.text.clone(), fresh, muted, divider: None });
    }
    let pending = match &s.turn {
        Turn::Idle => s.pending_answer.as_deref(),
        Turn::Working { progress, .. } if !progress.answer.is_empty() => Some(progress.answer.as_str()),
        _ => None,
    };
    Payload {
        dark,
        reduce_motion: s.prefs.reduce_motion,
        chat_max_px: s.prefs.chat_width.max(),
        messages: out,
        pending_answer: pending,
        loading: None,
    }
}
