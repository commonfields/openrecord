//! The workspace shell: a sidebar on the canvas, and the content as one inset,
//! rounded panel beside it with the header (breadcrumbs, "Ask the agent") on
//! top. The sidebar is one list for the whole product: Home, the business's
//! pages, then its chats, so nothing is behind a second set of tabs. Surfaces
//! and tokens are the web's (`components/app-shell.tsx`).

use rune::{Align, Cursor, El, ScrollSpec, Side, Spring, TextStyle, col, el, row};

use crate::api::ChatSummary;
use crate::format;
use crate::icons;
use crate::insights::Section;
use crate::state::{App, Menu, Page, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, account_tile, count_badge, ico, icon_button, label, track_hover};

pub const RAIL_WIDTH: f32 = 52.0;
/// Room above the business switcher for the traffic lights (matches their inset).
pub const TITLEBAR: f32 = 48.0;
/// macOS traffic lights: same inset from the window's top and left edges.
pub const TRAFFIC_LIGHT_INSET: f32 = 16.0;
const PANE: Spring = Spring::new(0.5, 0.0);
const CHATS_SHOWN: usize = 6;
const FOLDER_CHATS_SHOWN: usize = 5;
const FOLDER_CHAT_ROW: f32 = 36.0;

/// The button that docks or collapses the sidebar (⌘B): at the right of the
/// sidebar's top band, level with the traffic lights, or beside them once the
/// sidebar is collapsed.
pub fn sidebar_toggle(t: &Theme, open: bool) -> El {
    icon_button(t, "sidebar-toggle", &icons::PANEL_LEFT, if open { "Collapse sidebar (⌘B)" } else { "Expand sidebar (⌘B)" }, false).on_press(|s: &mut App| s.toggle_sidebar())
}

/// Where the collapsed sidebar's buttons start: just past the traffic lights.
fn collapsed_slot_start(titlebar_inset: f32) -> f32 {
    titlebar_inset.max(16.0) + 6.0
}

/// Where they end: Find and the sidebar's button, 28 points each, 2 apart.
pub fn collapsed_slot_end(titlebar_inset: f32) -> f32 {
    collapsed_slot_start(titlebar_inset) + 28.0 + 2.0 + 28.0
}

/// Where the collapsed sidebar's button sits: just past the traffic lights,
/// on the header's line, level with the traffic lights.
pub fn collapsed_toggle(s: &App, t: &Theme, titlebar_inset: f32) -> El {
    let find = icon_button(t, "find-trigger", &icons::SEARCH, "Find (F)", s.find.is_some()).on_press_tx(|s: &mut App, tx| s.toggle_find(tx));
    row()
        .key("sidebar-toggle-slot")
        // 10 points down, where the docked sidebar keeps the same two buttons, so
        // they stay level with the traffic lights; only as wide as the buttons.
        .pin(Some(collapsed_slot_start(titlebar_inset)), Some(10.0), None, None)
        .gap(2.0)
        .center_y()
        .child(find)
        .child(sidebar_toggle(t, false))
}

/// The sidebar while collapsed: nothing in the layout, only a thin strip at the
/// window's left edge. Reaching it shows the whole sidebar as a card over the
/// page, so the page never moves; leaving the card hides it again, unless one of
/// its menus is open.
pub fn sidebar_overlay(s: &App, t: &Theme) -> Vec<El> {
    if s.sidebar_open {
        return Vec::new();
    }
    let strip = el()
        .key("sidebar-reveal")
        .pin(Some(0.0), Some(0.0), None, Some(0.0))
        .w(10.0)
        .on_hover_change(|s: &mut App, inside, _| {
            if inside {
                s.sidebar_peek = true;
            }
        });
    if !s.sidebar_peek {
        return vec![strip];
    }
    let card = shadows(
        col()
            .key("sidebar-peek")
            .pin(Some(8.0), Some(8.0), None, Some(8.0))
            .w(s.prefs.sidebar())
            .radius(12.0)
            .fill(t.sidebar)
            .clip_rounded(12.0)
            .transition(rune::Transition::offset(-16.0, 0.0).combined(rune::Transition::opacity()))
            .on_hover_change(|s: &mut App, inside, _| {
                if !inside && s.menu.is_none() {
                    s.sidebar_peek = false;
                }
            })
            .child(sidebar(s, t).w_full().grow(1.0).min_h(0.0)),
        &t.float_shadow,
    );
    vec![strip, card]
}

pub fn sidebar(s: &App, t: &Theme) -> El {
    let open = s.sidebar_full();
    let business = s.active_business();

    let switcher = {
        let mut b = row()
            .key("business-switcher")
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .role("button")
            .label("Switch business")
            .expanded(s.business_picker.is_some())
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(|s: &mut App| {
                if s.business_picker.is_some() {
                    s.close_business_picker();
                } else {
                    s.open_business_picker();
                }
            });
        if open {
            b = b
                .w_full()
                .h(44.0)
                .px(10.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(label(business.map_or("OpenRecord", |b| b.name.as_str()), type_::SM_MEDIUM, t.foreground).truncate())
                        .child(match business {
                            Some(_) => label("Business", type_::XS2, t.muted_foreground).truncate(),
                            None => label("Choose a business", type_::XS2, t.muted_foreground).truncate(),
                        }),
                )
                .child(ico(&icons::CHEVRONS_UP_DOWN, 16.0, t.muted_foreground));
        } else {
            // On the rail, a plain mark in place of the name.
            b = b.size(36.0, 36.0).justify_center().child(ico(&icons::BUILDING, 16.0, t.muted_foreground));
        }
        if s.business_picker.is_some() {
            b = shadows(b.fill(t.accent), &t.control_shadow);
        }
        b
    };

    let find = icon_button(t, "find-trigger", &icons::SEARCH, "Find (F)", s.find.is_some()).on_press_tx(|s: &mut App, tx| s.toggle_find(tx));

    let nav_body = col().w_full().gap(if open { 20.0 } else { 8.0 }).child(workspace_links(s, t)).child(chat_history(s, t));
    let nav = col()
        .key("sidebar-nav")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .py(16.0)
        .px(if open { 8.0 } else { 6.0 })
        .child(nav_body)
        .scroll(ScrollSpec { stick_bottom: false });

    let account = {
        let ready = matches!(s.update, crate::update::Update::Available(_));
        let mut b = row()
            .key("account-trigger")
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .role("button")
            .label("Settings")
            .expanded(s.settings.is_some())
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(|s: &mut App| s.open_settings(crate::state::SettingsPage::General))
            .child(
                row()
                    .size(FOOT, FOOT)
                    .center()
                    .child(account_tile(t, s.account_email.as_deref(), FOOT_MARK))
                    .children(ready.then(|| {
                        el().absolute(FOOT - 9.0, 1.0).size(8.0, 8.0).radius(4.5).fill(t.primary_ink).border(1.5, t.sidebar).help("A new version is ready")
                    })),
            );
        if s.settings.is_some() {
            b = shadows(b.fill(t.accent), &t.control_shadow);
        }
        if !open {
            b = b.size(FOOT, FOOT).justify_center();
        }
        b
    };

    let mut side = col()
        .key("sidebar")
        .w(if open { s.prefs.sidebar() } else { RAIL_WIDTH })
        .h_full()
        .fill(t.sidebar)
        .motion(PANE)
        .clip_rounded(0.0);
    if s.sidebar_open {
        side = side.child(resize_edge());
    }
    side
        .child(
            row()
                .key("titlebar-band")
                .w_full()
                .h(TITLEBAR)
                .pr(8.0)
                .center_y()
                .window_drag()
                .child(el().grow(1.0))
                .child(row().gap(2.0).center_y().child(find).child(sidebar_toggle(t, s.sidebar_open))),
        )
        .child(col().w_full().gap(8.0).px(if open { 8.0 } else { 6.0 }).items_center().child(switcher))
        .child(nav)
        .child(if open {
            row().w_full().py(8.0).px(8.0).center_y().child(account).child(el().grow(1.0)).child(inbox_button(s, t))
        } else {
            col().w_full().py(8.0).px(6.0).gap(6.0).items_center().child(inbox_button(s, t)).child(account)
        })
}

