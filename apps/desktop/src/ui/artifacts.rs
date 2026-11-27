//! A document beside the conversation: the body of an artifact tab in the
//! right panel. The panel puts the chat box under it.
use super::widgets::{Variant, button, label};
use crate::{
    state::{App, Load},
    theme::{Theme, type_},
};
use crate::page_shot::ShotPhase;
use rune::{El, Transition, col, el, row};

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
    // drawn by the app, it travels with the tabs frame for frame. It sits at the
    // size the page had, from the top left, on the page's own colour.
    let slot = match s.page_shot.as_ref().filter(|shot| shot.phase != ShotPhase::Asked && shot.artifact == p.id) {
        Some(shot) => {
            let fading = shot.phase == ShotPhase::Fading;
            slot.child(
                col()
                    .key("artifact-shot")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(shot.color)
                    .clip_rounded(0.0)
                    .transition(Transition::none())
                    .opacity(if fading { 0.0 } else { 1.0 })
                    // The panel's spring while it moves, so it keeps to its slot; then the fade.
                    .motion(if fading { crate::page_shot::FADE } else { crate::state::SIDEBAR_SPRING })
                    .child(el().w(shot.size[0]).h(shot.size[1]).min_w(shot.size[0]).min_h(shot.size[1]).pixels(&shot.pixels)),
            )
        }
        None => slot,
    };
    pane.child(slot)
}
