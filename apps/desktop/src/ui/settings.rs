//! Settings (`components/settings-dialog.tsx`, `harness-settings.tsx`,
//! `business-memory-settings.tsx`): a large dialog with the sections on the
//! left and the chosen one on a panel on the right.

use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text_input};
use rune_kit::Kit;

use crate::brands;
use crate::icons;
use crate::net::ProviderChange;
use crate::prefs::{ChatWidth, Landing, Style, ThemePref};
use crate::settings::{Bridge, Catalog, Instance, NOTE_KINDS, kind_label};
use crate::state::{App, Load, SettingsPage};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, avatar_sphere, button, ico, label};

/// The scrim and the dialog, as two layers over the window.
pub fn view(s: &App, t: &Theme, k: &Kit, page: SettingsPage) -> Vec<El> {
    let groups: [(&str, &[SettingsPage]); 2] = [
        ("Preferences", &[SettingsPage::General, SettingsPage::Agent, SettingsPage::Checks, SettingsPage::Shortcuts]),
        ("Account", &[SettingsPage::Account, SettingsPage::Privacy, SettingsPage::About]),
    ];
    let mut nav = col().w(224.0).px(8.0).pt(12.0).pb(8.0).gap(20.0).child(label("Settings", type_::BASE_MEDIUM, t.foreground).px(8.0));
    for (name, pages) in groups {
        let mut g = col().w_full().gap(2.0).child(label(name, type_::XS_MEDIUM, t.muted_foreground).px(8.0).pb(4.0));
        for p in pages {
            let p = *p;
            let on = p == page;
            let mut item = row()
                .key(format!("settings-nav-{}", p.key()))
                .w_full()
                .h(32.0)
                .px(8.0)
                .gap(10.0)
                .center_y()
                .radius(6.0)
                .role("link")
                .label(p.title())
                .checked(on)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.sidebar_accent)
                .motion(CONTROL)
                .on_press(move |s: &mut App| s.show_settings(p))
                .child(ico(page_icon(p), 14.0, if on { t.primary_ink } else { t.muted_foreground }))
                .child(label(p.title(), type_::SM, if on { t.foreground } else { t.sidebar_foreground }));
            if on {
                item = item.fill(t.sidebar_accent);
            }
            g = g.child(item);
        }
        nav = nav.child(g);
    }

    let body = match page {
        SettingsPage::General => general(s, t),
        SettingsPage::Agent => agent(s, t, k),
        SettingsPage::Checks => checks(s, t),
        SettingsPage::Shortcuts => shortcuts(t),
        SettingsPage::Account => account(s, t),
        SettingsPage::Privacy => privacy(t),
        SettingsPage::About => about(t),
    };
    let close = row()
        .key("settings-close")
        .size(28.0, 28.0)
        .radius(6.0)
        .center()
        .role("button")
        .label("Close settings")
        .help("Close")
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .on_press(|s: &mut App| s.settings = None)
        .child(ico(&icons::X, 16.0, t.muted_foreground));
    let header = row()
        .w_full()
        .px(24.0)
        .py(16.0)
        .gap(16.0)
        .items_start()
        .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(page.title(), type_::TITLE.lh(24.0), t.foreground).role("heading")).child(label(page.description(), type_::SM_13, t.muted_foreground)))
        .child(close);
    let mut content = col().w_full().max_w(672.0).gap(20.0);
    if let Some(e) = &s.settings_error {
        content = content.child(
            row()
                .key("settings-error")
                .w_full()
                .px(14.0)
                .py(10.0)
                .radius(10.0)
                .fill(t.wrong_soft)
                .live_region(rune::LiveRegion::Polite)
                .child(label(e.clone(), type_::SM_13, t.wrong).wrap().grow(1.0).min_w(0.0))
                .child(label("Dismiss", type_::XS_MEDIUM, t.muted_foreground).key("settings-error-dismiss").role("button").cursor(Cursor::Pointer).on_press(|s: &mut App| s.settings_error = None)),
        );
    }
    content = content.child(body);
    let panel = shadows(
        col()
            .key(format!("settings-{}", page.key()))
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .radius(10.0)
            .fill(t.background)
            .clip_rounded(10.0)
            .child(header)
            .child(col().key("settings-scroll").w_full().grow(1.0).min_h(0.0).child(col().w_full().items_center().px(24.0).pt(8.0).pb(32.0).child(content)).scroll(ScrollSpec { stick_bottom: false })),
        &t.panel_shadow,
    );
    let dialog = shadows(
        row()
            .key("settings-dialog")
            .role("dialog")
            .label("Settings")
            .w_full()
            .max_w(960.0)
            .h_full()
            .max_h(680.0)
            .padding(8.0)
            .radius(16.0)
            .fill(t.sidebar)
            .border(1.0, t.border)
            .child(nav)
            .child(panel),
        &t.float_shadow,
    )
    .modal(true, |s: &mut App| s.settings = None);
    vec![
        el().key("settings-scrim").absolute(0.0, 0.0).w_full().h_full().fill(Color::BLACK.alpha(0.25)).a11y_hidden(),
        el().key("settings-layer").absolute(0.0, 0.0).w_full().h_full().padding(16.0).center().child(dialog),
    ]
}

