//! The composer's microphone: starts macOS dictation in the focused field, as
//! Edit > Start Dictation does. Speech becomes text through the system's input
//! method, which Rune's text fields take like typing.

/// Asks AppKit to start dictation in the first responder. Call on the UI thread
/// after focusing the field that should receive the words.
#[cfg(target_os = "macos")]
pub fn start() {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};
    let Some(cls) = AnyClass::get(c"NSApplication") else { return };
    let action: Sel = sel!(startDictation:);
    let nothing: Option<&AnyObject> = None;
    // SAFETY: plain AppKit messages on the main thread, the documented way a
    // menu item starts dictation; a missing target makes it return false.
    unsafe {
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        if let Some(app) = app.as_ref() {
            let _: Bool = msg_send![app, sendAction: action, to: nothing, from: nothing];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start() {}
