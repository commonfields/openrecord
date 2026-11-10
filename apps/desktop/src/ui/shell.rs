//! The workspace shell, as `components/app-shell.tsx` draws it: a sidebar on
//! the canvas, and the content as one inset, rounded panel beside it with the
//! header (sidebar toggle, Agent and Workspace tabs, breadcrumbs) on top.

use rune::{Align, Cursor, El, ScrollSpec, Side, Spring, col, el, row};

use crate::api::ChatSummary;
use crate::format;
use crate::icons;
use crate::state::{App, Menu, Page, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, avatar_sphere, business_mark, count_badge, ico, icon_button, label};

pub const SIDEBAR_WIDTH: f32 = 256.0;
pub const RAIL_WIDTH: f32 = 52.0;
/// Room above the business switcher for the traffic lights.
pub const TITLEBAR: f32 = 36.0;
const PANE: Spring = Spring::new(0.5, 0.0);
const CHATS_SHOWN: usize = 6;

pub fn sidebar(s: &App, t: &Theme) -> El {
    let open = s.sidebar_open;
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

    let agent = s.view == View::Agent;
    let tools = {
        let new_chat = icon_button(t, "new-chat", &icons::SQUARE_PEN, "New chat", false).on_press(|s: &mut App| s.new_chat());
        let refresh = icon_button(t, "refresh", &icons::REFRESH_CW, "Refresh", false).on_press(|s: &mut App| s.refresh());
        if open {
            row().w_full().center_y().justify_between().child(refresh).child(new_chat)
        } else {
            col().gap(4.0).items_center().child(refresh).child(new_chat)
        }
    };

    let nav_body = if agent { chat_history(s, t) } else { workspace_links(s, t) };
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
            .key("account-menu")
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
            .child(avatar_sphere(t, 24.0));
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

    col()
        .key("sidebar")
        .w(if open { SIDEBAR_WIDTH } else { RAIL_WIDTH })
        .h_full()
        .fill(t.sidebar)
        .motion(PANE)
        .clip_rounded(0.0)
        .child(el().key("titlebar-band").w_full().h(TITLEBAR).window_drag())
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

fn group_label(t: &Theme, text_: &str) -> El {
    label(text_, type_::SM_MEDIUM, t.muted_foreground).px(8.0).pb(4.0)
}

fn workspace_links(s: &App, t: &Theme) -> El {
    let open = s.sidebar_open;
    let mut links = col().w_full().gap(1.0);
    for page in Page::ALL {
        let active = s.view == View::Workspace && s.page == page;
        let (i, count): (&'static rune::Icon, i64) = match page {
            Page::Inbox => (&icons::INBOX, s.waiting() as i64),
            Page::Overview => (&icons::CHART_COLUMN, 0),
            Page::Campaigns => (&icons::BRIEFCASE, 0),
            Page::AiAnswers => (&icons::CIRCLE_ALERT, s.attention()),
            Page::Channels => (&icons::PLUG, 0),
        };
        let mut link = row()
            .key(format!("nav-{}", page.key()))
            .h(36.0)
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .role("link")
            .label(page.label())
            .checked(active)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.show_page(page))
            .child(ico(i, 14.0, if active { t.primary_ink } else { t.muted_foreground }));
        if open {
            link = link.w_full().px(8.0).child(
                label(page.label(), if active { type_::BASE_MEDIUM } else { type_::BASE }, if active { t.foreground } else { t.sidebar_foreground })
                    .truncate()
                    .grow(1.0)
                    .min_w(0.0),
            );
            if count > 0 {
                link = link.child(count_badge(t, count));
            }
        } else {
            link = link.size(36.0, 36.0).justify_center().help(page.label());
            if count > 0 {
                link = link.child(el().absolute(26.0, 6.0).size(6.0, 6.0).radius(3.0).fill(t.wrong));
            }
        }
        if active {
            link = shadows(link.fill(t.sidebar_accent), &t.control_shadow);
        }
        links = links.child(link);
    }
    let mut c = col().w_full();
    if open {
        c = c.child(group_label(t, "Workspace"));
    }
    if s.active.is_none() {
        return c.child(label("Choose a business to see its workspace.", type_::SM_13, t.muted_foreground).px(8.0).wrap());
    }
    c.child(links)
}

