//! Channels: the accounts the agent works through, as one page that answers
//! three questions in order. What can the agent do for this business right
//! now (a line per job: measure, advertise, publish)? What needs a person
//! (an expired sign-in, a setup left half done)? What else could be connected,
//! and what would it add? Accounts that this workspace cannot connect yet sit
//! at the end, with one explanation instead of a "Why?" on every row.
//!
//! Signing in to Google or Meta, and pasting a Stripe or WordPress key, happen
//! in the browser: every action here opens that account's row there, and
//! "Check again" reads the result back.

use rune::{Cursor, El, col, el, row};

use crate::channel_status::{Row, State};
use crate::icons;
use crate::state::{App, Load};
use crate::theme::{Theme, shadows, type_};
use crate::ui::kit;
use crate::ui::widgets::{Variant, button, failure, ico, label, page_header, skeleton};

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

/// "Google Search Console and Stripe".
fn names(rows: &[&Row]) -> String {
    let t: Vec<&str> = rows.iter().map(|r| r.title).collect();
    match t.len() {
        0 => String::new(),
        1 => t[0].to_string(),
        n => format!("{} and {}", t[..n - 1].join(", "), t[n - 1]),
    }
}

/// One job the agent does through accounts: how much of it is connected, in a sentence.
fn job(t: &Theme, key: &str, title: &str, can: &str, cannot: &str, rows: &[Row]) -> El {
    let on: Vec<&Row> = rows.iter().filter(|r| r.state == Some(State::Connected)).collect();
    let broken: Vec<&Row> = rows.iter().filter(|r| matches!(r.state, Some(State::Reconnect | State::Choose))).collect();
    let open: Vec<&Row> = rows.iter().filter(|r| r.state == Some(State::Available)).collect();
    let possible = rows.iter().filter(|r| r.state != Some(State::Unavailable)).count();
    let (tone, headline) = if !broken.is_empty() {
        (t.partial, format!("{} needs you", names(&broken)))
    } else if !on.is_empty() && open.is_empty() {
        (t.supported, format!("{can} through {}", names(&on)))
    } else if !on.is_empty() {
        (t.supported, format!("{can} through {}", names(&on)))
    } else if possible == 0 {
        (t.muted_foreground, "Not switched on for this workspace".to_string())
    } else {
        (t.muted_foreground, cannot.to_string())
    };
    let more = if !broken.is_empty() {
        Some(if on.is_empty() { "Nothing works here until it is fixed.".to_string() } else { format!("{} still works.", names(&on)) })
    } else if !open.is_empty() && !on.is_empty() { Some(format!("{} would add more.", names(&open))) } else if !open.is_empty() { Some(format!("Connect {} to start.", names(&open))) } else { None };
    shadows(
        col()
            .key(format!("channel-job-{key}"))
            .w_full()
            .px(18.0)
            .py(16.0)
            .gap(8.0)
            .radius(12.0)
            .fill(t.card)
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(el().size(8.0, 8.0).radius(4.0).fill(tone))
                    .child(label(title.to_string(), type_::XS_MEDIUM, t.muted_foreground).grow(1.0).min_w(0.0))
                    .child(label(format!("{} of {possible} connected", on.len()), type_::XS11.features("'tnum' 1"), t.muted_foreground)),
            )
            .child(label(headline, type_::SM_MEDIUM, t.foreground).wrap().max_lines(3))
            .children(more.map(|m| label(m, type_::XS, t.muted_foreground).wrap().max_lines(2))),
        &t.card_shadow,
    )
}