/// The avatar and the Inbox at the sidebar's foot: each sits in a square this
/// size (the hover and press target), and draws at `FOOT_MARK` inside it.
const FOOT: f32 = 28.0;
const FOOT_MARK: f32 = 20.0;

/// The Inbox at the sidebar's foot, opposite the account: a bare icon the
/// avatar's size, as the sidebar's other icons are, with what waits as a badge.
fn inbox_button(s: &App, t: &Theme) -> El {
    let on = s.view == View::Workspace && s.page == Page::Inbox;
    let waiting = s.waiting() as i64;
    let hk = "nav:inbox".to_string();
    let hovered = s.row_hover.as_deref() == Some(hk.as_str());
    let badge = (waiting > 0).then(|| {
        let text = if waiting > 99 { "99+".to_string() } else { waiting.to_string() };
        row()
            .absolute(FOOT - 12.0, -2.0)
            .h(15.0)
            .min_w(15.0)
            .px(if waiting > 9 { 4.0 } else { 0.0 })
            .radius(7.5)
            .center()
            .fill(t.wrong)
            .border(1.5, t.sidebar)
            .a11y_hidden()
            .child(label(text, type_::COUNT, rune::Color::WHITE))
    });
    row()
        .key("nav-inbox")
        .size(FOOT, FOOT)
        .radius(6.0)
        .center()
        .role("link")
        .label(if waiting > 0 { format!("Inbox, {waiting} waiting") } else { "Inbox".into() })
        .help("Inbox")
        .checked(on)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .motion(CONTROL)
        .on_hover_change(track_hover(hk))
        .on_press(|s: &mut App| s.show_page(Page::Inbox))
        .fill(if on || hovered { t.sidebar_accent } else { t.sidebar_accent.alpha(0.0) })
        .child(ico(&icons::NAV_INBOX, FOOT_MARK, if on || hovered { t.foreground } else { t.muted_foreground }))
        .children(badge)
}

/// What a drag edge is resizing, while one is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resize {
    Sidebar,
    Inbox,
    Helper,
    AnswerDialog,
}

/// The sidebar's right edge: drag to resize between the web's 224 and 448
/// points, double-click for the default, arrow keys to nudge. The width is
/// kept between launches.
fn resize_edge() -> El {
    use crate::prefs::{SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN};
    el().key("sidebar-edge")
        .pin(None, Some(0.0), Some(0.0), Some(0.0))
        .w(8.0)
        .role("separator")
        .label("Resize sidebar")
        .help("Drag to resize; double-click for the default width")
        .focusable(true)
        .cursor(Cursor::ResizeColumn)
        .on_drag(|s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            match d.phase {
                rune::Phase::Down => {
                    d.data = s.prefs.sidebar();
                    s.resizing = Some(Resize::Sidebar);
                }
                rune::Phase::Move => s.prefs.sidebar_width = (d.data + d.dx / s.zoom()).clamp(SIDEBAR_MIN, SIDEBAR_MAX).round(),
                rune::Phase::Up => {
                    if d.cancelled() {
                        s.prefs.sidebar_width = d.data;
                    }
                    s.resizing = None;
                    s.prefs.save();
                }
            }
        })
        .on_double_press(|s: &mut App| {
            s.prefs.sidebar_width = SIDEBAR_DEFAULT;
            s.prefs.save();
        })
        .on_key(|s: &mut App, ev: &rune::KeyEvent, _tx: &mut rune::Tx| {
            let step = match ev.key {
                rune::Key::Left => -16.0,
                rune::Key::Right => 16.0,
                _ => return false,
            };
            s.prefs.sidebar_width = (s.prefs.sidebar() + step).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
            s.prefs.save();
            true
        })
}