fn chat_history(s: &App, t: &Theme) -> El {
    let open = s.sidebar_open;
    if !open {
        return col().w_full().items_center().child(icon_button(t, "chats", &icons::MESSAGES_SQUARE, "Chats", false).on_press(|s: &mut App| s.sidebar_open = true));
    }
    let now = format::now();
    let shown: Vec<&ChatSummary> = if s.show_all_chats { s.chats.iter().collect() } else { s.chats.iter().take(CHATS_SHOWN).collect() };
    let mut header = row().w_full().px(8.0).pb(6.0).center_y().child(label("Chats", type_::SM_MEDIUM, t.muted_foreground));
    if !s.chats.is_empty() {
        header = header.child(el().grow(1.0)).child(label(s.chats.len().to_string(), type_::XS2.features("'tnum' 1"), t.muted_foreground));
    }
    let mut list = col().w_full().gap(2.0);
    if s.chats.is_empty() {
        list = list.child(label("No chats yet. Open a business and ask its agent.", type_::SM_13, t.muted_foreground).px(8.0).py(4.0).wrap());
    }
    for c in shown {
        let active = s.chat_id.as_deref() == Some(c.id.as_str());
        let chat = c.clone();
        let title = c.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "New chat".into());
        let sub = if c.working {
            row()
                .gap(6.0)
                .center_y()
                .child(el().size(6.0, 6.0).radius(3.0).fill(t.working))
                .child(label("Working", type_::XS2.lh(16.0), t.working))
        } else {
            label(format!("{}, {}", c.business_name, format::relative(c.updated_at.as_deref(), now)), type_::XS2.lh(16.0), t.muted_foreground).truncate()
        };
        let mut r = row()
            .key(format!("chat-{}", c.id))
            .w_full()
            .px(8.0)
            .py(6.0)
            .gap(10.0)
            .radius(8.0)
            .center_y()
            .role("link")
            .label(format!("{title}, {}", c.business_name))
            .checked(active)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.open_chat(&chat))
            .child(business_mark(t, Some(&c.business_name), 28.0, 8.0))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .child(label(title, if active { type_::SM_13.lh(20.0) } else { type_::SM_13 }, t.foreground).truncate())
                    .child(sub),
            );
        if active {
            r = shadows(r.fill(t.sidebar_accent), &t.control_shadow);
        }
        list = list.child(r);
    }
    if s.chats.len() > CHATS_SHOWN {
        let text_ = if s.show_all_chats { "Show fewer".to_string() } else { format!("Show all {}", s.chats.len()) };
        list = list.child(
            row()
                .key("show-all-chats")
                .px(8.0)
                .py(4.0)
                .radius(6.0)
                .role("button")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(|s: &mut App| s.show_all_chats = !s.show_all_chats)
                .child(label(text_, type_::SM_13, t.muted_foreground)),
        );
    }
    col().w_full().child(header).child(list)
}

/// The header across the top of the content panel.
pub fn header(s: &App, t: &Theme, leading_inset: f32, trailing: Option<El>) -> El {
    let toggle = icon_button(t, "sidebar-toggle", &icons::PANEL_LEFT, if s.sidebar_open { "Collapse sidebar (⌘B)" } else { "Expand sidebar (⌘B)" }, false)
        .on_press(|s: &mut App| s.sidebar_open = !s.sidebar_open);
    let mut h = row().key("header").w_full().h(48.0).pl(20.0 + leading_inset).pr(12.0).gap(8.0).center_y().window_drag().child(toggle);

    if let Some(b) = s.active_business() {
        h = h.child(tabs(s, t)).child(el().w(1.0).h(16.0).mx(4.0).fill(t.border));
        let here = match s.view {
            View::Agent => "Agent",
            View::Workspace => s.page.label(),
        };
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
                        .on_press(|s: &mut App| s.show_view(View::Agent))
                        .truncate(),
                )
                .child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground.alpha(0.7)))
                .child(label(here, type_::XS_MEDIUM, t.foreground).truncate()),
        );
    }
    h = h.child(el().grow(1.0));
    if let Some(tr) = trailing {
        h = h.child(tr);
    }
    h
}

