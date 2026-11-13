//! The workspace shell: a sidebar on the canvas, and the content as one inset,
//! rounded panel beside it with the header (breadcrumbs, "Ask the agent") on
//! top. The sidebar is one list for the whole product: Home, the business's
//! pages, then its chats, so nothing is behind a second set of tabs. Surfaces
//! and tokens are the web's (`components/app-shell.tsx`).

use rune::{Align, Cursor, El, ScrollSpec, Side, Spring, col, el, row};

use crate::api::ChatSummary;
use crate::format;
use crate::icons;
use crate::insights::Section;
use crate::state::{App, Menu, Page, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, avatar_sphere, business_mark, count_badge, ico, icon_button, label};

pub const RAIL_WIDTH: f32 = 52.0;
/// Room above the business switcher for the traffic lights.
/// The sidebar's top band: down to the header's centre line (32 points) and as far below it.
pub const TITLEBAR: f32 = 56.0;
const PANE: Spring = Spring::new(0.5, 0.0);
const CHATS_SHOWN: usize = 6;

/// The button that docks or collapses the sidebar (⌘B): at the right of the
/// sidebar's top band, level with the traffic lights, or beside them once the
/// sidebar is collapsed.
pub fn sidebar_toggle(t: &Theme, open: bool) -> El {
    icon_button(t, "sidebar-toggle", &icons::PANEL_LEFT, if open { "Collapse sidebar (⌘B)" } else { "Expand sidebar (⌘B)" }, false).on_press(|s: &mut App| s.toggle_sidebar())
}

/// Where the collapsed sidebar's button sits: just past the traffic lights,
/// on the header's line, 32 points down, as the traffic lights are.
pub fn collapsed_toggle(t: &Theme, titlebar_inset: f32) -> El {
    row().key("sidebar-toggle-slot").pin(Some(titlebar_inset.max(16.0) + 6.0), Some(18.0), None, None).child(sidebar_toggle(t, false))
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
            .expanded(s.menu == Some(Menu::Businesses))
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(|s: &mut App| s.menu = if s.menu == Some(Menu::Businesses) { None } else { Some(Menu::Businesses) })
            .child(business_mark(t, business.map(|b| b.name.as_str()), 28.0, 6.0));
        if open {
            b = b
                .w_full()
                .h(44.0)
                .px(6.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(label(business.map_or("OpenRecord", |b| b.name.as_str()), type_::SM_MEDIUM, t.foreground).truncate())
                        .child(label(if business.is_some() { "Business" } else { "Choose a business" }, type_::XS2, t.muted_foreground).truncate()),
                )
                .child(ico(&icons::CHEVRONS_UP_DOWN, 16.0, t.muted_foreground));
        } else {
            b = b.size(36.0, 36.0).justify_center();
        }
        if s.menu == Some(Menu::Businesses) {
            b = shadows(b.fill(t.accent), &t.control_shadow);
        }
        b
    };

    let tools = {
        let find = icon_button(t, "find-trigger", &icons::SEARCH, "Find (F)", s.find.is_some()).on_press_tx(|s: &mut App, tx| s.toggle_find(tx));
        let new_chat = icon_button(t, "new-chat", &icons::SQUARE_PEN, "New chat (⌘N)", false).on_press_tx(|s: &mut App, tx| s.open_new_chat(tx));
        if open {
            row().w_full().center_y().justify_between().child(find).child(new_chat)
        } else {
            col().gap(4.0).items_center().child(find).child(new_chat)
        }
    };

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
        let name = s.account_email.as_deref().map(|e| e.split('@').next().unwrap_or(e).to_string()).unwrap_or_else(|| "Your account".into());
        let mut b = row()
            .key("account-trigger")
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .role("button")
            .label("Account menu")
            .expanded(s.menu == Some(Menu::Account))
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(|s: &mut App| s.menu = if s.menu == Some(Menu::Account) { None } else { Some(Menu::Account) })
            .child({
                // A dot on the avatar while a newer version waits in the account menu.
                let ready = matches!(s.update, crate::update::Update::Available(_));
                row().size(24.0, 24.0).child(avatar_sphere(t, 24.0)).children(ready.then(|| {
                    el().absolute(17.0, -1.0).size(9.0, 9.0).radius(4.5).fill(t.primary_ink).border(1.5, t.sidebar).help("A new version is ready")
                }))
            });
        if open {
            b = b
                .w_full()
                .h(64.0)
                .px(10.0)
                .child(label(name, type_::BASE_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0))
                .child(ico(&icons::CHEVRONS_UP_DOWN, 16.0, t.muted_foreground));
        } else {
            b = b.size(36.0, 56.0).justify_center();
        }
        if s.menu == Some(Menu::Account) {
            b = shadows(b.fill(t.accent), &t.control_shadow);
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
        .child(row().key("titlebar-band").w_full().h(TITLEBAR).pt(8.0).pr(8.0).center_y().window_drag().child(el().grow(1.0)).child(sidebar_toggle(t, s.sidebar_open)))
        .child(
            col()
                .w_full()
                .gap(8.0)
                .px(if open { 8.0 } else { 6.0 })
                .items_center()
                .child(switcher)
                .child(tools),
        )
        .child(nav)
        .child(col().w_full().py(8.0).px(if open { 8.0 } else { 6.0 }).items_center().child(account))
}

