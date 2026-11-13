//! Channels, as the web's `routes/channels.tsx` lays it out: the Accounts and
//! Agent tools tabs; on Accounts a line on what is connected, then "Measure
//! results", "Ads and listings" and "Your website", each a panel of rows (the
//! service's mark, its name and state badge, what it does or what it is
//! connected to, and one action), then the profiles found on the website.
//!
//! Signing in to Google or Meta, and pasting a Stripe or WordPress key, finish
//! on the web: a row's Connect opens that row there.

use rune::{Color, Cursor, El, col, el, row};

use crate::channel_status::{Row, State};
use crate::icons;
use crate::state::{App, Load};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{Variant, badge, button, failure, ico, label, page_header, skeleton};

/// Opens a path of the web app (for the sign-ins only a browser can finish).
fn open_web(path: String) -> impl Fn(&mut App, &mut rune::Tx) + 'static {
    move |_s: &mut App, tx: &mut rune::Tx| {
        let api = crate::state::api_base();
        let _ = tx.open_url(&format!("{}{path}", crate::ui::web_url(&api)));
    }
}

/// A service's mark on the web's small tile: muted fill with the control shadow.
fn mark(t: &Theme, key: &str, size: f32) -> El {
    let inner = match crate::channel_marks::for_channel(key) {
        Some(i) => rune::icon(i, size * 0.56).color(t.foreground),
        None if key == "profile:EMAIL" => ico(&icons::MAIL, size * 0.5, t.muted_foreground),
        None => ico(&icons::GLOBE, size * 0.5, t.muted_foreground),
    };
    shadows(row().size(size, size).radius(8.0).center().fill(t.accent.alpha(0.7)).child(inner), &t.control_shadow)
}

/// The state's badge (`STATE_BADGE`); none for a row that is simply available.
fn state_badge(t: &Theme, st: State) -> Option<El> {
    let (name, ink, soft) = match st {
        State::Connected => ("Connected", t.supported, t.supported_soft),
        State::Choose => ("Finish setup", t.partial, t.partial_soft),
        State::Reconnect => ("Reconnect", t.wrong, t.wrong_soft),
        State::Unavailable => ("Not available yet", t.foreground, t.background),
        State::Available => return None,
    };
    Some(badge(t, name, ink, soft, None))
}

pub fn view(s: &App, t: &Theme) -> El {
    let name = s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "this business".into());
    let business = s.active.clone().unwrap_or_default();
    let header = page_header(t, "Channels", &format!("The accounts your agent uses for {name}. It reads results from them, and changes nothing until you approve it."));
    let tabs = crate::ui::discovery::tabs(
        t,
        "channel-tabs",
        vec![("Accounts".into(), !s.channel_tools, Box::new(|s: &mut App| s.channel_tools = false)), ("Agent tools".into(), s.channel_tools, Box::new(|s: &mut App| s.channel_tools = true))],
    );
    let body = if s.channel_tools { tools(t, &business) } else { accounts(s, t, &business) };
    col().w_full().gap(20.0).child(header).child(row().child(tabs)).child(body)
}