/// One row of the sidebar's list: an icon and a name, with a count on the
/// right, or only the icon (and a dot for the count) on the collapsed rail.
fn nav_link(s: &App, t: &Theme, key: &str, icon: &'static rune::Icon, name: &str, active: bool, count: i64) -> El {
    let open = s.sidebar_full();
    let mut link = row()
        .key(format!("nav-{key}"))
        .h(34.0)
        .gap(10.0)
        .radius(7.0)
        .center_y()
        .role("link")
        .label(name.to_string())
        .checked(active)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .on_hover_change(crate::ui::widgets::track_hover(format!("nav:{key}")))
        .child(ico(icon, 16.0, if active { t.foreground } else { t.muted_foreground }));
    if open {
        link = link.w_full().px(10.0).child(
            label(name.to_string(), if active { type_::SM_MEDIUM } else { type_::SM }, if active { t.foreground } else { t.sidebar_foreground })
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
        if count > 0 {
            link = link.child(count_badge(t, count));
        }
    } else {
        link = link.size(36.0, 36.0).justify_center().help(name.to_string());
        if count > 0 {
            link = link.child(el().absolute(26.0, 6.0).size(6.0, 6.0).radius(3.0).fill(t.wrong));
        }
    }
    let hovered = s.row_hover.as_deref() == Some(format!("nav:{key}").as_str());
    crate::ui::widgets::nav_highlight(t, link, hovered, active)
}

/// Home (the agent, with what is waiting on the person) and the business's pages.
fn workspace_links(s: &App, t: &Theme) -> El {
    let mut links = col().w_full().gap(1.0);
    if !s.sidebar_full() {
        links = links.items_center();
    }
    let home = s.home && s.view == View::Agent && s.chat_id.is_none() && !s.general;
    links = links.child(nav_link(s, t, "home", &icons::NAV_HOME, "Home", home, 0).on_press(|s: &mut App| s.go_home()));
    if s.active.is_none() {
        return links;
    }
    for page in Page::ALL {
        let active = s.view == View::Workspace && s.page == page;
        let (i, count): (&'static rune::Icon, i64) = match page {
            Page::Overview => (&icons::NAV_ANALYTICS, 0),
            Page::Campaigns => (&icons::NAV_CAMPAIGNS, 0),
            Page::AiAnswers => (&icons::NAV_ANSWERS, if s.prefs.show_issue_count { s.attention() } else { 0 }),
            Page::Channels => (&icons::NAV_CHANNELS, 0),
            // Inbox sits at the foot, beside the account (`inbox_button`).
            Page::Inbox | Page::Usage | Page::Businesses | Page::Clients => continue,
        };
        links = links.child(nav_link(s, t, page.key(), i, page.label(), active, count).on_press(move |s: &mut App| s.show_page(page)));
    }
    links
}

fn chat_history(s: &App, t: &Theme) -> El {
    let open = s.sidebar_full();
    let new_chat = icon_button(t, "new-chat", &icons::SQUARE_PEN, "New chat (⌘N)", false).on_press_tx(|s: &mut App, tx| s.open_new_chat(tx));
    if !open {
        return col()
            .w_full()
            .items_center()
            .gap(4.0)
            .child(icon_button(t, "chats", &icons::MESSAGES_SQUARE, "Chats", false).on_press(|s: &mut App| s.sidebar_open = true))
            .child(new_chat);
    }
    let now = format::now();
    let archived = s.show_archived;
    let source: Vec<&ChatSummary> = if archived { s.archived.ready().map(|l| l.iter().collect()).unwrap_or_default() } else { s.chats.iter().collect() };
    // With a business filter on, other businesses' chats drop out of the list and its count.
    let filtered: Vec<&ChatSummary> = source.into_iter().filter(|c| s.chat_filter.as_ref().is_none_or(|f| c.business_id.as_ref() == Some(f))).collect();
    let all = s.ordered_chats(filtered.iter().copied());
    let grouped = !archived && s.chat_filter.is_none();
    let shown: Vec<&ChatSummary> = if grouped || s.show_all_chats || archived {
        all.clone()
    } else {
        all.iter().take(CHATS_SHOWN).copied().collect()
    };

    let mut header = row().w_full().pl(10.0).pr(0.0).pb(4.0).gap(6.0).center_y();
    if archived {
        header = header.child(
            row()
                .key("leave-archive")
                .size(20.0, 20.0)
                .radius(4.0)
                .center()
                .role("button")
                .label("Back to chats")
                .cursor(Cursor::Pointer)
                .on_press(|s: &mut App| s.show_archived = false)
                .child(ico(&icons::ARROW_LEFT, 14.0, t.muted_foreground)),
        );
    }
    // As the web draws it: "Chats" on the left, the count on the right.
    header = header.child(label(if archived { "Archived" } else { "Chats" }, type_::XS_MEDIUM, t.muted_foreground));
    if !all.is_empty() {
        header = header.child(label(all.len().to_string(), type_::XS.features("'tnum' 1"), t.muted_foreground.alpha(0.7)));
    }
    let filtered = s.chat_filter.as_ref().and_then(|f| s.businesses.iter().find(|b| &b.id == f)).map(|b| b.name.clone());
    header = header
        .child(el().grow(1.0))
        .child(icon_button(t, "chat-filter", &icons::LIST_FILTER, &filtered.as_ref().map(|n| format!("Filtered to {n}")).unwrap_or_else(|| "Filter chats".into()), filtered.is_some()).on_press(|s: &mut App| s.menu = Some(Menu::ChatFilter)))
        .child(icon_button(t, "archive-toggle", &icons::ARCHIVE, if archived { "Back to chats" } else { "Archived chats" }, archived).on_press(|s: &mut App| s.toggle_archived()))
        .child(new_chat);

    let mut list = col().w_full().gap(2.0);
    if archived && matches!(s.archived, crate::state::Load::Loading) && shown.is_empty() {
        list = list.child(label("Loading archived chats…", type_::SM_13, t.muted_foreground).px(8.0).py(4.0));
    } else if shown.is_empty() {
        let empty = if archived { "No archived chats. Archive a chat you are done with to keep this list short." } else { "No chats yet. Start one from Home." };
        list = list.child(label(empty, type_::SM_13, t.muted_foreground).px(8.0).py(4.0).wrap());
    }
    if grouped {
        for (key, name, chats) in chat_groups(s, &all) {
            list = list.child(chat_group_header(s, t, &key, &name, chats.len()));
            if !s.prefs.chat_groups_collapsed.iter().any(|k| k == &key) {
                list = list.child(folder_chat_list(s, t, &key, &chats, archived, now));
            }
        }
    } else {
        for c in shown {
            list = list.child(chat_row(s, t, c, archived, now, false));
        }
    }
    if !archived && !grouped && all.len() > CHATS_SHOWN {
        let text_ = if s.show_all_chats { "Show fewer".to_string() } else { format!("Show all {}", all.len()) };
        list = list.child(
            row()
                .key("show-all-chats")
                .w_full()
                .pl(8.0)
                .pr(8.0)
                .py(4.0)
                .radius(8.0)
                .role("button")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                // Showing more or fewer chats lands at once; the rows' hover keeps its easing.
                .on_press_tx(|s: &mut App, tx| {
                    tx.instant();
                    s.show_all_chats = !s.show_all_chats;
                })
                .child(label(text_, type_::SM_13, t.muted_foreground)),
        );
    }
    col().w_full().child(header).child(list)
}

/// Chats collected by business, in the businesses' order, then general and any other.
fn chat_groups<'a>(s: &App, all: &[&'a ChatSummary]) -> Vec<(String, String, Vec<&'a ChatSummary>)> {
    use std::collections::HashMap;
    let mut buckets: HashMap<String, Vec<&ChatSummary>> = HashMap::new();
    for c in all {
        let key = c.business_id.clone().unwrap_or_else(|| "_general".into());
        buckets.entry(key).or_default().push(c);
    }
    let mut out = Vec::new();
    for b in &s.businesses {
        if let Some(list) = buckets.remove(&b.id) {
            let chats = s.ordered_chats(list.iter().copied());
            out.push((b.id.clone(), b.name.clone(), chats));
        }
    }
    if let Some(list) = buckets.remove("_general") {
        let chats = s.ordered_chats(list.iter().copied());
        out.push(("_general".into(), "General chat".into(), chats));
    }
    let mut rest: Vec<_> = buckets.into_iter().collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, list) in rest {
        let name = list.first().map(|c| c.business_name.clone()).unwrap_or_else(|| key.clone());
        let chats = s.ordered_chats(list.iter().copied());
        out.push((key, name, chats));
    }
    out
}

