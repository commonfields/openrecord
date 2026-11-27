//! The workspace shell: a sidebar on the canvas, and the content as one inset,
//! rounded panel beside it with the header (breadcrumbs, "Ask the agent") on
//! top. The sidebar is one list for the whole product: Home, the business's
//! pages, then its chats, so nothing is behind a second set of tabs. Surfaces
//! and tokens are the web's (`components/app-shell.tsx`).

use rune::{Align, Cursor, El, ScrollSpec, Side, Spring, col, el, row, text_input};

use crate::api::ChatSummary;
use crate::format;
use crate::icons;
use crate::insights::Section;
use crate::state::{App, Menu, Page, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, account_tile, count_badge, ico, icon_button, label, track_hover};

pub const RAIL_WIDTH: f32 = 52.0;
/// Gap between the sidebar-coloured canvas and the inset content panel on every exposed edge.
pub const CANVAS_INSET: f32 = 10.0;
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
    icon_button(t, "sidebar-toggle", &icons::PANEL_LEFT, if open { "Collapse sidebar (⌘B)" } else { "Expand sidebar (⌘B)" }, false).on_press_tx(|s: &mut App, tx| s.toggle_sidebar(tx))
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

/// Collapsed sidebar controls drawn above the workspace, not in the split row.
/// Reaching the left edge shows the sidebar as a card over the page so the main
/// panel and right side never change width; leaving the card hides it again.
pub fn collapsed_sidebar_layer(s: &App, t: &Theme, titlebar_inset: f32) -> El {
    let strip = el()
        .key("sidebar-reveal")
        .pin(Some(0.0), Some(0.0), None, Some(0.0))
        .w(10.0)
        .h_full()
        .on_hover_change(|s: &mut App, inside, _| {
            if inside {
                s.sidebar_peek = true;
            }
        })
        .on_drag(|s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            if d.phase == rune::Phase::Down {
                s.sidebar_peek = true;
            }
        });
    let mut layer = el()
        .key("sidebar-collapsed-layer")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .child(strip)
        .child(collapsed_toggle(s, t, titlebar_inset));
    if s.sidebar_peek {
        let peek = shadows(
            col()
                .key("sidebar-peek")
                .pin(Some(8.0), Some(8.0), None, Some(8.0))
                .w(s.prefs.sidebar())
                .radius(12.0)
                .fill(t.sidebar)
                .clip_rounded(12.0)
                .on_hover_change(|s: &mut App, inside, _| {
                    if !inside && s.menu.is_none() {
                        s.sidebar_peek = false;
                    }
                })
                .child(sidebar(s, t).w_full().grow(1.0).min_h(0.0)),
            &t.float_shadow,
        );
        layer = layer.child(peek);
    }
    layer
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
            .on_press_tx(|s: &mut App, tx| {
                if s.business_picker.is_some() {
                    s.close_business_picker();
                } else {
                    s.open_business_picker();
                    tx.focus("business-picker-search", false);
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
            .child(icon_button(t, "chats", &icons::MESSAGES_SQUARE, "Chats", false).on_press_tx(|s: &mut App, tx| s.toggle_sidebar(tx)))
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

fn picker_entries(s: &App) -> Vec<(usize, crate::state::PickerCard)> {
    let q = s.business_picker.as_ref().map(|p| p.query.text.trim().to_lowercase()).unwrap_or_default();
    s.picker_cards()
        .into_iter()
        .enumerate()
        .filter(|(_, c)| q.is_empty() || c.name.to_lowercase().contains(&q))
        .collect()
}

/// One business as the app's other lists draw a row: its name and a quiet note.
/// The business's correct-AI-answers line, as the Inbox card draws it; shown on the highlighted row.
fn business_trend(s: &App, t: &Theme, card: &crate::state::PickerCard, on: bool) -> Option<El> {
    let (days, load) = s.trends.get(card.id.as_ref()?)?;
    let n = crate::ui::inbox::accuracy(load.ready()?, *days)?;
    if n.days.len() < 2 {
        return None;
    }
    let tone = match (&n.delta, n.better) {
        (None, _) => t.chart.primary,
        (_, true) => t.supported,
        (_, false) => t.wrong,
    };
    Some(row().opacity(if on { 1.0 } else { 0.0 }).motion(crate::ui::widgets::HOVER).child(crate::ui::inbox::sparkline(&n.days, tone, 96.0, 28.0)))
}

fn business_row(t: &Theme, card: &crate::state::PickerCard, note: Option<&str>, current: bool, on: bool, trend: Option<El>) -> El {
    row()
        .w_full()
        .min_h(44.0)
        .px(10.0)
        .gap(12.0)
        .radius(6.0)
        .center_y()
        .child(
            col().grow(1.0).min_w(0.0)
                .child(label(card.name.clone(), type_::SM_MEDIUM, t.foreground).truncate())
                .children(note.map(|n| label(n.to_string(), type_::XS, t.muted_foreground).truncate())),
        )
        .children(current.then(|| ico(&icons::CHECK, 14.0, t.muted_foreground)))
        // The trend line sits just left of the ↵ mark.
        .children(trend)
        // The ↵ mark is always there, shown only on the highlighted row, so nothing shifts.
        .child(row().size(14.0, 14.0).center().opacity(if on { 1.0 } else { 0.0 }).motion(crate::ui::widgets::HOVER).child(ico(&icons::CORNER_DOWN_LEFT, 14.0, t.muted_foreground)))
}

fn picker_kbd(t: &Theme, k: &str) -> El {
    row().min_w(18.0).h(18.0).px(4.0).radius(4.0).center().fill(t.accent).border(1.0, t.border).child(label(k.to_string(), type_::XS2.lh(14.0), t.muted_foreground))
}

/// The businesses as a list in a Find-style floating panel.
pub fn business_picker_dialog(s: &App, t: &Theme, k: &rune_kit::Kit, layer: &mut Vec<El>) {
    let picker = s.business_picker.as_ref().expect("picker open");
    let close = |s: &mut App| s.close_business_picker();
    let chat = picker.mode == crate::state::PickerMode::Chat;
    let entries = picker_entries(s);
    let count = entries.len();
    let focus = if count == 0 { 0 } else { picker.focus.min(count - 1) };

    let input = text_input(&picker.query, type_::SM)
        .key("business-picker-search")
        .placeholder("Search businesses", t.muted_foreground)
        .label(if chat { "Choose what to chat about" } else { "Switch business" })
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| {
            if let Some(p) = s.business_picker.as_mut() {
                p.focus = 0;
            }
            &mut s.business_picker.as_mut().expect("picker open").query
        })
        .on_submit(|s: &mut App, _tx| {
            let list = picker_entries(s);
            if let Some(&(idx, _)) = list.get(s.business_picker.as_ref().map(|p| p.focus).unwrap_or(0)) {
                s.pick_card(idx);
            }
        });
    let field_hovered = s.row_hover.as_deref() == Some("business-picker:search");
    let field = shadows(
        crate::ui::widgets::highlight(
            t,
            row()
                .key("business-picker-field")
                .w_full()
                .h(44.0)
                .px(12.0)
                .gap(10.0)
                .radius(10.0)
                .center_y()
                .border(1.0, t.border)
                .on_hover_change(track_hover("business-picker:search".into()))
                .fill(if field_hovered { t.accent } else { t.popover })
                .child(ico(&icons::SEARCH, 16.0, t.muted_foreground))
                .child(col().grow(1.0).min_w(0.0).child(input))
                .child(picker_kbd(t, "Esc")),
            field_hovered,
            false,
        ),
        &t.float_shadow,
    );

    let mut body = col().key("business-picker-list").w_full().padding(6.0).gap(2.0);
    if entries.is_empty() {
        body = body.child(label("No matching businesses.", type_::SM, t.muted_foreground).py(24.0));
    }
    for (list_i, &(card_i, ref card)) in entries.iter().enumerate() {
        let on = list_i == focus;
        let current = if chat {
            match &card.id {
                Some(id) => !s.general && s.active.as_deref() == Some(id.as_str()),
                None => s.general,
            }
        } else {
            card.id.as_deref() == s.active.as_deref()
        };
        let note = if current {
            Some(if chat { "Chatting about this now" } else { "Current business" })
        } else if card.sample {
            Some("Sample data")
        } else {
            None
        };
        let key = card.id.clone().unwrap_or_else(|| "general".into());
        let slot = business_row(t, card, note, current, on, business_trend(s, t, card, on))
            .key(format!("business-card-{key}"))
            .role("option")
            .label(card.name.clone())
            .checked(on)
            .cursor(Cursor::Pointer)
            .on_press_tx(move |s: &mut App, tx| {
                tx.instant();
                s.pick_card(card_i);
            })
            .on_hover_change(move |s: &mut App, inside, _tx| {
                if inside && let Some(p) = s.business_picker.as_mut() {
                    p.focus = list_i;
                }
            });
        body = body.child(crate::ui::widgets::highlight(t, slot, on, false));
    }

    let footer = row()
        .w_full()
        .px(16.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(row().gap(4.0).center_y().child(picker_kbd(t, "↑")).child(picker_kbd(t, "↓")).child(label("move", type_::XS11, t.muted_foreground)))
        .child(row().gap(4.0).center_y().child(picker_kbd(t, "↵")).child(label("choose", type_::XS11, t.muted_foreground)))
        .child(el().grow(1.0));

    let list_card = shadows(
        col()
            .w_full()
            .radius(10.0)
            .fill(t.popover)
            .border(1.0, t.border)
            .clip_rounded(10.0)
            .child(col().key("business-picker-scroll").w_full().max_h(448.0).child(body).scroll(ScrollSpec { stick_bottom: false }))
            .child(footer),
        &t.float_shadow,
    );

    let panel = col()
        .key("business-picker-dialog")
        .role("dialog")
        .label(if chat { "Choose what to chat about" } else { "Switch business" })
        .w_full()
        .max_w(672.0)
        .gap(6.0)
        .focusable(true)
        .focus_group()
        .on_key(|s: &mut App, ev: &rune::KeyEvent, _tx| {
            let list = picker_entries(s);
            let n = list.len();
            if n == 0 {
                return false;
            }
            let Some(p) = s.business_picker.as_mut() else { return false };
            let before = p.focus.min(n - 1);
            match ev.key {
                rune::Key::Up => p.focus = before.saturating_sub(1),
                rune::Key::Down => p.focus = (before + 1).min(n - 1),
                rune::Key::Enter => {
                    if let Some(&(idx, _)) = list.get(before) {
                        s.pick_card(idx);
                    }
                    return true;
                }
                _ => return false,
            }
            if p.focus.min(n - 1) != before {
                crate::tick::detent();
            }
            true
        })
        .child(field)
        .child(list_card)
        .token_motion(k.motion.overlay)
        .modal(true, close)
        .modal_click_outside(true);

    layer.push(
        col()
            .key("business-picker-layer")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .pt(96.0)
            .px(12.0)
            .items_center()
            .child(panel),
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
