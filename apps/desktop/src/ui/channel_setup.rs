//! Channel setup expands in the page. No web application links or drawers.
use super::widgets::{Variant, button, label};
use crate::{
    channel_setup::{Action, Kind},
    state::{App, Load},
    theme::{Theme, type_},
};
use rune::{El, col, row};
use rune_kit::TextInput;

pub fn view(s: &App, t: &Theme) -> El {
    let p = s.channel_setup.as_ref().expect("channel setup");
    let mut body = col()
        .key("channel-setup")
        .w_full()
        .padding(20.0)
        .gap(12.0)
        .fill(t.accent.alpha(0.25));
    let mut actions = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(
            label(
                match p.kind {
                    Kind::WordPress => "WordPress",
                    Kind::Stripe => "Stripe",
                    Kind::Google => "Google Search Console",
                    Kind::GoogleAds => "Google Ads",
                    Kind::GoogleBusiness => "Google Business Profile",
                    Kind::Meta => "Meta Ads",
                },
                type_::SM_MEDIUM,
                t.foreground,
            )
            .grow(1.0),
        )
        .child(
            button(t, "channel-setup-close", "Back to channels", Variant::Ghost)
                .on_press(|s: &mut App| s.close_channel()),
        );
    if !p.busy {
        actions = actions.child(
            button(t, "channel-setup-reload", "Check again", Variant::Outline)
                .on_press(|s: &mut App| s.reload_channel()),
        );
    }
    body = body.child(actions);
    if let Some(e) = &p.error {
        body = body.child(label(e.clone(), type_::XS, t.wrong).wrap().role("alert"));
    }
    if p.authorizing {
        return body.child(
            label(
                "Finish signing in in the authorization sheet. Account selection continues here.",
                type_::SM,
                t.foreground,
            )
            .wrap(),
        );
    }
    if p.busy {
        return body.child(label("Saving connection…", type_::SM, t.foreground));
    }
    let detail = match &p.loaded {
        Load::Ready(d) => d,
        Load::Failed(e) => return body.child(label(e.clone(), type_::XS, t.wrong).wrap()),
        _ => {
            return body.child(label(
                "Loading connection settings…",
                type_::XS,
                t.muted_foreground,
            ));
        }
    };
    if !detail.configured {
        return body.child(label("This connection is not enabled on the server yet. Ask your workspace administrator to enable it, then check again.", type_::SM, t.muted_foreground).wrap());
    }
    if let Some(w) = &detail.warning {
        body = body.child(label(w.clone(), type_::XS, t.partial).wrap());
    }
    if p.kind.keyed() {
        if detail.connected {
            body = body.child(label("Connected. Replacing the credentials changes the account used by this business.", type_::XS, t.muted_foreground).wrap());
        }
        let k = super::kit(t);
        if p.kind == Kind::WordPress {
            body = body.child(label("WordPress website", type_::XS_MEDIUM, t.foreground))
                .child(TextInput::new(&p.site).label("WordPress website").placeholder("https://your-site.com").on_edit(|s: &mut App| &mut s.channel_setup.as_mut().unwrap().site).build(&k).w_full())
                .child(label("WordPress username", type_::XS_MEDIUM, t.foreground))
                .child(TextInput::new(&p.username).label("WordPress username").on_edit(|s: &mut App| &mut s.channel_setup.as_mut().unwrap().username).build(&k).w_full())
                .child(label("Create an application password in your WordPress user profile. Use a user allowed to publish pages and posts.", type_::XS, t.muted_foreground).wrap());
        } else {
            body = body.child(label("Use a Stripe restricted key with read-only access to Charges. Full secret keys are refused.", type_::XS, t.muted_foreground).wrap());
        }
        let name = if p.kind == Kind::WordPress {
            "Application password"
        } else {
            "Restricted key"
        };
        body = body
            .child(label(name, type_::XS_MEDIUM, t.foreground))
            .child(
                TextInput::new(&p.secret)
                    .label(name)
                    .secure()
                    .on_edit(|s: &mut App| &mut s.channel_setup.as_mut().unwrap().secret)
                    .build(&k)
                    .w_full(),
            );
        let valid = !p.secret.text.trim().is_empty()
            && (p.kind != Kind::WordPress
                || (!p.site.text.trim().is_empty() && !p.username.text.trim().is_empty()));
        body = body.child(
            row().child(
                button(
                    t,
                    "channel-setup-save",
                    if detail.connected {
                        "Replace connection"
                    } else {
                        "Connect"
                    },
                    Variant::Primary,
                )
                .disabled(!valid)
                .on_press(|s: &mut App| s.save_channel()),
            ),
        );
        if detail.connected {
            if p.confirming_disconnect {
                body = body.child(label("Disconnect this account? The agent will lose access for this business.", type_::XS, t.wrong).wrap())
                    .child(row().gap(8.0).child(button(t, "channel-disconnect-confirm", "Disconnect", Variant::Outline).on_press(|s: &mut App| s.channel_action(Action::Disconnect)))
                        .child(button(t, "channel-disconnect-cancel", "Keep connected", Variant::Ghost).on_press(|s: &mut App| { if let Some(p) = &mut s.channel_setup { p.confirming_disconnect = false; } })));
            } else {
                body = body.child(row().child(
                    button(t, "channel-disconnect", "Disconnect", Variant::Ghost).on_press(
                        |s: &mut App| {
                            if let Some(p) = &mut s.channel_setup {
                                p.confirming_disconnect = true;
                            }
                        },
                    ),
                ));
            }
        }
    } else {
        for (i, choice) in detail.choices.iter().enumerate() {
            let c = choice.clone();
            body = body.child(
                row()
                    .w_full()
                    .gap(12.0)
                    .center_y()
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .child(label(choice.title.clone(), type_::SM, t.foreground).wrap())
                            .child(label(
                                if choice.bound {
                                    "Currently used by this business"
                                } else {
                                    "Available through your connection"
                                },
                                type_::XS,
                                t.muted_foreground,
                            )),
                    )
                    .child(
                        button(
                            t,
                            &format!("channel-choice-{i}"),
                            if choice.bound {
                                "Stop reading"
                            } else {
                                "Use this account"
                            },
                            Variant::Outline,
                        )
                        .on_press(move |s: &mut App| {
                            s.channel_action(if c.bound {
                                Action::Unbind(c.clone())
                            } else {
                                Action::Bind(c.clone())
                            })
                        }),
                    ),
            );
        }
        if detail.choices.is_empty() {
            body = body.child(
                label(
                    "No available accounts are connected yet. Sign in to choose one.",
                    type_::XS,
                    t.muted_foreground,
                )
                .wrap(),
            );
        }
        body = body.child(row().child(button(t, "channel-authorize", "Sign in with provider", Variant::Primary).on_press(|s: &mut App| s.channel_action(Action::Authorize))))
            .child(label("A secure system authorization sheet handles the provider sign-in. OpenRecord stays open; finish choosing the site or account here.", type_::XS, t.muted_foreground).wrap());
    }
    body
}