/// The most recently active chats in a folder (working first, then by update time).
fn top_active_chats<'a>(chats: &[&'a ChatSummary], n: usize) -> Vec<&'a ChatSummary> {
    let mut v: Vec<_> = chats.to_vec();
    v.sort_by(|a, b| match (a.working, b.working) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => b.updated_at.cmp(&a.updated_at),
    });
    v.into_iter().take(n).collect()
}

fn folder_chat_list(s: &App, t: &Theme, group_key: &str, chats: &[&ChatSummary], archived: bool, now: i64) -> El {
    let expanded = s.prefs.chat_groups_list_expanded.iter().any(|k| k == group_key);
    let mut block = col().key(format!("chat-folder-{group_key}")).w_full().gap(2.0);
    if expanded && chats.len() > FOLDER_CHATS_SHOWN {
        let scroll_h = FOLDER_CHAT_ROW * FOLDER_CHATS_SHOWN as f32 + (FOLDER_CHATS_SHOWN - 1) as f32 * 2.0;
        let mut inner = col().w_full().gap(2.0);
        for c in chats {
            inner = inner.child(chat_row(s, t, c, archived, now, true));
        }
        block = block.child(
            col()
                .key(format!("chat-folder-scroll-{group_key}"))
                .w_full()
                .max_h(scroll_h)
                .child(inner)
                .scroll(ScrollSpec { stick_bottom: false }),
        );
        let fold_key = group_key.to_string();
        block = block.child(
            row()
                .key(format!("chat-folder-fewer-{group_key}"))
                .w_full()
                .pl(26.0)
                .pr(8.0)
                .py(4.0)
                .radius(8.0)
                .role("button")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.toggle_chat_group_list(&fold_key))
                .child(label("Show fewer", type_::SM_13, t.muted_foreground)),
        );
    } else {
        let visible = if chats.len() > FOLDER_CHATS_SHOWN {
            top_active_chats(chats, FOLDER_CHATS_SHOWN)
        } else {
            chats.to_vec()
        };
        for c in visible {
            block = block.child(chat_row(s, t, c, archived, now, true));
        }
        if chats.len() > FOLDER_CHATS_SHOWN {
            let more_key = group_key.to_string();
            let extra = chats.len() - FOLDER_CHATS_SHOWN;
            block = block.child(
                row()
                    .key(format!("chat-folder-more-{group_key}"))
                    .w_full()
                    .pl(26.0)
                    .pr(8.0)
                    .py(4.0)
                    .radius(8.0)
                    .role("button")
                    .cursor(Cursor::Pointer)
                    .hover(t.hover_tint)
                    .on_press(move |s: &mut App| s.toggle_chat_group_list(&more_key))
                    .child(label(format!("See {extra} more"), type_::SM_13, t.muted_foreground)),
            );
        }
    }
    block
}