fn page_icon(p: SettingsPage) -> &'static rune::Icon {
    match p {
        SettingsPage::General => &icons::SLIDERS_HORIZONTAL,
        SettingsPage::Agent => &icons::MESSAGES_SQUARE,
        SettingsPage::Checks => &icons::RADAR,
        SettingsPage::Shortcuts => &icons::KEYBOARD,
        SettingsPage::Account => &icons::USER_ROUND,
        SettingsPage::Privacy => &icons::SHIELD,
        SettingsPage::About => &icons::INFO,
    }
}

// ---- Parts ------------------------------------------------------------------

/// A titled card of rows, as Rune's settings draw one: a small muted title
/// above a hairline-bordered card whose rows are split by inset rules.
fn group(t: &Theme, key: &str, title: &str, description: Option<&str>, rows: Vec<El>) -> El {
    let mut head = col().w_full().gap(2.0).px(12.0).child(label(title.to_string(), type_::SM_MEDIUM.lh(18.0), t.muted_foreground).role("heading"));
    if let Some(d) = description {
        head = head.child(label(d.to_string(), type_::XS.lh(16.0), t.muted_foreground.alpha(0.8)).wrap());
    }
    let mut card = col().w_full().padding(4.0).radius(12.0).fill(t.card).border(1.0, t.foreground.alpha(0.07));
    for (i, r) in rows.into_iter().enumerate() {
        if i > 0 {
            card = card.child(el().h(1.0).mx(12.0).fill(t.foreground.alpha(0.07)).a11y_hidden());
        }
        card = card.child(r);
    }
    col().key(key.to_string()).w_full().gap(8.0).child(head).child(shadows(card, &t.card_shadow))
}

/// A row: its name (and a short note under it) on the left, its control on the right.
fn setting(t: &Theme, name: &str, description: Option<String>, control: Option<El>) -> El {
    let mut left = col().grow(1.0).min_w(0.0).gap(2.0).child(label(name.to_string(), type_::SM, t.foreground));
    let tall = description.is_some();
    if let Some(d) = description {
        left = left.child(label(d, type_::XS.lh(16.0), t.muted_foreground).wrap());
    }
    row().w_full().min_h(if tall { 56.0 } else { 44.0 }).px(12.0).py(8.0).gap(20.0).center_y().radius(8.0).child(left).children(control)
}

/// An on/off switch, as Rune draws one: a 38 by 22 track and a white knob with a soft shadow.
fn switch(t: &Theme, key: &str, name: &str, on: bool, act: impl Fn(&mut App) + 'static) -> El {
    let (w, h, k) = (38.0, 22.0, 18.0);
    let inset = (h - k) / 2.0;
    el()
        .key(key.to_string())
        .size(w, h)
        .radius(h / 2.0)
        .role("switch")
        .label(name.to_string())
        .checked(on)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .motion(CONTROL)
        .fill(if on { t.primary_ink } else { t.muted_foreground.alpha(0.3) })
        .on_press(move |s: &mut App| act(s))
        .child(
            el().key(format!("{key}-knob"))
                .size(k, k)
                .absolute(if on { w - k - inset } else { inset }, inset)
                .radius(k / 2.0)
                .fill(Color::WHITE)
                .shadow(1.0, 3.0, Color::BLACK.alpha(0.25))
                .motion(CONTROL),
        )
}

/// A choice between a few options, in the tab style.
fn choice<T: Copy + PartialEq + 'static>(t: &Theme, key: &str, value: T, options: &[(T, &str)], act: impl Fn(&mut App, T) + Clone + 'static) -> El {
    let mut r = row().key(key.to_string()).h(28.0).padding(2.0).gap(0.0).radius(8.0).fill(t.accent).role("radiogroup");
    for (i, (v, name)) in options.iter().enumerate() {
        let on = *v == value;
        let (v, act) = (*v, act.clone());
        let mut chip = row()
            .key(format!("{key}-{i}"))
            .h_full()
            .min_w(64.0)
            .px(12.0)
            .radius(6.0)
            .center()
            .role("radio")
            .label(name.to_string())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| act(s, v))
            .child(label(name.to_string(), type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }));
        if on {
            chip = shadows(chip.fill(t.control), &t.control_shadow);
        }
        r = r.child(chip);
    }
    r
}

fn small_button(t: &Theme, key: &str, name: &str) -> El {
    button(t, key, name, Variant::Outline).h(28.0).px(10.0)
}

fn kbd(t: &Theme, k: &str) -> El {
    row().min_w(20.0).h(20.0).px(5.0).radius(4.0).center().fill(t.accent).border(1.0, t.border).child(label(k.to_string(), type_::XS_MEDIUM, t.muted_foreground))
}

