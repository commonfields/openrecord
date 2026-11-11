//! Sign in: the web app's centred card on the canvas.

use rune::{Cursor, El, col, row};
use rune_kit::{Kit, TextInput};

use crate::state::App;
use crate::theme::{Theme, shadows, type_};
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
    form = form.child(col().w_full().gap(12.0).child(submit).child(demo));

    let card = shadows(
        col()
            .key("signin-card")
            .w(384.0)
            .px(32.0)
            .py(32.0)
            .gap(24.0)
            .radius(16.0)
            .fill(t.card)
            .child(
                col()
                    .gap(6.0)
                    .child(label("Sign in", type_::BASE_MEDIUM, t.foreground).role("heading"))
                    .child(label("See what AI assistants say about your business, and fix what they get wrong.", type_::BASE, t.muted_foreground).wrap()),
            )
            .child(form),
        &t.float_shadow,
    );
    let footer = row()
        .gap(4.0)
        .child(label("No account yet?", type_::SM_13, t.muted_foreground))
        .child(label("Create one on the web", type_::SM_13.lh(20.0), t.foreground));

    col().key("signin").w_full().h_full().center().gap(24.0).fill(t.sidebar).window_drag().child(card).child(footer)
}

pub fn restoring(t: &Theme) -> El {
    col().key("restoring").w_full().h_full().center().fill(t.sidebar).window_drag().child(label("Opening OpenRecord…", type_::SM_13, t.muted_foreground))
}