fn chat_group_header(s: &App, t: &Theme, key: &str, business: &str, count: usize) -> El {
    let collapsed = s.prefs.chat_groups_collapsed.iter().any(|k| k == key);
    let toggle_key = key.to_string();
    let help = if collapsed {
        format!("Show {count} chats in {business}")
    } else {
        format!("Hide chats in {business}")
    };
    row()
        .key(format!("chat-group-{key}"))
        .w_full()
        .pl(8.0)
        .pr(8.0)
        .pt(8.0)
        .pb(4.0)
        .gap(6.0)
        .radius(8.0)
        .center_y()
        .role("button")
        .label(business.to_string())
        .help(help)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .on_press(move |s: &mut App| s.toggle_chat_group(&toggle_key))
        .child(ico(&icons::FOLDER, 14.0, t.muted_foreground))
        .child(label(business.to_string(), type_::XS_MEDIUM, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
        .child(label(count.to_string(), type_::XS.features("'tnum' 1"), t.muted_foreground.alpha(0.7)))
}

/// One history row: the business's mark, the title over where and when (or
/// that it is working), the logos of the models that answered, and on hover
/// the archive button.
fn chat_row(s: &App, t: &Theme, c: &ChatSummary, archived: bool, now: i64, grouped: bool) -> El {
    let active = s.chat_id.as_deref() == Some(c.id.as_str());
    let chat = c.clone();
    let title = c.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "New chat".into());
    let when = format::relative(c.updated_at.as_deref(), now);
    let sub = if c.working {
        row().gap(6.0).center_y().child(el().size(6.0, 6.0).radius(3.0).fill(t.working)).child(label("Working", type_::XS2.lh(16.0), t.working))
    } else if grouped {
        label(when, type_::XS2.lh(16.0), t.muted_foreground).truncate()
    } else {
        label(format!("{}, {}", c.business_name, when), type_::XS2.lh(16.0), t.muted_foreground).truncate()
    };
    let mut logos = row().gap(4.0).center_y();
    let mut providers: Vec<&String> = Vec::new();
    for p in &c.providers {
        if !providers.contains(&p) {
            providers.push(p);
        }
    }
    let shown = &providers[providers.len().saturating_sub(3)..];
    for p in shown {
        logos = logos.child(crate::brands::mark(t, p, 14.0));
    }
    if !shown.is_empty() {
        let names: Vec<String> = shown.iter().map(|p| crate::brands::brand(p).0).collect();
        logos = logos.help(if names.len() > 1 { format!("Models used here: {}", names.join(", ")) } else { "Provider used for the last reply".into() });
    }
    let id = c.id.clone();
    let drag_id = id.clone();
    // Over the row's right end, shown on hover, so it takes no room from the title.
    let archive = row()
        .key(format!("archive-{}", c.id))
        .pin(None, Some(0.0), Some(6.0), Some(0.0))
        .w(24.0)
        .radius(6.0)
        .center()
        .role("button")
        .label(if archived { "Restore chat" } else { "Archive chat" })
        .help(if archived { "Restore chat" } else { "Archive chat" })
        .cursor(Cursor::Pointer)
        .group_opacity(0.0, 1.0)
        .hover_group()
        .on_press(move |s: &mut App| s.archive_chat(&id, !archived))
        // No frame of its own on hover: the icon brightens instead.
        .child(ico(if archived { &icons::ARCHIVE_RESTORE } else { &icons::ARCHIVE }, 14.0, t.muted_foreground).group_color(t.foreground));
    // The web's row: on hover its background eases to the sidebar accent at 70% over
    // 200 milliseconds and its right padding opens for the archive button, so the
    // title stops short of it; the open chat keeps the accent with the control shadow.
    let hover_key = format!("chat:{}", c.id);
    let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
    let hk = hover_key.clone();
    let inset = if grouped { 26.0 } else { 8.0 };
    let mut r = row()
        .key(format!("chat-{}", c.id))
        .w_full()
        .pl(inset)
        .pr(if hovered { 36.0 } else { 8.0 })
        .py(6.0)
        .gap(10.0)
        .radius(8.0)
        .center_y()
        .role("link")
        .label(format!("{title}, {}", c.business_name))
        .checked(active)
        .focusable(true)
        .hover_group()
        .on_hover_change(move |s: &mut App, inside, _tx| {
            if inside {
                s.row_hover = Some(hk.clone());
            } else if s.row_hover.as_deref() == Some(hk.as_str()) {
                s.row_hover = None;
            }
        })
        .motion(rune::Spring::new(0.2, 0.0))
        .cursor(if archived { Cursor::Pointer } else { Cursor::Grab })
        .on_drag(move |s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            if archived {
                return;
            }
            tx.instant();
            if matches!(d.phase, rune::Phase::Up) && !d.cancelled() {
                s.reorder_chat(&drag_id, d.dy);
            }
        })
        .on_press(move |s: &mut App| s.open_chat(&chat))
        .child(col().grow(1.0).min_w(0.0).child(label(title, if active { type_::SM_13.lh(20.0) } else { type_::SM_13 }, t.foreground).truncate()).child(sub))
        .child(logos)
        .child(archive);
    let fill = if active {
        t.sidebar_accent
    } else if hovered {
        t.sidebar_accent.alpha(0.7)
    } else {
        t.sidebar_accent.alpha(0.0)
    };
    let list: Vec<rune::Shadow> = t.control_shadow.iter().map(|x| rune::Shadow { color: if active { x.color } else { x.color.alpha(0.0) }, ..*x }).collect();
    r = shadows(r.fill(fill), &list);
    r
}

/// The business filter for the chat history.
fn chat_filter_menu(s: &App, t: &Theme) -> El {
    let mut m = menu(t, "chat-filter-menu", 240.0).child(label("Filter chats", type_::XS, t.muted_foreground).px(8.0).py(6.0));
    m = m.child(menu_row(t, "filter-all".into(), Some(ico(&icons::MESSAGES_SQUARE, 16.0, t.muted_foreground)), "All businesses", s.chat_filter.is_none()).on_press(|s: &mut App| {
        s.chat_filter = None;
        s.menu = None;
    }));
    for b in &s.businesses {
        let id = b.id.clone();
        m = m.child(menu_row(t, format!("filter-{}", b.id), Some(ico(&icons::FOLDER, 16.0, t.muted_foreground)), &b.name, s.chat_filter.as_deref() == Some(b.id.as_str())).on_press(move |s: &mut App| {
            s.chat_filter = Some(id.clone());
            s.menu = None;
        }));
    }
    m.role("menu").anchored("chat-filter", Side::Right, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None)
}