fn muted(t: &Theme, s: &str) -> El {
    label(s.to_string(), type_::XS, t.muted_foreground)
}

// ---- General ----------------------------------------------------------------

fn theme_preview(dark: bool) -> El {
    let (bg, side1, side2, panel, line1, line2) = if dark {
        (crate::theme::hex("#27272a"), crate::theme::hex("#52525b"), crate::theme::hex("#3f3f46"), crate::theme::hex("#18181b"), crate::theme::hex("#52525b"), crate::theme::hex("#3f3f46"))
    } else {
        (crate::theme::hex("#f4f4f5"), crate::theme::hex("#d4d4d8"), crate::theme::hex("#e4e4e7"), Color::WHITE, crate::theme::hex("#d4d4d8"), crate::theme::hex("#e4e4e7"))
    };
    row()
        .w_full()
        .h(64.0)
        .padding(4.0)
        .gap(4.0)
        .radius(6.0)
        .fill(bg)
        .child(col().w_frac(0.25).padding(2.0).gap(4.0).child(el().w_full().h(6.0).radius(3.0).fill(side1)).child(el().w_frac(0.66).h(6.0).radius(3.0).fill(side2)))
        .child(col().grow(1.0).padding(6.0).gap(4.0).radius(4.0).fill(panel).child(el().w_frac(0.5).h(6.0).radius(3.0).fill(line1)).child(el().w_frac(0.75).h(6.0).radius(3.0).fill(line2)))
}

fn general(s: &App, t: &Theme) -> El {
    let mut cards = row().w_full().gap(12.0);
    for (pref, name, icon) in [(ThemePref::Light, "Light", &icons::SUN), (ThemePref::Dark, "Dark", &icons::MOON), (ThemePref::System, "System", &icons::MONITOR)] {
        let on = s.prefs.theme == pref;
        let preview = if pref == ThemePref::System {
            row().w_full().radius(6.0).clip_rounded(6.0).child(col().grow(1.0).min_w(0.0).child(theme_preview(false))).child(col().grow(1.0).min_w(0.0).child(theme_preview(true)))
        } else {
            theme_preview(pref == ThemePref::Dark)
        };
        let mut foot = row().w_full().pt(8.0).px(2.0).gap(6.0).center_y().child(ico(icon, 14.0, t.muted_foreground)).child(label(name, type_::XS_MEDIUM, t.foreground)).child(el().grow(1.0));
        if on {
            foot = foot.child(ico(&icons::CHECK, 16.0, t.primary_ink));
        }
        let mut card = col()
            .key(format!("theme-{name}"))
            .grow(1.0)
            .min_w(0.0)
            .padding(8.0)
            .radius(10.0)
            .fill(if on { t.accent } else { t.control })
            .role("radio")
            .label(name)
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.set_pref(|p| p.theme = pref))
            .child(preview)
            .child(foot);
        if on {
            card = card.border(1.0, t.primary_ink.alpha(0.6));
        }
        cards = cards.child(shadows(card, &t.control_shadow));
    }
    let appearance = col()
        .key("appearance")
        .w_full()
        .gap(12.0)
        .child(col().gap(4.0).child(label("Appearance", type_::BASE_MEDIUM.lh(20.0), t.foreground).role("heading")).child(label("System follows your Mac and switches automatically.", type_::SM_13, t.muted_foreground)))
        .child(cards)
        .child(shadows(
            col()
                .w_full()
                .radius(10.0)
                .fill(t.card)
                .child(setting(
                    t,
                    "Chat width",
                    Some("How wide messages and the composer can grow on large windows.".into()),
                    Some(choice(t, "chat-width", s.prefs.chat_width, &[(ChatWidth::Comfortable, "Comfortable"), (ChatWidth::Wide, "Wide")], |s, v| s.set_pref(|p| p.chat_width = v))),
                ))
                .child(el().w_full().h(1.0).fill(t.border))
                .child(setting(
                    t,
                    "Reduce motion",
                    Some("Turn off animations and transitions in this app.".into()),
                    Some(switch(t, "pref-motion", "Reduce motion", s.prefs.reduce_motion, |s| s.set_pref(|p| p.reduce_motion = !p.reduce_motion))),
                )),
            &t.card_shadow,
        ));
    col()
        .w_full()
        .gap(20.0)
        .child(appearance)
        .child(group(t, "language", "Language and region", None, vec![setting(t, "Interface language", Some("More languages will follow.".into()), Some(muted(t, "English")))]))
        .child(group(
            t,
            "navigation",
            "Navigation",
            None,
            vec![
                setting(
                    t,
                    "A business opens on",
                    Some("The view you land on when switching to a business.".into()),
                    Some(choice(t, "landing", s.prefs.landing, &[(Landing::Agent, "Agent"), (Landing::Today, "Overview")], |s, v| s.set_pref(|p| p.landing = v))),
                ),
                setting(
                    t,
                    "Show issue count in sidebar",
                    Some("The number next to AI answers counts answers that are wrong, unclear or not rated yet.".into()),
                    Some(switch(t, "pref-count", "Show issue count in sidebar", s.prefs.show_issue_count, |s| s.set_pref(|p| p.show_issue_count = !p.show_issue_count))),
                ),
            ],
        ))
}

