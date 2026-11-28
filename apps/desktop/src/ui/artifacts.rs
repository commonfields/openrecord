//! A document beside the conversation: the body of an artifact tab in the
//! right panel. The panel puts the chat box under it.
use super::widgets::{Variant, button, label};
use crate::{
    state::{App, Load},
    theme::{Theme, type_},
};
use crate::page_shot::ShotPhase;
use rune::{El, col, el, row};

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
    // The preview runs to the foot; the chat box floats on it (`side::view`).
    let slot = col()
        .key("artifact-html")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .on_drawn_layout(|s: &mut App, r: [f32; 4]| {
            // Where it rests; the page itself is moved every frame (`ui::follow_drawn`).
            s.preview_rect = Some(r);
        });
    // While the panel moves, a picture of the page stands in for it (`page_shot`):
    // drawn by the app, it travels with the tabs frame for frame. It is always
    // there, invisible at rest: added only for the move, it started where the
    // panel would end rather than where it was. The picture holds its size,
    // centred from the top as the page centres its text, on the page's own colour.
    let shot = s.page_shot.as_ref().filter(|shot| shot.phase != ShotPhase::Asked && shot.artifact == p.id);
    let color = s.front_artifact().and_then(|a| a.loaded.ready()).map(|a| crate::native_preview::page_color(&a.preview_html)).map(|(r, g, b)| crate::theme::hex(&format!("#{r:02x}{g:02x}{b:02x}")));
    // Both sides set: with only one, the picture's aspect ratio sized it, and
    // the slot beside it showed the window.
    let mut cover = el().key("artifact-shot").w_full().h_full().min_h(0.0);
    if let Some(c) = color { cover = cover.fill(c); }
    let cover = match shot {
        Some(shot) => {
            let fading = shot.phase == ShotPhase::Fading;
            cover
                .pixels_fit(&shot.pixels, rune::SurfaceFit::Fill)
                .surface_anchor(rune::Align::Center, rune::Align::Start)
                .surface_unscaled(true)
                .opacity(if fading { 0.0 } else { 1.0 })
                .opacity_motion(if fading { crate::page_shot::FADE } else { rune::Spring::NONE })
        }
        None => cover.opacity(0.0).opacity_motion(rune::Spring::NONE),
    };
    let slot = slot.child(cover);
    pane.child(slot)
}