pub fn view(s: &App, t: &Theme) -> El {
    let name = s.active_business().map(|b| b.name.clone()).unwrap_or_else(|| "this business".into());
    let business = s.active.clone().unwrap_or_default();
    let header = row()
        .w_full()
        .gap(16.0)
        .items_start()
        .child(col().grow(1.0).min_w(0.0).child(page_header(t, "Channels", &format!("The accounts your agent works through for {name}. It reads results from them and changes nothing until you approve it."))))
        .child(button(t, "channels-refresh", "Check again", Variant::Outline).on_press(|s: &mut App| s.refresh()));
    let status = match &s.channel_status {
        Load::Ready(st) => st,
        Load::Failed(e) => return col().w_full().gap(20.0).child(header).child(failure(t, "channels-failed", e, |s: &mut App| s.refresh())),
        _ => return col().w_full().gap(20.0).child(header).child(label("Checking your accounts.", type_::XS, t.muted_foreground)).child(skeleton(t, 3)),
    };

    // 1. What the agent can do right now.
    let jobs = kit::cols(vec![
        job(t, "measure", "Measure results", "Reading real numbers", "Cannot count results yet", &status.measure),
        job(t, "ads", "Ads and listings", "Reading and preparing changes", "Cannot see ads or listings yet", &status.ads),
        job(t, "website", "Your website", "Preparing page changes and posts", "Cannot change the website yet", &status.website),
    ]);

    // 2. What needs a person.
    let mut needs = col().w_full().gap(8.0);
    let mut waiting = 0;
    for r in status.rows() {
        let (tone, what, why, action) = match r.state {
            Some(State::Reconnect) => (t.wrong, format!("{} stopped working", r.title), "Its sign-in expired or was revoked, so the agent no longer reads it. Signing in again restores it.", "Reconnect"),
            Some(State::Choose) => (t.partial, format!("{} is signed in but not set up", r.title), "Pick the site or account this business uses, and the agent starts reading it.", "Finish setup"),
            None => (t.partial, format!("{} could not be checked", r.title), "Its status did not load. Check again in a moment.", "Check again"),
            _ => continue,
        };
        waiting += 1;
        let act = button(t, &format!("channel-need-{}", r.key), action, Variant::Primary);
        let act = if r.state.is_none() { act.on_press(|s: &mut App| s.refresh()) } else { act.on_press_tx(open_web(format!("/businesses/{business}/channels#{}", r.key))) };
        needs = needs.child(kit::callout(t, &format!("channel-needs-{}", r.key), tone, what, why.to_string(), Some(act)));
    }

    let mut c = col().w_full().gap(20.0).child(header).child(jobs);
    if waiting > 0 {
        c = c.child(col().w_full().gap(10.0).child(label("Needs you", type_::SM_MEDIUM, t.foreground).role("heading")).child(needs));
    }

    // 3. The accounts, by the job they do.
    for (title, sub, rows) in [
        ("Measure results", "So the agent can tell what is working, from real numbers.", &status.measure),
        ("Ads and listings", "The agent reads results and prepares changes for you to approve.", &status.ads),
        ("Your website", "The agent drafts page changes and posts; each one waits for your approval.", &status.website),
    ] {
        let usable: Vec<&Row> = rows.iter().filter(|r| r.state != Some(State::Unavailable)).collect();
        if usable.is_empty() {
            continue;
        }
        let mut list = col().w_full();
        for (k, r) in usable.iter().enumerate() {
            if k > 0 {
                list = list.child(el().w_full().h(1.0).fill(t.foreground.alpha(0.07)));
            }
            list = list.child(channel_row(t, &business, r));
        }
        c = c.child(kit::panel(t, &format!("channel-group-{title}"), title, Some(sub.into()), None, 0.0, list));
    }

    // 4. More the agent can use, two to a row.
    c = c.child(tools(t, &business));

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
        c = c.child(kit::panel(t, "channel-profiles", "Found on your website", Some("Profiles your homepage links to. The agent reads them in research but cannot post there.".into()), None, 0.0, chips));
    }

    // 5. What this workspace cannot connect yet, said once.
    let off: Vec<&Row> = status.rows().filter(|r| r.state == Some(State::Unavailable)).collect();
    if !off.is_empty() {
        let mut marks = row().gap(8.0).center_y();
        for r in &off {
            marks = marks.child(mark(t, r.mark, 26.0));
        }
        c = c.child(
            row()
                .key("channel-off")
                .w_full()
                .px(18.0)
                .py(14.0)
                .gap(14.0)
                .radius(12.0)
                .center_y()
                .border(1.0, t.border)
                .child(marks)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(label(format!("{} cannot be connected on this workspace yet", names(&off)), type_::SM_13, t.foreground).wrap())
                        .child(label("Its sign-in is not switched on for this OpenRecord workspace. Whoever runs your OpenRecord can turn it on; then you connect your own account here.", type_::XS, t.muted_foreground).wrap()),
                ),
        );
    }
    // Room for the decisions stack in the corner, so it never covers the last row.
    c.child(el().h(72.0))
}

fn mark_bare(t: &Theme, key: &str) -> El {
    match crate::channel_marks::for_channel(key) {
        Some(i) => rune::icon(i, 14.0).color(t.foreground),
        None => ico(&icons::GLOBE, 14.0, t.muted_foreground),
    }
}

