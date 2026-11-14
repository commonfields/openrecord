//! macOS WebKit document slot, positioned by Rune's measured layout.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn or_preview_show(html: *const std::ffi::c_char, x: f64, y: f64, w: f64, h: f64);
    fn or_preview_hide();
    fn or_preview_clear();
    fn or_oauth_start(url: *const std::ffi::c_char);
    fn or_oauth_result() -> i32;
    fn or_oauth_cancel();
}
pub fn hide() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_hide();
    }
}
fn escape(text: &str) -> String {
    text.replace('\0', "�")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
pub fn document(content: &str) -> String {
    // The inner policy is inserted first, so a document's own markup cannot
    // weaken it. The outer policy refuses navigation away from local frames.
    let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'\"><meta name=\"referrer\" content=\"no-referrer\">";
    format!(
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src about:; img-src https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'\"><style>html,body,iframe{{margin:0;border:0;width:100%;height:100%;background:white;display:block}}</style><iframe sandbox=\"\" referrerpolicy=\"no-referrer\" srcdoc=\"{}\"></iframe>",
        escape(&format!("<!doctype html>{policy}{content}"))
    )
}
pub fn show(content: &str, rect: [f32; 4]) {
    #[cfg(target_os = "macos")]
    if let Ok(html) = std::ffi::CString::new(document(content)) {
        // SAFETY: called only by Rune's main-thread layout handler; C copies the string.
        unsafe {
            or_preview_show(
                html.as_ptr(),
                rect[0] as f64,
                rect[1] as f64,
                rect[2] as f64,
                rect[3] as f64,
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (content, rect);
}
#[cfg(test)]
mod tests {
    #[test]
    fn hostile_documents_remain_in_a_scriptless_sandbox() {
        let page = super::document(
            "</iframe><script>location='https://bad.test'</script><form action='https://bad.test'></form>",
        );
        assert!(page.contains("sandbox=\"\""));
        assert!(page.contains("srcdoc=\"&lt;!doctype html&gt;"));
        assert!(!page.contains("<script>"));
        assert!(!page.contains("<form"));
        assert!(page.contains("default-src 'none'"));
        assert!(!page.contains("allow-scripts"));
        assert!(!page.contains("allow-same-origin"));
    }
}

pub fn authorize(url: &str) {
    #[cfg(target_os = "macos")]
    if let Ok(url) = std::ffi::CString::new(url) {
        unsafe {
            or_oauth_start(url.as_ptr());
        }
    }
}
pub fn authorization_result() -> i32 {
    #[cfg(target_os = "macos")]
    unsafe {
        return or_oauth_result();
    }
    #[cfg(not(target_os = "macos"))]
    {
        -1
    }
}
pub fn cancel_authorization() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_oauth_cancel();
    }
}

pub fn clear() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_clear();
    }
}