/// What a drag edge is resizing, while one is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resize {
    Sidebar,
    Helper,
    AgentPane,
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

fn group_label(t: &Theme, text_: &str) -> El {
    label(text_, type_::SM_MEDIUM, t.muted_foreground).px(8.0).pb(4.0)
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
    let home = s.view == View::Agent && s.chat_id.is_none() && !s.general;
    links = links.child(nav_link(s, t, "home", &icons::NAV_HOME, "Home", home, 0).on_press(|s: &mut App| s.go_home()));
    if s.active.is_none() {
        return links;
    }
    for page in Page::ALL {
        let active = s.view == View::Workspace && s.page == page;
        let (i, count): (&'static rune::Icon, i64) = match page {
            Page::Inbox => (&icons::NAV_INBOX, s.waiting() as i64),
            Page::Overview => (&icons::NAV_ANALYTICS, 0),
            Page::Campaigns => (&icons::NAV_CAMPAIGNS, 0),
            Page::AiAnswers => (&icons::NAV_ANSWERS, if s.prefs.show_issue_count { s.attention() } else { 0 }),
            Page::Channels => (&icons::NAV_CHANNELS, 0),
            Page::Usage | Page::Businesses | Page::Clients => continue,
        };
        links = links.child(nav_link(s, t, page.key(), i, page.label(), active, count).on_press(move |s: &mut App| s.show_page(page)));
    }
    links
}