// ---- Agent ------------------------------------------------------------------

fn agent(s: &App, t: &Theme, k: &Kit) -> El {
    let style = s.prefs.response_style;
    col()
        .w_full()
        .gap(20.0)
        .child(group(
            t,
            "responses",
            "Responses",
            Some("How the agent writes to you. It always says what it checked and what it couldn't."),
            vec![setting(
                t,
                "Response style",
                Some(style.description().into()),
                Some(choice(t, "response-style", style, &[(Style::Friendly, "Friendly"), (Style::Concise, "Concise"), (Style::Detailed, "Detailed")], |s, v| s.set_pref(|p| p.response_style = v))),
            )],
        ))
        .child(group(
            t,
            "composer-prefs",
            "Composer",
            None,
            vec![
                setting(
                    t,
                    "Send with Return",
                    Some("When off, Return adds a new line and ⌘ Return sends.".into()),
                    Some(switch(t, "pref-enter", "Send with Return", s.prefs.enter_to_send, |s| s.set_pref(|p| p.enter_to_send = !p.enter_to_send))),
                ),
                setting(
                    t,
                    "Voice input",
                    Some("Show the microphone button. Speech is turned into text by macOS dictation.".into()),
                    Some(switch(t, "pref-voice", "Voice input", s.prefs.voice_input, |s| s.set_pref(|p| p.voice_input = !p.voice_input))),
                ),
            ],
        ))
        .children(s.active_business().map(|b| memory(s, t, k, &b.name)))
        .child(connection(s, t))
        .children(pairing(s, t))
        .child(group(
            t,
            "agent-privacy",
            "Privacy",
            Some("Subscription credentials stay on each computer. The server stores provider status, account labels, and conversation data. Hosted-provider keys stay on the server."),
            vec![
                setting(t, "Pairing codes", Some("Work once, expire in ten minutes, and are shown only here, never stored.".into()), None),
                setting(t, "Provider selection", Some("Remembered in this app only, never a credential, and checked by the server on every turn.".into()), None),
            ],
        ))
}

/// What the agent remembers about the business on screen.
fn memory(s: &App, t: &Theme, k: &Kit, business: &str) -> El {
    let mut rows: Vec<El> = Vec::new();
    match &s.memory {
        Load::Ready(notes) if notes.is_empty() => rows.push(
            row()
                .w_full()
                .padding(14.0)
                .gap(8.0)
                .center_y()
                .child(ico(&icons::BRAIN, 16.0, t.muted_foreground))
                .child(label("Nothing saved yet. Tell the agent what to keep in mind, or add a note below.", type_::SM_13, t.muted_foreground).wrap()),
        ),
        Load::Ready(notes) => {
            for n in notes {
                let id = n.id.clone();
                let who = if n.source == "OPERATOR" { "Added by your team" } else { "Saved by the agent" };
                let when = crate::format::date(&n.created_at);
                rows.push(
                    row()
                        .key(format!("note-{}", n.id))
                        .w_full()
                        .padding(14.0)
                        .gap(12.0)
                        .items_start()
                        .child(row().px(8.0).py(2.0).radius(10.0).fill(t.accent).child(label(kind_label(&n.kind), type_::XS_MEDIUM, t.muted_foreground)))
                        .child(col().grow(1.0).min_w(0.0).gap(2.0).child(label(n.text.clone(), type_::SM, t.foreground).wrap()).child(label(format!("{who}, {when}"), type_::XS, t.muted_foreground)))
                        .child(
                            row()
                                .key(format!("forget-{}", n.id))
                                .size(28.0, 28.0)
                                .radius(6.0)
                                .center()
                                .role("button")
                                .label("Forget this note")
                                .help("Forget")
                                .cursor(Cursor::Pointer)
                                .hover(t.hover_tint)
                                .on_press(move |s: &mut App| s.forget_memory(&id))
                                .child(ico(&icons::X, 14.0, t.muted_foreground)),
                        ),
                );
            }
        }
        Load::Failed(e) => rows.push(setting(t, "Couldn't load the notes", Some(e.clone()), None)),
        _ => rows.push(label("Loading", type_::SM_13, t.muted_foreground).padding(14.0)),
    }
    let kind = s.memory_kind % NOTE_KINDS.len();
    let kind_chip = row()
        .key("note-kind")
        .h(32.0)
        .px(10.0)
        .gap(6.0)
        .radius(8.0)
        .center_y()
        .fill(t.control)
        .role("button")
        .label("Kind of note")
        .help("Change the kind of note")
        .cursor(Cursor::Pointer)
        .on_press(|s: &mut App| s.memory_kind = (s.memory_kind + 1) % NOTE_KINDS.len())
        .child(label(NOTE_KINDS[kind].1, type_::XS_MEDIUM, t.foreground))
        .child(ico(&icons::CHEVRONS_UP_DOWN, 12.0, t.muted_foreground));
    let input = text_input(&s.memory_text, type_::XS)
        .key("note-text")
        .placeholder("For example: always write in Indonesian", t.muted_foreground)
        .label("Note")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| &mut s.memory_text)
        .on_submit(|s: &mut App, _tx| s.add_memory());
    let can = !s.memory_text.text.trim().is_empty();
    let _ = k;
    rows.push(
        row()
            .key("note-add")
            .w_full()
            .padding(14.0)
            .gap(8.0)
            .center_y()
            .child(shadows(kind_chip, &t.control_shadow))
            .child(shadows(row().grow(1.0).min_w(0.0).h(32.0).px(10.0).radius(8.0).center_y().fill(t.control).child(input), &t.control_shadow))
            .child(small_button(t, "note-save", "Add note").disabled(!can).opacity(if can { 1.0 } else { 0.5 }).on_press(|s: &mut App| s.add_memory())),
    );
    group(
        t,
        "memory",
        &format!("What the agent remembers about {business}"),
        Some("Notes the agent reads at the start of every chat for this business. It saves them when you state a preference or decision, or when results teach something. They guide it; they are not evidence."),
        rows,
    )
}