fn tabs(s: &App, t: &Theme) -> El {
    let tab = |key: &str, text_: &str, view: View| {
        let active = s.view == view;
        let mut b = row()
            .key(key)
            .h_full()
            .w(85.0)
            .radius(5.0)
            .center()
            .role("tab")
            .label(text_)
            .checked(active)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.show_view(view))
            .child(label(text_, type_::XS_MEDIUM.lh(16.0), if active { t.foreground } else { t.muted_foreground }));
        if active {
            b = shadows(b.fill(t.control), &t.control_shadow);
        }
        b
    };
    shadows(
        row()
            .key("view-tabs")
            .h(28.0)
            .padding(2.0)
            .gap(2.0)
            .radius(7.0)
            .fill(t.sidebar)
            .role("tablist")
            .label("Workspace view")
            .child(tab("tab-agent", "Agent", View::Agent))
            .child(tab("tab-workspace", "Workspace", View::Workspace)),
        &t.track_inner,
    )
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

fn separator(t: &Theme) -> El {
    el().w_full().h(1.0).my(6.0).fill(t.border)
}

/// The menu open over the sidebar, if any, anchored to its trigger.
pub fn menus(s: &App, t: &Theme) -> Option<El> {
    let width = if s.sidebar_open { SIDEBAR_WIDTH - 16.0 } else { 256.0 };
    let side = if s.sidebar_open { Side::Bottom } else { Side::Right };
    match s.menu? {
        Menu::Businesses => {
            let mut m = menu(t, "business-menu", width).child(label("Businesses", type_::XS, t.muted_foreground).px(8.0).py(6.0));
            for b in &s.businesses {
                let id = b.id.clone();
                m = m.child(
                    menu_row(t, format!("business-{}", b.id), business_mark(t, Some(&b.name), 24.0, 6.0), &b.name, s.active.as_deref() == Some(b.id.as_str()))
                        .on_press(move |s: &mut App| {
                            s.select_business(&id);
                            s.show_view(View::Agent);
                        }),
                );
            }
            if s.businesses.is_empty() {
                m = m.child(label("No businesses yet. Set one up on the web.", type_::SM_13, t.muted_foreground).px(8.0).py(6.0).wrap());
            }
            Some(m.role("menu").anchored("business-switcher", side, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None))
        }
        Menu::Account => {
            let email = s.account_email.clone().unwrap_or_else(|| "Signed in".into());
            let name = email.split('@').next().unwrap_or(&email).to_string();
            let head = row()
                .px(10.0)
                .py(10.0)
                .gap(12.0)
                .center_y()
                .child(avatar_sphere(t, 36.0))
                .child(col().min_w(0.0).child(label(name, type_::XS_MEDIUM, t.foreground).truncate()).child(label(email, type_::XS, t.muted_foreground).truncate()));
            let api = std::env::var(crate::state::API_ENV).unwrap_or_else(|_| crate::state::DEFAULT_API.into());
            let m = menu(t, "account-menu-list", width)
                .child(head)
                .child(separator(t))
                .child(menu_row(t, "open-web".into(), ico(&icons::EXTERNAL_LINK, 16.0, t.muted_foreground), "Open in the browser", false).on_press_tx(move |s: &mut App, tx| {
                    s.menu = None;
                    let _ = tx.open_url(&web_url(&api));
                }))
                .child(menu_row(t, "refresh-all".into(), ico(&icons::REFRESH_CW, 16.0, t.muted_foreground), "Refresh", false).on_press(|s: &mut App| {
                    s.menu = None;
                    s.refresh();
                }))
                .child(separator(t))
                .child(menu_row(t, "sign-out".into(), ico(&icons::LOG_OUT, 16.0, t.muted_foreground), "Sign out", false).on_press(|s: &mut App| s.sign_out()));
            let side = if s.sidebar_open { Side::Top } else { Side::Right };
            Some(m.role("menu").anchored("account-menu", side, Align::Start, 8.0).modal(true, |s: &mut App| s.menu = None))
        }
    }
}

/// The web app for an API address: the dev server serves it on :3000 beside the API on :3001.
fn web_url(api: &str) -> String {
    if let Ok(web) = std::env::var("OPENRECORD_WEB_URL") {
        return web;
    }
    api.replace(":3001", ":3000")
}
