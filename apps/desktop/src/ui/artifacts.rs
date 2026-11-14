//! A document beside the conversation, in the normal flex layout.
use super::widgets::{Variant, button, icon_button, label};
use crate::{
    state::{App, Load},
    theme::{Theme, shadows, type_},
};
use rune::{El, ScrollSpec, col, row};

pub fn view(s: &App, t: &Theme) -> El {
    let p = s.artifact.as_ref().expect("artifact pane");
    let a = p.loaded.ready();
    let title = a.map(|a| a.title.as_str()).unwrap_or("Opening artifact");
    let head = row()
        .w_full()
        .h(48.0)
        .px(16.0)
        .gap(8.0)
        .center_y()
        .child(
            label(title.to_string(), type_::SM_MEDIUM, t.foreground)
                .grow(1.0)
                .min_w(0.0)
                .truncate(),
        )
        .child(
            icon_button(
                t,
                "artifact-close",
                &crate::icons::X,
                "Close artifact (Esc)",
                false,
            )
            .on_press(|s: &mut App| s.artifact = None),
        );
    let mut pane = col()
        .key("artifact-pane")
        .w(0.0)
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .radius(10.0)
        .clip_rounded(10.0)
        .fill(t.background)
        .child(head);
    if let Some(a) = a {
        let mut tools = row()
            .w_full()
            .px(12.0)
            .py(8.0)
            .gap(6.0)
            .center_y()
            .flex_wrap()
            .child(
                button(
                    t,
                    "artifact-preview",
                    "Preview",
                    if p.source {
                        Variant::Ghost
                    } else {
                        Variant::Outline
                    },
                )
                .on_press(|s: &mut App| {
                    if let Some(p) = &mut s.artifact {
                        p.source = false;
                    }
                }),
            )
            .child(
                button(
                    t,
                    "artifact-source",
                    "Source",
                    if p.source {
                        Variant::Outline
                    } else {
                        Variant::Ghost
                    },
                )
                .on_press(|s: &mut App| {
                    if let Some(p) = &mut s.artifact {
                        p.source = true;
                    }
                }),
            )
            .child(
                button(t, "artifact-copy", "Copy", Variant::Ghost).on_press_tx(
                    |s: &mut App, tx| {
                        if let Some(a) = s.artifact.as_ref().and_then(|p| p.loaded.ready()) {
                            tx.copy(a.content.clone());
                        }
                    },
                ),
            );
        for v in a.versions.iter().take(8) {
            let version = v.version;
            tools = tools.child(
                button(
                    t,
                    &format!("artifact-v{version}"),
                    &format!("v{version}"),
                    if version == a.shown_version {
                        Variant::Outline
                    } else {
                        Variant::Ghost
                    },
                )
                .on_press(move |s: &mut App| s.artifact_version(Some(version))),
            );
        }
        tools = tools.child(
            button(t, "artifact-latest", "Latest", Variant::Ghost)
                .on_press(|s: &mut App| s.artifact_version(None)),
        );
        pane = pane.child(tools).child(
            label(
                format!(
                    "Version {} · Saved draft · Nothing published",
                    a.shown_version
                ),
                type_::XS,
                t.muted_foreground,
            )
            .px(16.0)
            .pb(10.0),
        );
        let body = if p.source {
            col()
                .w_full()
                .padding(20.0)
                .child(
                    label(a.content.clone(), type_::XS, t.foreground)
                        .wrap()
                        .selectable(true),
                )
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
        } else {
            col()
                .key("artifact-html")
                .w_full()
                .h_full()
                .fill(rune::Color::WHITE)
                .on_drawn_layout(|s: &mut App, r: [f32; 4]| {
                    s.preview_rect = Some(r);
                    if s.preview_visible() {
                        if let Some(a) = s.artifact.as_ref().and_then(|p| p.loaded.ready()) {
                            crate::native_preview::show(&a.preview_html, r);
                        }
                    }
                })
                .child(label("Rendering document", type_::XS, t.muted_foreground).padding(20.0))
        };
        pane = pane.child(body.grow(1.0).min_h(0.0)).child(
            row().w_full().padding(12.0).child(
                button(
                    t,
                    "artifact-change",
                    "Change with the agent",
                    Variant::Outline,
                )
                .on_press(|s: &mut App| {
                    if let Some(a) = s.artifact.as_ref().and_then(|p| p.loaded.ready()) {
                        s.composer
                            .replace_text(&format!("Change the artifact \"{}\": ", a.title));
                    }
                }),
            ),
        );
    } else {
        let text = match &p.loaded {
            Load::Failed(e) => e.as_str(),
            _ => "Reading the saved document…",
        };
        pane = pane
            .child(
                label(text.to_string(), type_::SM, t.muted_foreground)
                    .padding(20.0)
                    .wrap(),
            )
            .child(
                button(t, "artifact-retry", "Try again", Variant::Outline)
                    .on_press(|s: &mut App| s.artifact_version(None)),
            );
    }
    shadows(pane, &t.panel_shadow)
}