/// The models this app can use: the hosted default and the subscriptions on your computers.
fn connection(s: &App, t: &Theme) -> El {
    let mut rows: Vec<El> = Vec::new();
    match &s.providers {
        Load::Ready(cat) => {
            let hosted_logo = cat.hosted.as_ref().map(|h| brands::logo(t, &brands::model_brand(&h.model, &h.provider), 20.0));
            rows.push(setting_icon(
                t,
                hosted_logo,
                "OpenRecord hosted",
                Some(cat.hosted.as_ref().map(|h| format!("{}, {}", h.provider, h.model)).unwrap_or_else(|| "No hosted provider is configured on this server.".into())),
                Some(muted(t, if cat.hosted.is_some() { "Available" } else { "Not configured" })),
            ));
            if cat.local && !cat.bridges.iter().any(|b| b.managed) {
                rows.push(setting_icon(
                    t,
                    Some(ico(&icons::LAPTOP, 20.0, t.muted_foreground)),
                    "This computer",
                    Some("Use the Codex, Claude Code, OpenCode or Cursor already signed in here, and CLIProxyAPI if it is installed. No pairing code needed.".into()),
                    Some(button(t, "connect-local", "Connect", Variant::Primary).h(28.0).px(10.0).on_press(|s: &mut App| s.change_provider(ProviderChange::StartLocal))),
                ));
            }
            for b in cat.machines() {
                rows.extend(machine(s, t, cat, b));
            }
            if cat.bridges.is_empty() && !cat.local {
                rows.push(setting(t, "Computers", Some("No computer is connected yet. Connect one below to use the AI subscriptions signed in there.".into()), None));
            }
        }
        Load::Failed(e) => rows.push(setting(t, "Couldn't load providers", Some(e.clone()), Some(small_button(t, "providers-retry", "Retry").on_press(|s: &mut App| s.show_settings(SettingsPage::Agent))))),
        _ => rows.push(label("Checking provider status…", type_::XS, t.muted_foreground).padding(14.0)),
    }
    group(t, "connection", "Connection", Some("The models this app can use: a hosted default, and the AI subscriptions on your computers."), rows)
}

fn setting_icon(t: &Theme, icon: Option<El>, name: &str, description: Option<String>, control: Option<El>) -> El {
    let mut title = row().gap(8.0).center_y();
    if let Some(i) = icon {
        title = title.child(i);
    }
    title = title.child(label(name.to_string(), type_::SM_MEDIUM, t.foreground));
    let mut left = col().grow(1.0).min_w(0.0).gap(2.0).child(title);
    if let Some(d) = description {
        left = left.child(label(d, type_::SM_13, t.muted_foreground).wrap());
    }
    row().w_full().min_h(80.0).padding(14.0).gap(20.0).center_y().child(left).children(control)
}