/// The header across the top of the content panel.
pub fn header(s: &App, t: &Theme, leading_inset: f32, trailing: Option<El>) -> El {
    // 48 tall as before, its line centred in the top 32: the panel starts 8 points
    // down, so that puts the breadcrumbs level with the traffic lights and the
    // sidebar's buttons (centred 24 points from the window's top). The Inbox's and Analytics'
    // insets start right under that line, so there it keeps only 4 below.
    let inbox = s.view == View::Workspace && matches!(s.page, Page::Inbox | Page::Overview);
    let mut h = row().key("header").w_full().h(if inbox { 36.0 } else { 48.0 }).pb(if inbox { 4.0 } else { 16.0 }).pl(20.0 + leading_inset).pr(12.0).gap(8.0).center_y().window_drag();

    if s.view == View::Workspace && s.page.account() {
        // An account page belongs to no business.
        h = h.child(
            row()
                .key("breadcrumbs")
                .gap(6.0)
                .center_y()
                .role("navigation")
                .label("Breadcrumb")
                .child(label("Account", type_::XS, t.muted_foreground))
                .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground.alpha(0.7)))
                .child(label(s.page.label(), type_::XS_MEDIUM, t.foreground)),
        );
    } else if let Some(b) = s.active_business() {
        let chat_title = s.chat_id.as_ref().and_then(|id| s.chats.iter().find(|c| &c.id == id)).and_then(|c| c.title.clone()).filter(|x| !x.is_empty());
        let here = match s.view {
            View::Agent if s.general => "General chat",
            View::Agent if s.chat_id.is_none() && s.home => "Home",
            View::Agent if s.chat_id.is_none() => "New chat",
            View::Agent => chat_title.as_deref().unwrap_or("Chat"),
            View::Workspace => s.page.label(),
        };
        let answer = s.view == View::Workspace && s.page == Page::AiAnswers && s.answer.is_some();
        let sub = if answer { Some("Answer") } else { (s.view == View::Workspace && s.page == Page::Overview && s.section != Section::Summary).then(|| s.section.label()) };
        h = h.child(
            row()
                .key("breadcrumbs")
                .gap(6.0)
                .center_y()
                .min_w(0.0)
                .role("navigation")
                .label("Breadcrumb")
                .child(
                    label(b.name.clone(), type_::XS, t.muted_foreground)
                        .key("crumb-business")
                        .cursor(Cursor::Pointer)
                        .on_press(|s: &mut App| s.go_home())
                        .truncate(),
                )
                .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground.alpha(0.7)))
                .children(sub.is_some().then(|| {
                    label(here, type_::XS, t.muted_foreground).key("crumb-page").cursor(Cursor::Pointer).on_press(|s: &mut App| {
                        if s.answer.is_some() {
                            s.close_answer()
                        } else {
                            s.show_section(Section::Summary)
                        }
                    })
                }))
                .children(sub.is_some().then(|| ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground.alpha(0.7))))
                .child(label(sub.unwrap_or(here), type_::XS_MEDIUM, t.foreground).truncate()),
        );
    }
    h = h.child(el().grow(1.0));
    if let Some(tr) = trailing {
        h = h.child(tr);
    }
    h
}

/// Turns the business wheel one name per notch of scrolling, either direction.
fn business_picker_wheel(s: &mut App, e: rune::WheelEvent, tx: &mut rune::Tx) -> bool {
    if e.mods.cmd {
        return false;
    }
    let count = s.businesses.len();
    let Some(picker) = s.business_picker.as_mut() else {
        return false;
    };
    const NOTCH: f32 = 36.0;
    picker.scroll += e.dy;
    let before = picker.focus;
    while picker.scroll >= NOTCH {
        picker.scroll -= NOTCH;
        picker.focus = picker.focus.saturating_sub(1);
    }
    while picker.scroll <= -NOTCH {
        picker.scroll += NOTCH;
        picker.focus = (picker.focus + 1).min(count.saturating_sub(1));
    }
    if picker.focus != before {
        crate::tick::detent();
    }
    let _ = tx;
    true
}

/// The dial's ruler, in the wheel's points: the main ring with a band of ticks
/// that turns with the focus (a long one at each business, four short between),
/// a finer inner scale, a pointer at the middle, and small markers.
fn ruler(t: &Theme, cx: f32, cy: f32, r: f32, step: f32, focus: usize) -> rune::Shape {
    use rune::{LineCap, Shape};
    let ink = t.foreground;
    let pt = |radius: f32, a: f32| [cx + radius * a.cos(), cy + radius * a.sin()];
    let arc = |radius: f32, from: f32, to: f32| -> Vec<[f32; 2]> {
        let n = 96;
        (0..=n).map(|i| pt(radius, from + (to - from) * i as f32 / n as f32)).collect()
    };
    const REACH: f32 = 1.3;
    let fade = |a: f32| (1.0 - a.abs() / REACH).clamp(0.0, 1.0);
    // An arc that thins out towards both ends instead of stopping short.
    let taper = |mut s: Shape, radius: f32, reach: f32, width: f32, alpha: f32| -> Shape {
        let n = 80;
        for i in 0..n {
            let (a0, a1) = (-reach + 2.0 * reach * i as f32 / n as f32, -reach + 2.0 * reach * (i + 1) as f32 / n as f32);
            let edge = 1.0 - ((a0 + a1) / 2.0).abs() / reach;
            let f = (edge / 0.4).clamp(0.0, 1.0);
            let f = f * f * (3.0 - 2.0 * f);
            if f > 0.0 {
                s = s.line(pt(radius, a0), pt(radius, a1), width, LineCap::Butt, ink.alpha(alpha * f));
            }
        }
        s
    };
    let mut s = taper(Shape::new(), r, 1.45, 1.0, 0.26);
    s = taper(s, r - 58.0, 1.25, 1.0, 0.13);

    // The tick band, turning with the focus.
    let base = focus as i32 * 5;
    for j in (base - 45)..=(base + 45) {
        let a = (j - base) as f32 * step / 5.0;
        let f = fade(a);
        if f <= 0.0 {
            continue;
        }
        let major = j.rem_euclid(5) == 0;
        let len = if major { 18.0 } else { 9.0 };
        s = s.line(pt(r - 3.0, a), pt(r - 3.0 - len, a), if major { 1.5 } else { 1.0 }, LineCap::Butt, ink.alpha(0.08 + if major { 0.5 } else { 0.3 } * f));
    }
    // The inner scale: fine and fixed, like the dial's housing.
    for j in -60..=60 {
        let a = j as f32 * step / 10.0;
        let f = fade(a);
        if f <= 0.0 {
            continue;
        }
        s = s.line(pt(r - 58.0, a), pt(r - 58.0 - if j % 10 == 0 { 7.0 } else { 3.5 }, a), 1.0, LineCap::Butt, ink.alpha(0.05 + 0.2 * f));
    }
    // A pointer inside the ring, aimed at the name in focus.
    let tip = pt(r - 66.0, 0.0);
    s = s.fill(vec![tip, [tip[0] - 13.0, tip[1] - 7.0], [tip[0] - 13.0, tip[1] + 7.0]], ink.alpha(0.55));
    // Small square markers on the inner side, at the neighbours.
    for k in [-3i32, -2, -1, 1, 2, 3] {
        let a = k as f32 * step;
        let [x, y] = pt(r - 74.0, a);
        let size = if k.abs() == 1 { 5.0 } else { 4.0 };
        let h = size / 2.0;
        s = s.fill(vec![[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]], ink.alpha(0.1 + 0.18 * fade(a)));
    }
    s
}

