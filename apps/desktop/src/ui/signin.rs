//! Sign in: the window split in two, a soft burgundy-to-sage picture on the
//! left and the form straight on the canvas on the right.

use rune::{Cursor, El, Pixels, SurfaceFit, col, el, row};
use rune_kit::{Kit, TextInput};

use crate::state::App;
use crate::theme::{Theme, type_};
use crate::ui::widgets::{Variant, button, label};

pub fn view(s: &App, t: &Theme, k: &Kit) -> El {
    let field = |name: &str, input: El| {
        col().w_full().gap(8.0).child(label(name, type_::XS_MEDIUM, t.foreground)).child(input)
    };
    let email = TextInput::new(&s.email)
        .label("Email")
        .placeholder("you@company.com")
        .height(32.0)
        .width(Some(320.0))
        .on_edit(|s: &mut App| &mut s.email)
        .on_submit(|s: &mut App, _| s.submit_signin())
        .build(k)
        .key("email")
        .autofocus();
    let password = TextInput::new(&s.password)
        .label("Password")
        .secure()
        .height(32.0)
        .width(Some(320.0))
        .on_edit(|s: &mut App| &mut s.password)
        .on_submit(|s: &mut App, _| s.submit_signin())
        .build(k)
        .key("password");

    let submit = button(t, "signin", if s.signing_in { "Signing in…" } else { "Sign in" }, Variant::Primary)
        .w_full()
        .default_button()
        .on_press(|s: &mut App| s.submit_signin());
    let demo = row()
        .key("demo")
        .w_full()
        .h(28.0)
        .center()
        .radius(6.0)
        .role("button")
        .label("Fill in the demo account")
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .child(label("Fill in the demo account", type_::XS_MEDIUM, t.muted_foreground))
        .on_press(|s: &mut App| s.fill_demo());

    let mut form = col().w_full().gap(20.0).child(field("Email", email)).child(field("Password", password));
    if let Some(err) = &s.signin_error {
        form = form.child(label(err.clone(), type_::SM_13, t.wrong).key("signin-error").wrap().live_region(rune::LiveRegion::Polite));
    }
    // Which server this signs in to: one quiet line, or the field once the person asks to change it.
    let server = if s.server_open {
        let input = TextInput::new(&s.server)
            .label("Server")
            .placeholder("app.example.com")
            .height(32.0)
            .width(Some(320.0))
            .on_edit(|s: &mut App| &mut s.server)
            .on_submit(|s: &mut App, _| s.submit_signin())
            .build(k)
            .key("server");
        field("Server", input)
    } else {
        let api = crate::state::api_base();
        let host = api.split_once("://").map_or(api.as_str(), |x| x.1).to_string();
        row()
            .key("server-line")
            .w_full()
            .gap(6.0)
            .center_y()
            .child(label(format!("Server: {host}"), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
            .child(
                label("Change", type_::XS_MEDIUM, t.foreground)
                    .key("server-change")
                    .role("button")
                    .label("Change server")
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .on_press(|s: &mut App| s.edit_server()),
            )
    };
    form = form.child(server);
    form = form.child(col().w_full().gap(12.0).child(submit).child(demo));

    // The form sits on the canvas itself, no card around it.
    let panel = col()
        .key("signin-card")
        .w(320.0)
        .gap(28.0)
        .child(
            col()
                .gap(8.0)
                .child(label("Sign in", type_::TITLE, t.foreground).role("heading"))
                .child(label("See what AI assistants say about your business, and fix what they get wrong.", type_::BASE, t.muted_foreground).wrap()),
        )
        .child(form)
        .child(
            row()
                .gap(4.0)
                .child(label("No account yet?", type_::SM_13, t.muted_foreground))
                .child(label("Create one on the web", type_::SM_13.lh(20.0), t.foreground)),
        );

    row()
        .key("signin")
        .w_full()
        .h_full()
        .padding(10.0)
        .gap(10.0)
        .fill(t.background)
        .window_drag()
        .child(backdrop())
        .child(col().key("signin-side").w(0.0).grow(1.0).min_w(0.0).h_full().center().child(panel))
}

/// The left half: the picture, filling a rounded panel inset from the window's edge.
fn backdrop() -> El {
    thread_local! {
        static PICTURE: Pixels = {
            let pixels = Pixels::new();
            if let Ok(img) = image::load_from_memory(include_bytes!("../../assets/signin-backdrop.jpg")) {
                let img = img.into_rgba8();
                pixels.set(img.width(), img.height(), img.into_raw());
            }
            pixels
        };
    }
    let picture = PICTURE.with(|p| p.clone());
    el().key("signin-picture").w(0.0).grow(1.0).min_w(0.0).h_full().radius(14.0).clip_rounded(14.0).pixels_fit(&picture, SurfaceFit::Fill).a11y_hidden()
}

pub fn restoring(t: &Theme) -> El {
    col().key("restoring").w_full().h_full().center().fill(t.sidebar).window_drag().child(label("Opening OpenRecord…", type_::SM_13, t.muted_foreground))
}