/// One computer and the providers on it; an offline one folds to one line.
fn machine(s: &App, t: &Theme, cat: &Catalog, b: &Bridge) -> Vec<El> {
    let missing: Vec<String> = cat.missing(&b.id).iter().map(|i| i.name.clone()).collect();
    let note = if !b.online {
        Some(if b.managed { "OpenRecord starts it again by itself; this clears once it reconnects.".to_string() } else { "Not connected. Start the bridge on that computer again, or remove it here.".to_string() })
    } else if !missing.is_empty() {
        Some(format!("Not installed here: {}", missing.join(", ")))
    } else {
        None
    };
    let title = row()
        .gap(8.0)
        .center_y()
        .child(ico(if b.managed { &icons::LAPTOP } else { &icons::MONITOR }, 20.0, t.muted_foreground))
        .child(label(if b.managed { "This computer".to_string() } else { b.name.clone() }, type_::SM_MEDIUM, t.foreground))
        .child(el().size(6.0, 6.0).radius(3.0).fill(if b.online { t.supported } else { t.muted_foreground.alpha(0.4) }))
        .child(label(if b.online { "Online" } else { "Offline" }, type_::SM, t.muted_foreground));
    let mut left = col().grow(1.0).min_w(0.0).gap(2.0).child(title);
    if let Some(n) = note {
        left = left.child(label(n, type_::SM_13, t.muted_foreground).wrap());
    }
    let id = b.id.clone();
    let mut out = vec![row()
        .key(format!("machine-{}", b.id))
        .w_full()
        .min_h(80.0)
        .padding(14.0)
        .gap(20.0)
        .center_y()
        .child(left)
        .child(small_button(t, &format!("revoke-{}", b.id), if b.managed { "Disconnect" } else { "Remove" }).on_press(move |s: &mut App| s.change_provider(ProviderChange::Revoke(id.clone()))))];
    if b.online {
        for i in cat.found(&b.id) {
            out.push(instance(s, t, i, b.managed));
        }
    }
    out
}

/// A provider on a computer: its state, a refresh, the switch, and which models the chat offers.
fn instance(s: &App, t: &Theme, i: &Instance, managed: bool) -> El {
    let logo = brands::mark(t, if i.driver == "claude" { "claude-code" } else { &i.driver }, 20.0);
    let mut left = col().grow(1.0).min_w(0.0).gap(4.0).child(row().gap(8.0).center_y().child(logo).child(label(i.name.clone(), type_::SM_MEDIUM, t.foreground)));
    if i.enabled {
        let status = i.status();
        let version = i.version.as_ref().map(|v| format!("{} {v}", crate::chat::driver_name(&i.driver))).unwrap_or_else(|| "version unknown".into());
        left = left.child(label(format!("{status}, {version}, {}", i.model_count()), type_::SM_13, if status == "Authentication failed" { t.wrong } else { t.muted_foreground }).wrap());
        if i.installed && i.auth != "authenticated" && i.driver != "cliproxy" {
            let cmd = i.login_command(managed);
            left = left.child(label(if i.auth == "unauthenticated" { "Signed out. Sign in on that computer, then refresh here:" } else { "Sign-in state is unknown. If a turn fails, sign in with:" }, type_::XS11, t.muted_foreground)).child(copy_command(t, &format!("login-{}", i.id), &cmd));
        }
    } else {
        left = left.child(label(format!("Off, {} model{} available", i.models.len(), if i.models.len() == 1 { "" } else { "s" }), type_::SM_13, t.muted_foreground));
    }
    let mut controls = row().gap(8.0).center_y();
    if i.enabled {
        let id = i.id.clone();
        controls = controls.child(
            row()
                .key(format!("refresh-{}", i.id))
                .size(28.0, 28.0)
                .radius(6.0)
                .center()
                .role("button")
                .label(format!("Refresh {}", i.name))
                .help("Refresh state and models")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.change_provider(ProviderChange::Refresh(id.clone())))
                .child(ico(&icons::REFRESH_CW, 14.0, t.muted_foreground)),
        );
    }
    let (id, on) = (i.id.clone(), i.enabled);
    controls = controls.child(switch(t, &format!("enable-{}", i.id), &format!("Turn {} {}", i.name, if on { "off" } else { "on" }), on, move |s| s.change_provider(ProviderChange::Enable(id.clone(), !on))));
    let mut c = col()
        .key(format!("instance-{}", i.id))
        .w_full()
        .pl(40.0)
        .pr(14.0)
        .py(14.0)
        .gap(8.0)
        .child(row().w_full().gap(24.0).center_y().child(left).child(controls));
    if i.enabled && i.models_truncated {
        c = c.child(label(format!("This provider's catalog was too large. Only the first {} models are available here.", i.models.len()), type_::XS, t.muted_foreground));
    }
    if i.enabled && !i.models.is_empty() {
        c = c.child(model_choices(s, t, i));
    }
    c
}