fn accounts(s: &App, t: &Theme, business: &str) -> El {
    let status = match &s.channel_status {
        Load::Ready(st) => st,
        Load::Failed(e) => return failure(t, "channels-failed", e, |s: &mut App| s.refresh()),
        _ => return col().w_full().gap(20.0).child(label("Checking your accounts.", type_::XS, t.muted_foreground)).child(skeleton(t, 3)),
    };
    let states: Vec<State> = status.rows().filter_map(|r| r.state).collect();
    let incomplete = status.rows().any(|r| r.state.is_none());
    let connected = states.iter().filter(|s| **s == State::Connected).count();
    let summary = if incomplete {
        "Some account statuses could not load.".to_string()
    } else if connected > 0 {
        format!("{connected} {} connected.", if connected == 1 { "account" } else { "accounts" })
    } else if !states.is_empty() && states.iter().all(|s| *s == State::Unavailable) {
        "None of these can be connected on this OpenRecord workspace yet. Open Why? on a row to see what is missing.".to_string()
    } else {
        "No accounts connected yet. Start with the one that counts your goal, usually Search Console or Stripe.".to_string()
    };
    let mut c = col().w_full().gap(20.0).child(label(summary, type_::XS, t.muted_foreground).wrap());
    for (title, sub, rows) in [
        ("Measure results", "So the agent can tell what is working, from real numbers.", &status.measure),
        ("Ads and listings", "The agent reads results and can prepare changes for you to approve.", &status.ads),
        ("Your website", "The agent drafts page changes and posts; each one waits for your approval.", &status.website),
    ] {
        if rows.is_empty() {
            continue;
        }
        let mut list = col().w_full();
        for r in rows {
            list = list.child(channel_row(s, t, business, r));
        }
        c = c.child(
            shadows(col().key(format!("channel-group-{title}")).w_full().radius(12.0).fill(t.card).clip_rounded(12.0), &t.card_shadow)
                .child(
                    col()
                        .w_full()
                        .px(16.0)
                        .py(12.0)
                        .gap(2.0)
                        .child(label(title, type_::SM_MEDIUM, t.foreground).role("heading"))
                        .child(label(sub, type_::XS, t.muted_foreground)),
                )
                .child(list),
        );
    }
    // Profiles the homepage links to, as chips.
    let profiles: Vec<&crate::api::Channel> = s.channels.ready().map(|l| l.iter().filter(|c| c.key.starts_with("profile:")).collect()).unwrap_or_default();
    if !profiles.is_empty() {
        let mut chips = row().w_full().gap(8.0).flex_wrap();
        for p in profiles {
            let mut chip = shadows(
                row().key(format!("profile-{}", p.key)).h(26.0).px(10.0).gap(6.0).radius(13.0).center_y().fill(t.accent.alpha(0.7)).hover(t.accent).child(mark_bare(t, &p.key)).child(label(p.label.clone(), type_::XS, t.foreground)),
                &t.control_shadow,
            );
            if let Some(url) = p.identity.clone().filter(|i| i.starts_with("http")) {
                chip = chip.role("link").cursor(Cursor::Pointer).help(url.clone()).on_press_tx(move |_s: &mut App, tx| {
                    let _ = tx.open_url(&url);
                });
            }
            chips = chips.child(chip);
        }
        c = c.child(
            shadows(col().w_full().px(16.0).py(16.0).gap(12.0).radius(12.0).fill(t.card), &t.card_shadow)
                .child(col().gap(2.0).child(label("Found on your website", type_::SM_MEDIUM, t.foreground).role("heading")).child(label("Profiles your homepage links to. The agent reads them in research but cannot post there.", type_::XS, t.muted_foreground)))
                .child(chips),
        );
    }
    c
}

fn mark_bare(t: &Theme, key: &str) -> El {
    match crate::channel_marks::for_channel(key) {
        Some(i) => rune::icon(i, 14.0).color(t.foreground),
        None => ico(&icons::GLOBE, 14.0, t.muted_foreground),
    }
}

