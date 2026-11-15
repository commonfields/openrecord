//! A document beside the conversation: the body of an artifact tab in the
//! right panel. The panel puts the chat box under it.
use super::widgets::{Variant, button, label};
use crate::{
    state::{App, Load},
    theme::{Theme, type_},
};
use rune::{El, col, row};

pub fn view(s: &App, t: &Theme) -> El {
    let Some(p) = s.front_artifact() else { return col() };
    let pane = col().key(format!("artifact-pane-{}", p.id)).w_full().grow(1.0).min_h(0.0);
    if p.loaded.ready().is_none() {
        let text = match &p.loaded {
            Load::Failed(e) => e.as_str(),
            _ => "Reading the saved document…",
        };
        let mut c = pane.child(label(text.to_string(), type_::SM, t.muted_foreground).padding(20.0).wrap());
        if matches!(p.loaded, Load::Failed(_)) {
            c = c.child(row().px(20.0).child(button(t, "artifact-retry", "Try again", Variant::Outline).on_press(|s: &mut App| s.artifact_version(None))));
        }
        return c;
    }
    // The page, then the chat box under it where the main chat has its own.
    let slot = col()
        .key("artifact-html")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .fill(rune::Color::WHITE)
        .on_drawn_layout(|s: &mut App, r: [f32; 4]| {
            s.preview_rect = Some(r);
            if s.preview_visible() {
                if let Some(a) = s.front_artifact().and_then(|p| p.loaded.ready()) {
                    crate::native_preview::show(&a.preview_html, r, !s.prefs.reduce_motion);
                }
            }
        })
        .child(label("Rendering document", type_::XS, t.muted_foreground).padding(20.0));
    pane.child(slot)
}
