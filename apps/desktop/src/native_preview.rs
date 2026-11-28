//! macOS WebKit document slot, positioned by Rune's measured layout.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn or_preview_show(html: *const std::ffi::c_char, x: f64, y: f64, w: f64, h: f64, motion: i32);
    fn or_preview_hide();
    fn or_preview_clear();
    fn or_preview_keep(rects: *const f64, count: i32);
    fn or_preview_pass_through(on: i32);
    fn or_preview_page_light() -> i32;
    fn or_preview_place(x: f64, y: f64, w: f64, h: f64);
    fn or_preview_conceal(on: i32);
    fn or_preview_painted() -> i32;
    fn or_preview_snapshot(width: f64) -> i32;
    fn or_preview_snapshot_state(data: *mut *const u8, w: *mut i32, h: *mut i32, pw: *mut f64, ph: *mut f64) -> i32;
    fn or_preview_snapshot_done();
    fn or_preview_backdrop(r: f64, g: f64, b: f64);
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

/// Whether clicks over the artifact preview reach it (not while a menu is open).
pub fn preview_pass_through(on: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_pass_through(on as i32);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = on;
}

/// Places the app draws over the artifact preview (the floating chat box).
pub fn preview_keep(rects: &[[f32; 4]]) {
    #[cfg(target_os = "macos")]
    {
        let flat: Vec<f64> = rects.iter().take(4).flat_map(|r| r.iter().map(|v| *v as f64)).collect();
        unsafe { or_preview_keep(flat.as_ptr(), (flat.len() / 4) as i32) }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = rects;
}

/// Whether the artifact preview is light where the chat box floats; None until known.
pub fn preview_page_light() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        match unsafe { or_preview_page_light() } {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    None
}
fn escape(text: &str) -> String {
    text.replace('\0', "�")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
/// The background a document declares for its page (`body` or `html`), as
/// red, green and blue; white when it sets none we can read. The panel's tab
/// strip takes this colour so the strip and the page read as one surface, and
/// the frame holding the page uses it, so nothing flashes while it loads.
pub fn page_color(content: &str) -> (u8, u8, u8) {
    let lower = content.to_ascii_lowercase();
    for selector in ["body", "html"] {
        let mut from = 0;
        while let Some(i) = lower[from..].find(selector) {
            let at = from + i;
            from = at + selector.len();
            // A rule for the element itself: `body{` or `body {`, not `.body-copy{`.
            let before = lower[..at].chars().last().unwrap_or('}');
            let rest = lower[from..].trim_start();
            if !(before == '}' || before == '>' || before.is_whitespace() || before == ',') || !rest.starts_with(['{', ',']) {
                continue;
            }
            let Some(open) = lower[from..].find('{') else { break };
            let Some(close) = lower[from + open..].find('}') else { break };
            let block = &lower[from + open + 1..from + open + close];
            for prop in ["background-color:", "background:"] {
                if let Some(c) = block.find(prop).and_then(|p| parse_color(block[p + prop.len()..].trim_start())) {
                    return c;
                }
            }
        }
    }
    (255, 255, 255)
}

fn parse_color(v: &str) -> Option<(u8, u8, u8)> {
    if let Some(h) = v.strip_prefix('#') {
        let hex: String = h.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        let n = |s: &str| u8::from_str_radix(s, 16).ok();
        return match hex.len() {
            3 | 4 => { let d: Vec<String> = hex.chars().take(3).map(|c| format!("{c}{c}")).collect(); Some((n(&d[0])?, n(&d[1])?, n(&d[2])?)) }
            6 | 8 => Some((n(&hex[0..2])?, n(&hex[2..4])?, n(&hex[4..6])?)),
            _ => None,
        };
    }
    if let Some(body) = v.strip_prefix("rgb(").or_else(|| v.strip_prefix("rgba(")) {
        let parts: Vec<u8> = body.split([',', ' ', ')']).filter(|p| !p.is_empty()).take(3).filter_map(|p| p.parse::<f32>().ok()).map(|f| f.clamp(0.0, 255.0) as u8).collect();
        return (parts.len() == 3).then(|| (parts[0], parts[1], parts[2]));
    }
    if v.starts_with("white") { return Some((255, 255, 255)); }
    if v.starts_with("black") { return Some((0, 0, 0)); }
    None
}

pub fn document(content: &str) -> String {
    let bg = page_color(content);
    // The inner policy is inserted first, so a document's own markup cannot
    // weaken it. The outer policy refuses navigation away from local frames.
    let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'\"><meta name=\"referrer\" content=\"no-referrer\">";
    format!(
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src about:; img-src https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'\"><style>html,body,iframe{{margin:0;border:0;width:100%;height:100%;background:#{:02x}{:02x}{:02x};display:block}}</style><iframe sandbox=\"\" referrerpolicy=\"no-referrer\" srcdoc=\"{}\"></iframe>",
        bg.0, bg.1, bg.2,
        escape(&format!("<!doctype html>{policy}{content}"))
    )
}
/// Shows the document at `rect`; with `motion` it fades up once it has painted.
/// Moves the artifact page to `rect` without loading anything: where the app
/// drew its slot this frame, so the page rides the panel's springs with it.
pub fn place(rect: [f32; 4]) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_place(rect[0] as f64, rect[1] as f64, rect[2] as f64, rect[3] as f64);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = rect;
}

/// Hides the artifact page while the app draws its picture in its place, or shows it again.
pub fn conceal(on: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_conceal(i32::from(on));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = on;
}

/// Whether the artifact page has painted its document.
pub fn painted() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_painted() != 0
    }
    #[cfg(not(target_os = "macos"))]
    false
}