fn chat_history(s: &App, t: &Theme) -> El {
    let open = s.sidebar_full();
    if !open {
        return col().w_full().items_center().child(icon_button(t, "chats", &icons::MESSAGES_SQUARE, "Chats", false).on_press(|s: &mut App| s.sidebar_open = true));
    }
    let now = format::now();
    let archived = s.show_archived;
    let source: Vec<&ChatSummary> = if archived { s.archived.ready().map(|l| l.iter().collect()).unwrap_or_default() } else { s.chats.iter().collect() };
    // With a business filter on, other businesses' chats drop out of the list and its count.
    let all: Vec<&ChatSummary> = source.into_iter().filter(|c| s.chat_filter.as_ref().is_none_or(|f| c.business_id.as_ref() == Some(f))).collect();
    let shown: Vec<&ChatSummary> = if s.show_all_chats || archived { all.clone() } else { all.iter().take(CHATS_SHOWN).copied().collect() };

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
        .child(icon_button(t, "archive-toggle", &icons::ARCHIVE, if archived { "Back to chats" } else { "Archived chats" }, archived).on_press(|s: &mut App| s.toggle_archived()));

    let mut list = col().w_full().gap(2.0);
    if archived && matches!(s.archived, crate::state::Load::Loading) && shown.is_empty() {
        list = list.child(label("Loading archived chats…", type_::SM_13, t.muted_foreground).px(8.0).py(4.0));
    } else if shown.is_empty() {
        let empty = if archived { "No archived chats. Archive a chat you are done with to keep this list short." } else { "No chats yet. Start one from Home." };
        list = list.child(label(empty, type_::SM_13, t.muted_foreground).px(8.0).py(4.0).wrap());
    }
    for c in shown {
        list = list.child(chat_row(s, t, c, archived, now));
    }
    if !archived && all.len() > CHATS_SHOWN {
        let text_ = if s.show_all_chats { "Show fewer".to_string() } else { format!("Show all {}", all.len()) };
        list = list.child(
            row()
                .key("show-all-chats")
                .px(8.0)
                .py(4.0)
                .radius(6.0)
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

/// One history row: the business's mark, the title over where and when (or
/// that it is working), the logos of the models that answered, and on hover
/// the archive button.
fn chat_row(s: &App, t: &Theme, c: &ChatSummary, archived: bool, now: i64) -> El {
    let active = s.chat_id.as_deref() == Some(c.id.as_str());
    let chat = c.clone();
    let title = c.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "New chat".into());
    let sub = if c.working {
        row().gap(6.0).center_y().child(el().size(6.0, 6.0).radius(3.0).fill(t.working)).child(label("Working", type_::XS2.lh(16.0), t.working))
    } else {
        label(format!("{}, {}", c.business_name, format::relative(c.updated_at.as_deref(), now)), type_::XS2.lh(16.0), t.muted_foreground).truncate()
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
    let mut r = row()
        .key(format!("chat-{}", c.id))
        .w_full()
        .pl(8.0)
        .pr(if hovered { 36.0 } else { 8.0 })
        .py(6.0)
        .gap(10.0)
        .radius(8.0)
        .center_y()
        .role("link")
        .label(format!("{title}, {}", c.business_name))
        .checked(active)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover_group()
        .on_hover_change(move |s: &mut App, inside, _tx| {
            if inside {
                s.row_hover = Some(hk.clone());
            } else if s.row_hover.as_deref() == Some(hk.as_str()) {
                s.row_hover = None;
            }
        })
        .motion(rune::Spring::new(0.2, 0.0))
        .on_press(move |s: &mut App| s.open_chat(&chat))
        .child(business_mark(t, Some(&c.business_name), 28.0, 8.0))
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
    m = m.child(menu_row(t, "filter-all".into(), ico(&icons::MESSAGES_SQUARE, 16.0, t.muted_foreground), "All businesses", s.chat_filter.is_none()).on_press(|s: &mut App| {
        s.chat_filter = None;
        s.menu = None;
    }));
    for b in &s.businesses {
        let id = b.id.clone();
        m = m.child(menu_row(t, format!("filter-{}", b.id), business_mark(t, Some(&b.name), 24.0, 6.0), &b.name, s.chat_filter.as_deref() == Some(b.id.as_str())).on_press(move |s: &mut App| {
            s.chat_filter = Some(id.clone());
            s.menu = None;
        }));
    }
    m.role("menu").anchored("chat-filter", Side::Right, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None)
}

/// The header across the top of the content panel.
pub fn header(s: &App, t: &Theme, leading_inset: f32, trailing: Option<El>) -> El {
    let mut h = row().key("header").w_full().h(48.0).pl(20.0 + leading_inset).pr(12.0).gap(8.0).center_y().window_drag();

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
            View::Agent if s.chat_id.is_none() => "Home",
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

/// A floating menu: the web's wide rounded float with 40-point rows.
fn menu(t: &Theme, key: &str, width: f32) -> El {
    shadows(col().key(key).w(width).padding(6.0).gap(1.0).radius(12.0).fill(t.popover), &t.float_shadow)
}

fn menu_row(t: &Theme, key: String, lead: El, text_: &str, checked: bool) -> El {
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
        .hover(t.hover_tint)
        .child(lead)
        .child(label(text_, type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0));
    if checked {
        r = r.child(ico(&icons::CHECK, 16.0, t.foreground));
    }
    r
}

/// The account menu, as the web draws it: who is signed in, then Settings,
/// Account, Keyboard shortcuts and Usage; Businesses and Clients and products;
/// and Sign out. A waiting update shows above Sign out.
pub fn account_menu(s: &App, t: &Theme, _k: &rune_kit::Kit, layer: &mut Vec<El>) {
    if s.menu != Some(Menu::Account) {
        return;
    }
    let email = s.account_email.clone().unwrap_or_else(|| "Signed in".into());
    let name = email.split('@').next().unwrap_or(&email).to_string();
    let api = crate::state::api_base();
    let web = web_url(&api);
    let item = |key: &str, icon: &'static rune::Icon, text_: &str| {
        let hk = format!("acct:{key}");
        let hovered = s.row_hover.as_deref() == Some(hk.as_str());
        let r = row().key(key.to_string()).w_full().h(40.0).px(12.0).gap(10.0).radius(8.0).center_y()
            .role("menuitem").label(text_.to_string()).focusable(true).cursor(Cursor::Pointer)
            .on_hover_change(crate::ui::widgets::track_hover(hk))
            .child(ico(icon, 16.0, if hovered { t.foreground } else { t.muted_foreground }))
            .child(label(text_.to_string(), type_::SM, t.foreground).truncate().grow(1.0).min_w(0.0));
        crate::ui::widgets::highlight(t, r, hovered, false)
    };
    let rule = || el().w_full().h(1.0).my(6.0).fill(t.border);
    let settings = |page: crate::state::SettingsPage| move |s: &mut App| {
        s.menu = None;
        s.open_settings(page);
    };
    let _ = web;
    // Opens in the app, as the web opens them in its own shell.
    let page = |p: Page| {
        move |s: &mut App| {
            s.menu = None;
            s.show_page(p);
        }
    };
    let width = if s.sidebar_full() { (s.prefs.sidebar() - 16.0).max(256.0) } else { 256.0 };
    let mut m = menu(t, "account-menu-list", width)
        .child(row().w_full().px(10.0).py(10.0).gap(12.0).center_y()
            .child(avatar_sphere(t, 36.0))
            .child(col().min_w(0.0).gap(1.0).child(label(name, type_::XS_MEDIUM, t.foreground).truncate()).child(label(email, type_::XS, t.muted_foreground).truncate())))
        .child(rule())
        .child(item("acct-settings", &icons::SETTINGS, "Settings").on_press(settings(crate::state::SettingsPage::General)))
        .child(item("acct-account", &icons::USER_ROUND, "Account").on_press(settings(crate::state::SettingsPage::Account)))
        .child(item("acct-shortcuts", &icons::KEYBOARD, "Keyboard shortcuts").on_press(settings(crate::state::SettingsPage::Shortcuts)))
        .child(item("acct-usage", &icons::GAUGE, "Usage").on_press(page(Page::Usage)))
        .child(rule())
        .child(item("acct-businesses", &icons::BUILDING, "Businesses").on_press(page(Page::Businesses)))
        .child(item("acct-clients", &icons::BRIEFCASE, "Clients and products").on_press(page(Page::Clients)))
        .child(rule())
        .child(update_row(s, t))
        .child(rule());
    m = m.child(item("sign-out", &icons::LOG_OUT, "Sign out").on_press(|s: &mut App| s.sign_out()));
    let side = if s.sidebar_full() { Side::Top } else { Side::Right };
    layer.push(m.role("menu").anchored("account-trigger", side, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None));
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
        .h(44.0)
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
                .child(label(format!("OpenRecord {}{}", current(), note.map(|n| format!(", {}", n.to_lowercase())).unwrap_or_default()), type_::XS11, t.muted_foreground).truncate()),
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
        Menu::Businesses => {
            let mut m = menu(t, "business-menu", width).child(label("Businesses", type_::XS, t.muted_foreground).px(8.0).py(6.0));
            for b in &s.businesses {
                let id = b.id.clone();
                m = m.child(
                    menu_row(t, format!("business-{}", b.id), business_mark(t, Some(&b.name), 24.0, 6.0), &b.name, s.active.as_deref() == Some(b.id.as_str()))
                        .on_press(move |s: &mut App| {
                            s.select_business(&id);
                        }),
                );
            }
            if s.businesses.is_empty() {
                m = m.child(label("No businesses yet. Set one up on the web.", type_::SM_13, t.muted_foreground).px(8.0).py(6.0).wrap());
            }
            Some(m.role("menu").anchored("business-switcher", side, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None))
        }
        // Built with the kit beside the other layers (`account_menu`).
        Menu::Account => None,
        Menu::Model => Some(crate::ui::agent::model_menu(s, t)),
        Menu::Reasoning => Some(crate::ui::agent::reasoning_menu(s, t)),
        Menu::ChatFilter => Some(chat_filter_menu(s, t)),
        Menu::IssueModel | Menu::IssueFact | Menu::IssueSort => crate::ui::issues::menu(s, t, s.menu?),
        // The campaign brief editor that opened this menu is not on the page.
        Menu::Choice => None,
    }
}

/// The web app for an API address: the dev server serves it on :3000 beside the API on :3001.
pub(crate) fn web_url(api: &str) -> String {
    if let Ok(web) = std::env::var("OPENRECORD_WEB_URL") {
        return web;
    }
    api.replace(":3001", ":3000")
}