/// One account (`ChannelRow`): mark, name and badge, purpose or what it is
/// connected to, and the action its state calls for; open, what to finish.
fn channel_row(s: &App, t: &Theme, business: &str, r: &Row) -> El {
    let key = r.key.to_string();
    let open = s.channel_open.as_deref() == Some(r.key);
    let Some(state) = r.state else {
        let text = format!("{} status could not load.", r.title);
        return row()
            .key(format!("channel-row-{key}"))
            .w_full()
            .px(16.0)
            .py(12.0)
            .gap(12.0)
            .center_y()
            .child(label(text, type_::XS, t.wrong).grow(1.0).min_w(0.0))
            .child(button(t, &format!("channel-retry-{key}"), "Try again", Variant::Outline).on_press(|s: &mut App| s.refresh()));
    };
    let toggle = {
        let key = key.clone();
        move |s: &mut App| s.channel_open = if s.channel_open.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) }
    };
    let web_row = format!("/businesses/{business}/channels#{key}");
    let (text_, variant, opens_web) = match state {
        State::Connected => (if open { "Done" } else { "Manage" }, Variant::Outline, false),
        State::Choose => (if open { "Close" } else { "Finish setup" }, Variant::Primary, false),
        State::Reconnect => ("Reconnect", Variant::Primary, true),
        State::Available => ("Connect", Variant::Primary, true),
        State::Unavailable => (if open { "Close" } else { "Why?" }, Variant::Ghost, false),
    };
    let mut action = button(t, &format!("channel-act-{key}"), text_, variant).min_w(96.0);
    action = if opens_web { action.on_press_tx(open_web(web_row.clone())) } else { action.on_press(toggle) };
    let sub = if state == State::Connected { r.identity.clone().unwrap_or_else(|| r.purpose.to_string()) } else { r.purpose.to_string() };
    let head = row()
        .w_full()
        .px(16.0)
        .py(12.0)
        .gap(12.0)
        .center_y()
        .child(mark(t, r.mark, 32.0))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(row().gap(8.0).center_y().child(label(r.title, type_::SM_MEDIUM, t.foreground)).children(state_badge(t, state)))
                .child(label(sub, type_::XS, t.muted_foreground).truncate()),
        )
        .child(action);
    let mut c = col().key(format!("channel-row-{key}")).w_full().child(head);
    if open {
        let needs = match r.key {
            "google" | "google_business" => "Google sign-in",
            "meta" => "Meta sign-in",
            "google_ads" => "Google Ads access",
            _ => "Secure key storage",
        };
        let body = if state == State::Unavailable {
            label(
                format!("{needs} is not switched on for this OpenRecord workspace yet, so this account cannot be connected. Whoever runs your OpenRecord can turn it on. Once it is on, you connect your own account here."),
                type_::XS,
                t.muted_foreground,
            )
            .wrap()
        } else {
            let what = match state {
                State::Connected => format!("Connected{}. Choose a different site or account, or disconnect it, on the web.", r.identity.as_ref().map(|i| format!(" to {i}")).unwrap_or_default()),
                _ => "Pick the site or account this business uses. The choice is made on the web, where the sign-in lives.".to_string(),
            };
            row()
                .w_full()
                .gap(12.0)
                .center_y()
                .child(label(what, type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(0.0))
                .child(button(t, &format!("channel-web-{key}"), if state == State::Connected { "Manage on the web" } else { "Finish on the web" }, Variant::Outline).on_press_tx(open_web(web_row)))
        };
        c = c.child(col().w_full().pl(60.0).pr(16.0).py(12.0).fill(t.accent.alpha(0.3)).child(body));
    }
    c
}

/// Agent tools: optional setups, each a card that opens its task.
fn tools(t: &Theme, business: &str) -> El {
    let setup = |id: &str, title: &str, description: &str| {
        let path = format!("/businesses/{business}/channels#{id}");
        row()
            .key(format!("tool-{id}"))
            .w_full()
            .px(16.0)
            .py(16.0)
            .gap(12.0)
            .radius(12.0)
            .center_y()
            .fill(t.card)
            .border(1.0, t.border)
            .child(col().grow(1.0).min_w(0.0).gap(4.0).child(label(title.to_string(), type_::SM_MEDIUM, t.foreground)).child(label(description.to_string(), type_::XS, t.muted_foreground).wrap()))
            .child(button(t, &format!("tool-open-{id}"), "Set up", Variant::Outline).on_press_tx(open_web(path)))
    };
    col()
        .w_full()
        .gap(12.0)
        .child(
            col()
                .py(8.0)
                .gap(4.0)
                .child(label("What would you like to set up?", type_::BASE_MEDIUM, t.foreground).role("heading"))
                .child(label("These are optional. Start with the accounts tab to measure your results. Open a task below only when you need it.", type_::SM, t.muted_foreground).wrap()),
        )
        .child(setup("research-connections", "Give the agent more research sources", "Add an account you already use for market or competitor research."))
        .child(setup("ai-answer-tracking", "Check AI answers on a schedule", "Choose your buyer questions and how often to check them. Uses your connected AI subscriptions."))
        .child(setup("ai-traffic", "See visits from AI assistants", "Import a website log to count AI referrals and crawler visits. Ask your website manager for the log."))
        .child(setup("plugins", "Choose guidance for your business", "Turn on specialist marketing guidance. This does not connect accounts or grant permission to act."))
        .child(setup("agent-access", "Advanced connections for your technical team", "You do not need these to use OpenRecord. Keep credentials private and review each connection's access."))
        .child(el().h(0.0).fill(Color::TRANSPARENT))
}