/// Starts a picture of the artifact page as it shows now, only its middle
/// `width` points when given; false when there is no page to take.
pub fn snapshot(width: Option<f32>) -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        or_preview_snapshot(width.map_or(0.0, f64::from)) != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = width;
        false
    }
}

/// A picture of the page: RGBA rows top first, its size in pixels and in points.
pub struct Shot {
    pub rgba: Vec<u8>,
    pub px: [u32; 2],
    pub size: [f32; 2],
}

/// The picture `snapshot` asked for: `Ok(Some)` once it is ready (taken, so a
/// second call has none), `Ok(None)` while it is on its way, `Err` when there is none.
pub fn snapshot_take() -> Result<Option<Shot>, ()> {
    #[cfg(target_os = "macos")]
    unsafe {
        let (mut data, mut w, mut h, mut pw, mut ph) = (std::ptr::null(), 0, 0, 0.0, 0.0);
        match or_preview_snapshot_state(&mut data, &mut w, &mut h, &mut pw, &mut ph) {
            1 => Ok(None),
            2 if !data.is_null() && w > 0 && h > 0 => {
                // SAFETY: C keeps `w * h * 4` bytes at `data` until `or_preview_snapshot_done`.
                let rgba = std::slice::from_raw_parts(data, w as usize * h as usize * 4).to_vec();
                or_preview_snapshot_done();
                Ok(Some(Shot { rgba, px: [w as u32, h as u32], size: [pw as f32, ph as f32] }))
            }
            _ => {
                or_preview_snapshot_done();
                Err(())
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err(())
}

pub fn show(content: &str, rect: [f32; 4], motion: bool) {
    #[cfg(target_os = "macos")]
    if let Ok(html) = std::ffi::CString::new(document(content)) {
        let (r, g, b) = page_color(content);
        // SAFETY: called only by Rune's main-thread layout handler; C copies the string.
        unsafe {
            or_preview_backdrop(f64::from(r) / 255.0, f64::from(g) / 255.0, f64::from(b) / 255.0);
            or_preview_show(
                html.as_ptr(),
                rect[0] as f64,
                rect[1] as f64,
                rect[2] as f64,
                rect[3] as f64,
                motion as i32,
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (content, rect, motion);
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

    #[test]
    fn the_page_colour_comes_from_its_own_body_or_html_rule() {
        use super::page_color;
        assert_eq!(page_color("<style>body{margin:0;background:#f3f1ec;color:#333}</style>"), (0xf3, 0xf1, 0xec));
        assert_eq!(page_color("<style>html { background-color: #111 }</style>"), (0x11, 0x11, 0x11));
        assert_eq!(page_color("<style>.body-copy{background:#000} body{background:rgb(10, 20, 30)}</style>"), (10, 20, 30));
        assert_eq!(page_color("<p>No styles at all</p>"), (255, 255, 255));
        assert!(super::document("<style>body{background:#0b1020}</style>").contains("background:#0b1020"));
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

// ---- The side panel's browser ------------------------------------------------

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn or_browser_show(url: *const std::ffi::c_char, x: f64, y: f64, w: f64, h: f64);
    fn or_browser_hide();
    fn or_browser_close();
    fn or_browser_command(command: i32);
    fn or_browser_url() -> *const std::ffi::c_char;
    fn or_browser_state() -> i32;
    fn or_browser_keep(rects: *const f64, count: i32);
    fn or_window_background(r: f64, g: f64, b: f64);
    fn or_browser_pass_through(on: i32);
    fn or_browser_drop(id: i32);
    fn or_browser_take_click() -> i32;
    fn or_browser_select(id: i32);
    fn or_browser_zoom(zoom: f64);
    fn or_browser_page_light() -> i32;
    fn or_browser_backdrop(r: f64, g: f64, b: f64);
}

/// Whether the page was clicked since the last ask.
pub fn browser_take_click() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: main thread only.
        unsafe { or_browser_take_click() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

/// Forgets one browser tab's page.
pub fn browser_drop(id: u32) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_drop(id as i32)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

/// Brings a browser tab's page to the front.
pub fn browser_select(id: u32) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_select(id as i32)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

/// The page's own zoom, apart from the app's.
pub fn browser_zoom(zoom: f32) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_zoom(zoom as f64)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = zoom;
}

/// Whether the page in front is light where the chat box floats; None until known.
pub fn browser_page_light() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: main thread only.
        match unsafe { or_browser_page_light() } {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// Whether clicks over the browser's page reach it (not while a menu is open).
pub fn browser_pass_through(on: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_pass_through(on as i32)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = on;
}

/// The panel's colour, behind the page's rounded corners.
pub fn browser_backdrop(c: rune::Color) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_backdrop(rune::color::srgb_encode(c.r) as f64, rune::color::srgb_encode(c.g) as f64, rune::color::srgb_encode(c.b) as f64)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = c;
}

/// The places the app draws over the browser's page, which keep their clicks
/// (the floating chat box); window points.
pub fn browser_keep(rects: &[[f32; 4]]) {
    #[cfg(target_os = "macos")]
    {
        let flat: Vec<f64> = rects.iter().take(4).flat_map(|r| r.iter().map(|v| *v as f64)).collect();
        // SAFETY: main thread only; C copies the rects before returning.
        unsafe { or_browser_keep(flat.as_ptr(), (flat.len() / 4) as i32) }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = rects;
}

/// The window's own colour, shown wherever the app leaves its view clear.
pub fn window_background(c: rune::Color) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_window_background(rune::color::srgb_encode(c.r) as f64, rune::color::srgb_encode(c.g) as f64, rune::color::srgb_encode(c.b) as f64)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = c;
}

/// A step for the browser: back, forward, reload or stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserCommand {
    Back = 1,
    Forward = 2,
    Reload = 3,
    Stop = 4,
}

/// Places the side panel's browser at `rect` and loads `url` when it shows something else.
pub fn browser_show(url: Option<&str>, rect: [f32; 4]) {
    #[cfg(target_os = "macos")]
    {
        let url = url.and_then(|u| std::ffi::CString::new(u).ok());
        // SAFETY: main thread only; C copies the string before returning.
        unsafe { or_browser_show(url.as_ref().map_or(std::ptr::null(), |u| u.as_ptr()), rect[0] as f64, rect[1] as f64, rect[2] as f64, rect[3] as f64) }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (url, rect);
}

pub fn browser_hide() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_hide()
    }
}

pub fn browser_close() {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_close()
    }
}

pub fn browser_command(c: BrowserCommand) {
    #[cfg(target_os = "macos")]
    unsafe {
        or_browser_command(c as i32)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = c;
}

/// The address the browser shows now, if it has loaded one.
pub fn browser_url() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: a static NUL-terminated buffer, read on the main thread.
        let s = unsafe { std::ffi::CStr::from_ptr(or_browser_url()) }.to_string_lossy().into_owned();
        return (!s.is_empty()).then_some(s);
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// Whether it can go back, forward, and whether a page is loading.
pub fn browser_state() -> (bool, bool, bool) {
    #[cfg(target_os = "macos")]
    {
        let v = unsafe { or_browser_state() };
        return (v & 1 != 0, v & 2 != 0, v & 4 != 0);
    }
    #[cfg(not(target_os = "macos"))]
    (false, false, false)
}

/// What the address bar's text means: a web address as typed, a bare host
/// given https, or else a web search.
pub fn browser_target(input: &str) -> Option<String> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(s.to_string());
    }
    let host_like = !s.contains(' ') && (s.contains('.') || s.starts_with("localhost")) ;
    if host_like {
        let local = s.starts_with("localhost") || s.starts_with("127.0.0.1");
        return Some(format!("{}://{s}", if local { "http" } else { "https" }));
    }
    let q: String = s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        b' ' => "+".into(),
        _ => format!("%{b:02X}"),
    }).collect();
    Some(format!("https://duckduckgo.com/?q={q}"))
}

#[cfg(test)]
mod browser_tests {
    use super::browser_target;

    #[test]
    fn the_address_bar_reads_addresses_hosts_and_searches() {
        assert_eq!(browser_target("https://example.com/a").as_deref(), Some("https://example.com/a"));
        assert_eq!(browser_target("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(browser_target("localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(browser_target("ai answers & seo").as_deref(), Some("https://duckduckgo.com/?q=ai+answers+%26+seo"));
        assert_eq!(browser_target("  "), None);
        // Other schemes are searched for, never opened.
        assert!(browser_target("file:///etc/passwd").unwrap().starts_with("https://duckduckgo.com/"));
    }
}