/// One account: its mark and name, whether it is connected and to what, what
/// the agent gets from it, and the one action its state calls for.
fn channel_row(t: &Theme, business: &str, r: &Row) -> El {
    let key = r.key.to_string();
    let web_row = format!("/businesses/{business}/channels#{key}");
    let (dot, state_text, action, variant) = match r.state {
        Some(State::Connected) => (t.supported, r.identity.as_ref().map(|i| format!("Connected to {i}")).unwrap_or_else(|| "Connected".into()), "Manage", Variant::Outline),
        Some(State::Choose) => (t.partial, "Signed in, setup not finished".to_string(), "Finish setup", Variant::Primary),
        Some(State::Reconnect) => (t.wrong, "Sign-in expired".to_string(), "Reconnect", Variant::Primary),
        Some(State::Available) => (t.muted_foreground.alpha(0.5), "Not connected".to_string(), "Connect", Variant::Primary),
        _ => (t.partial, "Status could not load".to_string(), "Check again", Variant::Outline),
    };
    let act = button(t, &format!("channel-act-{key}"), action, variant).min_w(104.0);
    let act = if r.state.is_none() { act.on_press(|s: &mut App| s.refresh()) } else { act.on_press_tx(open_web(web_row)) };
    row()
        .key(format!("channel-row-{key}"))
        .w_full()
        .py(14.0)
        .gap(14.0)
        .center_y()
        .child(mark(t, r.mark, 36.0))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(3.0)
                .child(
                    row()
                        .w_full()
                        .gap(10.0)
                        .center_y()
                        .child(label(r.title, type_::SM_MEDIUM, t.foreground))
                        .child(row().gap(6.0).center_y().min_w(0.0).child(el().size(6.0, 6.0).radius(3.0).fill(dot)).child(label(state_text, type_::XS, t.muted_foreground).truncate())),
                )
                .child(label(r.purpose, type_::XS, t.muted_foreground).wrap().max_lines(2)),
        )
        .child(act)
}

/// Optional setups, each a card that says what it adds and opens its task.
fn tools(t: &Theme, business: &str) -> El {
    let setup = |id: &str, title: &str, description: &str| {
        let path = format!("/businesses/{business}/channels#{id}");
        shadows(
            col()
                .key(format!("tool-{id}"))
                .w_full()
                .px(18.0)
                .py(16.0)
                .gap(10.0)
                .radius(12.0)
                .fill(t.card)
                .child(col().w_full().gap(4.0).child(label(title.to_string(), type_::SM_MEDIUM, t.foreground).wrap()).child(label(description.to_string(), type_::XS, t.muted_foreground).wrap().max_lines(3)))
                .child(row().child(button(t, &format!("tool-open-{id}"), "Set up", Variant::Outline).on_press_tx(open_web(path)))),
            &t.card_shadow,
        )
    };
    col()
        .w_full()
        .gap(12.0)
        .child(
            col()
                .gap(2.0)
                .child(label("More the agent can use", type_::SM_MEDIUM, t.foreground).role("heading"))
                .child(label("Optional. Each one adds a source or a schedule; none of them lets the agent act without your approval.", type_::XS, t.muted_foreground).wrap()),
        )
        .child(kit::cols(vec![
            setup("ai-answer-tracking", "Check AI answers on a schedule", "Choose your buyer questions and how often to check them, so changes in what assistants say show up without asking."),
            setup("ai-traffic", "See visits from AI assistants", "Import a website log to count AI referrals and crawler visits. Ask whoever runs your website for the log."),
        ]))
        .child(kit::cols(vec![
            setup("research-connections", "Give the agent more research sources", "Add an account you already use for market or competitor research."),
            setup("plugins", "Choose guidance for your business", "Turn on specialist marketing guidance. It connects nothing and grants no permission to act."),
        ]))
        .child(
            row()
                .w_full()
                .gap(12.0)
                .center_y()
                .child(label("For your technical team: tool servers, a live traffic feed and agent access for other apps.", type_::XS, t.muted_foreground).wrap().grow(1.0).min_w(0.0))
                .child(button(t, "tool-open-agent-access", "Advanced connections", Variant::Ghost).on_press_tx(open_web(format!("/businesses/{business}/channels#agent-access")))),
        )
}