/// A business on the wheel: the same ball for every business, in the dial's ink
/// (graphite on light, silver on dark), lit from the top left. A soft shadow
/// under it, a shaded body, light bouncing up along its lower edge and a glint.
fn wheel_knob(t: &Theme, size: f32) -> El {
    use crate::theme::hex;
    use rune::{Color, Shadow};
    let (hi, base, lo) = if t.dark {
        (hex("#ffffff"), hex("#c3c7cf"), hex("#545862"))
    } else {
        (hex("#8d93a1"), hex("#2a2d35"), hex("#050608"))
    };
    let glint = size * 0.36;
    el().size(size, size)
        .radius(size / 2.0)
        .fill(base)
        .radial_gradient([0.34, 0.28], size * 0.82, [(0.0, hi), (0.38, base), (1.0, lo)])
        .box_shadow(Shadow { x: 0.0, y: size * 0.16, blur: size * 0.5, spread: -size * 0.06, color: Color::BLACK.alpha(if t.dark { 0.6 } else { 0.32 }), inset: false })
        .box_shadow(Shadow { x: 0.0, y: size * 0.02, blur: size * 0.06, spread: 0.0, color: Color::BLACK.alpha(if t.dark { 0.45 } else { 0.25 }), inset: false })
        .box_shadow(Shadow { x: 0.0, y: -size * 0.07, blur: size * 0.16, spread: 0.0, color: Color::WHITE.alpha(if t.dark { 0.35 } else { 0.22 }), inset: true })
        .child(
            el().absolute(size * 0.2, size * 0.13)
                .size(glint, glint * 0.62)
                .radius(glint / 2.0)
                .fill(Color::WHITE.alpha(if t.dark { 0.85 } else { 0.5 }))
                .blur(size * 0.035),
        )
        .a11y_hidden()
}

/// Switch business: the names along a ring at the window's left edge. Scrolling
/// (or Up and Down) turns the wheel; the name at the middle is the one in focus,
/// and pressing it, or Return, switches to it.
pub fn business_picker_dialog(s: &App, t: &Theme, k: &rune_kit::Kit, layer: &mut Vec<El>) {
    let picker = s.business_picker.as_ref().expect("picker open");
    let close = |s: &mut App| s.close_business_picker();
    let list = &s.businesses;
    let focus = picker.focus.min(list.len().saturating_sub(1));

    // The ring: only its right curve shows, the rest runs past the window's left edge.
    // Its radius follows the window's height, so the curve never runs off the top or bottom.
    let height = if s.window.1 > 0.0 { s.window.1 / s.zoom().max(0.1) - 16.0 } else { 840.0 };
    let r_fit = ((height - 48.0) / 2.0).clamp(240.0, 420.0);
    #[allow(non_snake_case)]
    let R = r_fit;
    const W: f32 = 560.0;
    const STEP: f32 = 0.19;
    const SHOWN: i32 = 4;
    let (cx, cy) = (150.0 - R, R);
    let mut wheel = el()
        .key("business-picker-wheel")
        .size(W, 2.0 * R)
        .shape(ruler(t, cx, cy, R, STEP, focus))
        .child(
            el().key("business-picker-ring")
                .absolute(cx - R, cy - R)
                .size(2.0 * R, 2.0 * R)
                .radius(R)
                .fill(t.foreground.alpha(0.025))
                .a11y_hidden(),
        );
    // Each name's number on the dial, between the tick band and the inner arc.
    for (i, _) in list.iter().enumerate() {
        let k_off = i as i32 - focus as i32;
        if k_off.abs() > SHOWN + 1 {
            continue;
        }
        let a = k_off as f32 * STEP;
        let (nx, ny) = (cx + (R - 40.0) * a.cos(), cy + (R - 40.0) * a.sin());
        let fade = (1.0 - 0.18 * k_off.abs() as f32).max(0.15);
        wheel = wheel.child(
            row().key(format!("business-dial-{i}"))
                .absolute(nx - 16.0, ny - 8.0)
                .size(32.0, 16.0)
                .center()
                .rotate(a)
                .motion(CONTROL)
                .a11y_hidden()
                .child(label(format!("{:02}", i + 1), type_::XS.mono(), if k_off == 0 { t.foreground } else { t.muted_foreground.alpha(fade) })),
        );
    }

    if list.is_empty() {
        wheel = wheel.child(
            row().absolute(cx + R + 24.0, cy - 12.0).w(320.0).h(24.0).justify_start().center_y()
                .child(label("No businesses yet. Set one up on the web.", type_::SM, t.muted_foreground)),
        );
    }
    for (i, b) in list.iter().enumerate() {
        let k_off = i as i32 - focus as i32;
        if k_off.abs() > SHOWN {
            continue;
        }
        let angle = k_off as f32 * STEP;
        let (px, py) = (cx + R * angle.cos(), cy + R * angle.sin());
        let on = k_off == 0;
        let current = s.active.as_deref() == Some(b.id.as_str());
        let hk = format!("biz:wheel-{}", b.id);
        let hovered = s.row_hover.as_deref() == Some(hk.as_str());
        let fade = (1.0 - 0.2 * k_off.abs() as f32).max(0.2);
        // Each business is its mark sitting on the ring, with its name beside it.
        let mark = if on { 36.0 } else { 24.0 };
        let mut badge = el()
            .size(mark, mark)
            .radius(mark / 2.0)
            .child(wheel_knob(t, mark));
        if on {
            badge = badge.outline(1.5, 3.0, t.foreground.alpha(0.55));
        }
        let name = if on {
            label(b.name.clone(), TextStyle::new(18.0, 600.0).lh(22.0), t.foreground)
        } else {
            label(b.name.clone(), TextStyle::new(14.0, 500.0).lh(18.0), if hovered { t.foreground } else { t.muted_foreground })
        };
        let id = b.id.clone();
        let mut entry = row()
            .key(format!("business-wheel-{}", b.id))
            .absolute(px - mark / 2.0, py - mark / 2.0)
            .h(mark)
            .gap(if on { 16.0 } else { 12.0 })
            .center_y()
            .role("button")
            .label(b.name.clone())
            .checked(current)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_hover_change(track_hover(hk))
            .on_press(move |s: &mut App| {
                if on {
                    s.select_business(&id);
                } else if let Some(p) = &mut s.business_picker {
                    p.focus = i;
                    crate::tick::detent();
                }
            })
            .child(badge)
            .child(name.truncate().max_w(300.0));
        if !on {
            entry = entry.opacity(if hovered { fade.max(0.8) } else { fade });
        }
        wheel = wheel.child(entry);
    }

    let panel = wheel
        .role("dialog")
        .label("Switch business")
        .focusable(true)
        .on_wheel(business_picker_wheel)
        .on_key(|s: &mut App, ev: &rune::KeyEvent, _tx: &mut rune::Tx| {
            let count = s.businesses.len();
            let Some(p) = s.business_picker.as_mut() else { return false };
            let before = p.focus;
            match ev.key {
                rune::Key::Up | rune::Key::Down => {
                    p.focus = if ev.key == rune::Key::Up { p.focus.saturating_sub(1) } else { (p.focus + 1).min(count.saturating_sub(1)) };
                    if p.focus != before {
                        crate::tick::detent();
                    }
                }
                rune::Key::Enter => {
                    let focus = p.focus;
                    if let Some(id) = s.businesses.get(focus).map(|b| b.id.clone()) {
                        s.select_business(&id);
                    }
                }
                _ => return false,
            }
            true
        })
        .token_motion(k.motion.overlay)
        .modal(true, close)
        .modal_click_outside(true);

    // Inside the content panel, clipped to its rounded card, so the ring comes in
    // from the panel's left edge and never crosses the sidebar. The layer repeats
    // the shell's layout (the sidebar's width, then the card's 8-point inset)
    // instead of reading the panel's rectangle back.
    layer.push(
        row()
            .key("business-picker-layer")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .children(s.sidebar_open.then(|| el().w(s.prefs.sidebar()).h_full()))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .h_full()
                    .pt(8.0)
                    .pb(8.0)
                    .pr(8.0)
                    .pl(if s.sidebar_open { 0.0 } else { 8.0 })
                    .child(
                        col()
                            .key("business-picker-area")
                            .w_full()
                            .h_full()
                            .clip_rounded(10.0)
                            .justify_center()
                            .items_start()
                            .child(panel),
                    ),
            ),
    );
}

