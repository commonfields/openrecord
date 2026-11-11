//! The window's view: sign in, or the workspace shell around the page on screen.

mod agent;
mod answer;
mod charts;
mod discovery;
mod overview;
mod pages;
mod shell;
mod settings;
mod signin;
mod surface;
mod visual;
pub mod widgets;

pub(crate) use shell::web_url;

use rune::{Cursor, Cx, El, ScrollSpec, col, row};
use rune_kit::{Kit, PaletteSeed};

use crate::state::{App, Screen, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::label;

/// The kit's components (text fields, Markdown) on the app's palette.
fn kit(t: &Theme) -> Kit {
    let mut k = Kit::from_palette(PaletteSeed { bg: t.control, fg: t.foreground, accent: t.primary_ink });
    k.c.border_focus = t.ring;
    k
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let t = Theme::get(s.prefs.dark(cx.system_dark()));
    if s.prefs.reduce_motion {
        cx.reduced_motion(true);
    }
    let k = kit(&t);
    let screen = match s.screen {
        Screen::Restoring => signin::restoring(&t),
        Screen::SignIn => signin::view(s, &t, &k),
        Screen::Workspace => workspace(s, &t, &k, cx.titlebar_inset()),
    };
    let mut layers = Vec::new();
    if s.screen == Screen::Workspace {
        if let Some(m) = shell::menus(s, &t) {
            layers.push(m);
        }
        shell::account_menu(s, &t, &k, &mut layers);
        if s.view == View::Agent && (s.active.is_some() || s.general) && s.settings.is_none() {
            agent::layers(s, &t, &k, &mut layers);
        }
        if let Some(n) = &s.new_chat {
            agent::new_chat_dialog(s, &t, &k, n, &mut layers);
        }
        if let Some(page) = s.settings {
            layers.extend(settings::view(s, &t, &k, page));
        }
    }
    // Every hover eases in and out over 150 milliseconds on the web's curve
    // (Tailwind's default `transition`), instead of landing at once.
    let ease = rune::Curve::Tween { duration: 0.15, easing: rune::Easing::cubic(0.4, 0.0, 0.2, 1.0) };
    rune_kit::root(screen.fill(t.sidebar).hover_motion_within(ease, ease), layers)
}

fn workspace(s: &App, t: &Theme, k: &Kit, titlebar_inset: f32) -> El {
    // With the sidebar a narrow rail, the traffic lights sit over the header,
    // so it starts past them.
    let leading = if s.sidebar_open { 0.0 } else { (titlebar_inset - shell::RAIL_WIDTH).max(0.0) };
    let (content, trailing) = match s.view {
        View::Agent if s.active.is_some() || s.general => (agent::view(s, t, k), None),
        View::Agent => (choose_business(t), None),
        View::Workspace => {
            let page = col()
                .key("page-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                // Full width inside the content inset, as the web's workspace pages are.
                .child(col().w_full().px(40.0).pt(32.0).pb(40.0).child(pages::view(s, t)))
                .scroll(ScrollSpec { stick_bottom: false });
            (page, Some(pages::ask_agent(t)))
        }
    };
    let panel = shadows(
        col()
            .key("panel")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .radius(10.0)
            .fill(t.background)
            .clip_rounded(10.0)
            .child(shell::header(s, t, leading, trailing))
            .children(s.notice.as_deref().map(|n| notice(t, n)))
            .child(col().w_full().grow(1.0).min_h(0.0).child(content)),
        &t.panel_shadow,
    );
    row()
        .key("workspace")
        .w_full()
        .h_full()
        .child(shell::sidebar(s, t))
        .child(col().grow(1.0).min_w(0.0).h_full().pt(8.0).pb(8.0).pr(8.0).child(panel))
}

fn choose_business(t: &Theme) -> El {
    col()
        .key("choose-business")
        .w_full()
        .h_full()
        .center()
        .gap(6.0)
        .child(label("No business yet", type_::BASE_MEDIUM, t.foreground))
        .child(label("Set one up on the web with its website and goal, then come back here.", type_::SM_13, t.muted_foreground))
}

/// A bar under the header for a failure the shell hit.
fn notice(t: &Theme, text_: &str) -> El {
    let card = shadows(
        row()
            .key("notice")
            .w_full()
            .px(14.0)
            .py(10.0)
            .gap(10.0)
            .radius(10.0)
            .center_y()
            .fill(t.popover)
            .live_region(rune::LiveRegion::Polite)
            .child(label(text_.to_string(), type_::SM_13, t.foreground).wrap().grow(1.0).min_w(0.0))
            .child(
                label("Dismiss", type_::XS_MEDIUM, t.muted_foreground)
                    .key("notice-dismiss")
                    .role("button")
                    .cursor(Cursor::Pointer)
                    .on_press(|s: &mut App| s.notice = None),
            ),
        &t.float_shadow,
    );
    col().w_full().px(20.0).pb(8.0).child(card)
}