/// Which of a provider's models the chat offers.
fn model_choices(s: &App, t: &Theme, i: &Instance) -> El {
    let open = s.open_models.contains(&i.id);
    let key = i.id.clone();
    let toggle = row()
        .key(format!("models-{}", i.id))
        .gap(4.0)
        .center_y()
        .role("button")
        .expanded(open)
        .cursor(Cursor::Pointer)
        .on_press(move |s: &mut App| {
            if !s.open_models.remove(&key) {
                s.open_models.insert(key.clone());
            }
        })
        .child(ico(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 14.0, t.muted_foreground))
        .child(label(format!("Choose models ({} of {} on)", i.models_on(), i.models.len()), type_::XS_MEDIUM, t.muted_foreground));
    let mut c = col().w_full().gap(8.0).child(toggle);
    if open {
        let mut list = col().w_full().radius(8.0).fill(t.accent.alpha(0.5)).clip_rounded(8.0);
        for (n, m) in i.models.iter().enumerate() {
            if n > 0 {
                list = list.child(el().w_full().h(1.0).fill(t.border));
            }
            let on = i.model_on(&m.id);
            let (id, model) = (i.id.clone(), m.id.clone());
            let name = if m.name.is_empty() { m.id.clone() } else { m.name.clone() };
            let mut text_ = col().grow(1.0).min_w(0.0).child(label(name.clone(), type_::SM_13, t.foreground).truncate());
            if m.name != m.id && !m.name.is_empty() {
                text_ = text_.child(label(m.id.clone(), type_::XS11, t.muted_foreground).truncate());
            }
            list = list.child(
                row()
                    .key(format!("model-switch-{}-{}", i.id, m.id))
                    .w_full()
                    .px(12.0)
                    .py(8.0)
                    .gap(12.0)
                    .center_y()
                    .child(text_)
                    .child(switch(t, &format!("model-on-{}-{}", i.id, m.id), &format!("{} {name}", if on { "Turn off" } else { "Turn on" }), on, move |s| {
                        s.change_provider(ProviderChange::Model(id.clone(), model.clone(), !on))
                    })),
            );
        }
        c = c.child(list);
        if i.models_on() == 0 {
            c = c.child(label(format!("Every model is off, so the chat won't offer {}.", i.name), type_::XS, t.muted_foreground));
        }
    }
    c
}

fn copy_command(t: &Theme, key: &str, cmd: &str) -> El {
    let value = cmd.to_string();
    row()
        .key(key.to_string())
        .w_full()
        .gap(4.0)
        .center_y()
        .child(label(cmd.to_string(), type_::XS.mono(), t.muted_foreground).truncate().px(8.0).py(4.0).radius(6.0).fill(t.accent).grow(1.0).min_w(0.0))
        .child(
            row()
                .key(format!("{key}-copy"))
                .size(28.0, 28.0)
                .radius(6.0)
                .center()
                .role("button")
                .label("Copy")
                .help("Copy")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press_tx(move |s: &mut App, tx| {
                    tx.copy(value.clone());
                    s.notice = Some("Copied.".into());
                })
                .child(ico(&icons::COPY, 14.0, t.muted_foreground)),
        )
}

/// Connecting another computer: a one-time code and a prompt for its coding agent.
fn pairing(s: &App, t: &Theme) -> Option<El> {
    let local = s.providers.ready().is_some_and(|c| c.local);
    let api = std::env::var(crate::state::API_ENV).unwrap_or_else(|_| crate::state::DEFAULT_API.into());
    let origin = crate::ui::shell::web_url(&api);
    let body = match &s.pairing {
        Load::Ready(p) => {
            let prompt = crate::settings::setup_prompt(&p.code, &p.expires_at, &origin);
            let cmd = format!("node openrecord-bridge.mjs pair --server {origin} --code {}", p.code);
            col()
                .w_full()
                .padding(14.0)
                .gap(10.0)
                .child(label(format!("The code works once and expires at {}. Paste the prompt into the coding agent on that computer, or run the command there.", crate::format::date_time(&p.expires_at)), type_::SM_13, t.muted_foreground).wrap())
                .child(copy_command(t, "pair-command", &cmd))
                .child(row().gap(8.0).child(small_button(t, "pair-prompt", "Copy setup prompt").on_press_tx(move |s: &mut App, tx| {
                    tx.copy(prompt.clone());
                    s.notice = Some("Setup prompt copied.".into());
                })))
        }
        Load::Loading => col().w_full().padding(14.0).child(label("Making a pairing code…", type_::SM_13, t.muted_foreground)),
        Load::Failed(e) => col().w_full().padding(14.0).child(label(format!("Couldn't make a pairing code ({e})."), type_::SM_13, t.wrong).wrap()),
        Load::Idle => setting(t, "Pair a computer", Some("Make a one-time code, then run the bridge on the computer with your AI subscriptions.".into()), Some(small_button(t, "pair-new", "Get a code").on_press(|s: &mut App| s.new_pairing()))),
    };
    Some(group(
        t,
        "pair",
        if local { "Another computer" } else { "Connect a computer" },
        Some("Use the AI subscriptions signed in on another computer. Their credentials stay there; only the provider status comes here."),
        vec![body],
    ))
}

// ---- Checks, shortcuts, account, privacy, about -----------------------------

fn checks(s: &App, t: &Theme) -> El {
    let value = if s.prefs.default_provider == "9router" { 1 } else { 0 };
    group(
        t,
        "checks-prefs",
        "Running checks",
        None,
        vec![
            setting(
                t,
                "Default provider",
                Some("Preselected when a re-check runs. You can still switch before each run.".into()),
                Some(choice(t, "default-provider", value, &[(0, "Mock (test answers)"), (1, "9Router (live model)")], |s, v| s.set_pref(|p| p.default_provider = if v == 1 { "9router".into() } else { "mock".into() }))),
            ),
            setting(t, "Retries", Some("Rate limits, timeouts and unavailable providers are retried up to 3 times. Other failures stop right away.".into()), Some(muted(t, "Managed by the server"))),
        ],
    )
}