/// A floating menu: the web's wide rounded float with 40-point rows.
fn menu(t: &Theme, key: &str, width: f32) -> El {
    // Up and Down move through its items, wrapping at the ends.
    shadows(col().key(key).w(width).padding(6.0).gap(1.0).radius(12.0).fill(t.popover), &t.float_shadow).focus_group()
}

/// One row of a menu. The checked one takes the focus when the menu opens, so
/// Up and Down move from it straight away.
fn menu_row(t: &Theme, key: String, lead: Option<El>, text_: &str, checked: bool) -> El {
    let mut r = row()
        .key(key)
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(10.0)
        .radius(8.0)
        .center_y()
        .role("menuitem")
        .label(text_)
        .focusable(true)
        .cursor(Cursor::Pointer)
        // One highlight for the pointer and the arrow keys, as a native menu has.
        .focus_highlight(t.accent)
        .children(lead)
        .child(label(text_, type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0));
    if checked {
        r = r.child(ico(&icons::CHECK, 16.0, t.foreground)).autofocus();
    }
    r
}

/// The update row, always there: check for a newer version, install one that
/// is waiting, or show how the last attempt went, with this build's version.
fn update_row(s: &App, t: &Theme) -> El {
    use crate::update::{Update, current};
    let spin = || ico(&icons::LOADER, 16.0, t.muted_foreground).looping(rune::LoopSpec::rotation(1.0));
    let (lead, text_, note, busy) = match &s.update {
        Update::Available(r) => (ico(&icons::DOWNLOAD, 16.0, t.primary_ink), format!("Update to {}", r.version), Some("Restarts the app".to_string()), false),
        Update::Installing(v) => (spin(), format!("Installing {v}…"), None, true),
        Update::Checking => (spin(), "Checking for updates…".to_string(), None, true),
        Update::Failed(_) => (ico(&icons::TRIANGLE_ALERT, 16.0, t.wrong), "Update failed, try again".to_string(), None, false),
        Update::UpToDate => (ico(&icons::CHECK, 16.0, t.muted_foreground), "Up to date".to_string(), Some("Check again".to_string()), false),
        Update::Unknown => (ico(&icons::DOWNLOAD, 16.0, t.muted_foreground), "Check for updates".to_string(), None, false),
    };
    let available = matches!(s.update, Update::Available(_));
    let mut r = row()
        .key("app-update")
        .w_full()
        .h(if matches!(s.update, Update::UpToDate) { 40.0 } else { 44.0 })
        .px(10.0)
        .gap(10.0)
        .radius(6.0)
        .center_y()
        .role("menuitem")
        .label(text_.clone())
        .disabled(busy)
        .focusable(!busy)
        .cursor(if busy { Cursor::Default } else { Cursor::Pointer })
        .hover(t.hover_tint)
        .child(lead)
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(label(text_, type_::SM, t.foreground).truncate())
                .children((!matches!(s.update, Update::UpToDate)).then(|| label(format!("OpenRecord {}{}", current(), note.map(|n| format!(", {}", n.to_lowercase())).unwrap_or_default()), type_::XS11, t.muted_foreground).truncate())),
        );
    if available {
        r = r.fill(t.primary_ink.alpha(0.08));
    }
    if busy {
        return r;
    }
    r.on_press(|s: &mut App| match s.update {
        crate::update::Update::Available(_) => s.install_update(),
        _ => s.check_update(),
    })
}

/// The menu open over the sidebar, if any, anchored to its trigger.
pub fn menus(s: &App, t: &Theme) -> Option<El> {
    let width = if s.sidebar_full() { s.prefs.sidebar() - 16.0 } else { 256.0 };
    let side = if s.sidebar_full() { Side::Bottom } else { Side::Right };
    match s.menu? {
        Menu::Model => Some(crate::ui::agent::model_menu(s, t)),
        Menu::Reasoning => Some(crate::ui::agent::reasoning_menu(s, t)),
        Menu::ChatFilter => Some(chat_filter_menu(s, t)),
        Menu::IssueModel | Menu::IssueFact | Menu::IssueSort => crate::ui::issues::menu(s, t, s.menu?),
        // The campaign brief editor that opened this menu is not on the page.
    }
}

/// The web app for an API address: the dev server serves it on :3000 beside the API on :3001.
pub(crate) fn web_url(api: &str) -> String {
    if let Ok(web) = std::env::var("OPENRECORD_WEB_URL") {
        return web;
    }
    api.replace(":3001", ":3000")
}