fn shortcuts(t: &Theme) -> El {
    let line = |name: &str, keys: &[&str]| {
        let mut k = row().gap(4.0).center_y();
        for key in keys {
            k = k.child(kbd(t, key));
        }
        row().w_full().px(16.0).py(12.0).center_y().child(label(name.to_string(), type_::XS, t.foreground).grow(1.0)).child(k)
    };
    col()
        .w_full()
        .gap(20.0)
        .child(group(
            t,
            "keys-general",
            "General",
            None,
            vec![
                line("Open settings", &["⌘", ","]),
                line("Toggle sidebar", &["⌘", "B"]),
                line("Agent", &["⌘", "1"]),
                line("Workspace", &["⌘", "2"]),
                line("Refresh", &["⌘", "R"]),
                line("Close a dialog or menu", &["Esc"]),
            ],
        ))
        .child(group(t, "keys-agent", "Agent", None, vec![line("New chat", &["⌘", "N"]), line("Send message", &["Return"]), line("New line", &["Shift", "Return"])]))
}

fn account(s: &App, t: &Theme) -> El {
    let email = s.account_email.clone();
    let id_value = |v: Option<String>| match v {
        Some(v) => copy_command(t, &format!("id-{v}"), &v).w(300.0),
        None => muted(t, if matches!(s.identity, Load::Failed(_)) { "Unavailable" } else { "Loading" }),
    };
    let me = s.identity.ready();
    col()
        .w_full()
        .gap(20.0)
        .child(shadows(
            row()
                .key("account-card")
                .w_full()
                .min_h(80.0)
                .padding(14.0)
                .gap(16.0)
                .center_y()
                .radius(10.0)
                .fill(t.card)
                .child(avatar_sphere(t, 40.0))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(label(email.clone().unwrap_or_else(|| "Your account".into()), type_::SM_MEDIUM, t.foreground).truncate())
                        .child(label("Signed in with email and password", type_::XS, t.muted_foreground))
                        .children(if let Load::Failed(e) = &s.identity { Some(label(format!("Could not verify session ({e})"), type_::XS, t.wrong)) } else { None }),
                ),
            &t.card_shadow,
        ))
        .child(group(
            t,
            "sign-in",
            "Sign-in details",
            Some("Changing your email or password is not available in the app yet."),
            vec![setting(t, "Email", Some(email.unwrap_or_else(|| "Sign in again on this Mac to show it here.".into())), None), setting(t, "Password", Some("Set when the account was created.".into()), None)],
        ))
        .child(group(
            t,
            "session",
            "Session",
            None,
            vec![setting(
                t,
                "This Mac",
                Some("Signed in. The session is kept between launches.".into()),
                Some(small_button(t, "settings-sign-out", "Sign out").on_press(|s: &mut App| {
                    s.settings = None;
                    s.sign_out();
                })),
            )],
        ))
        .child(group(
            t,
            "identifiers",
            "Identifiers",
            Some("Useful when reporting a problem."),
            vec![setting(t, "Account ID", None, Some(id_value(me.map(|m| m.account_id.clone())))), setting(t, "User ID", None, Some(id_value(me.map(|m| m.user_id.clone()))))],
        ))
}

fn privacy(t: &Theme) -> El {
    col()
        .w_full()
        .gap(20.0)
        .child(group(
            t,
            "leaves",
            "What leaves this app",
            None,
            vec![
                setting(t, "Buyer questions", Some("Running a check sends the question text to the provider you pick. Mock checks stay on the server and cost nothing.".into()), None),
                setting(t, "Provider keys", Some("Keys live only on the server. They are never sent to this app or stored with your data.".into()), None),
                setting(t, "Attached files", Some("Files you attach to a message are sent to the agent with it, as text.".into()), None),
            ],
        ))
        .child(group(
            t,
            "kept",
            "What is kept",
            None,
            vec![
                setting(t, "Answer history", Some("Every AI answer is kept exactly as it came in and can't be edited. New ratings are added on top, so nothing is rewritten.".into()), None),
                setting(
                    t,
                    "Preferences",
                    Some("Settings on this screen are saved on this Mac only.".into()),
                    Some(small_button(t, "reset-prefs", "Reset preferences").on_press(|s: &mut App| {
                        s.set_pref(|p| *p = crate::prefs::Prefs::default());
                        s.notice = Some("Preferences reset.".into());
                    })),
                ),
            ],
        ))
}

fn about(t: &Theme) -> El {
    group(
        t,
        "about-group",
        "OpenRecord",
        None,
        vec![
            setting(t, "Version", Some("Mac app".into()), Some(muted(t, env!("CARGO_PKG_VERSION")))),
            setting(t, "What it does", Some("Checks what AI assistants say about your business and compares it with the facts you approve.".into()), None),
        ],
    )
}
