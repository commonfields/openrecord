//! The panel on the right of the workspace: tabs for what opened beside the
//! chat (an artifact, a helper session, the browser, analytics, the chat's
//! files and what changed in them). Each chat keeps its own panel. It folds
//! away with its own button (⌥⌘B), and can widen over the whole split.

use rune::{TextEdit, Tx};

use crate::native_preview::{self, BrowserCommand};
use crate::state::{App, Page, Screen, View};

/// One of the panel's tabs. The browser's tabs come first once a page has
/// been opened; the rest follow in the order they were opened. A panel with
/// nothing chosen shows the list to choose from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SideTab {
    /// The list of what can open beside the chat: browser, changes, files, analytics.
    #[default]
    Launcher,
    Browser,
    Artifact(String),
    Helper(String),
    Analytics,
    CampaignBrief,
    Page(Page),
    Files,
    Changes,
}

/// What can be opened from the list, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    Browser,
    Changes,
    Files,
    Analytics,
    Campaigns,
}

impl Launch {
    pub const ALL: [Launch; 5] = [Launch::Browser, Launch::Changes, Launch::Files, Launch::Analytics, Launch::Campaigns];
}

/// One chat's panel while another chat is on screen.
#[derive(Default)]
pub struct SideState {
    open: bool,
    front: SideTab,
    items: Vec<SideTab>,
    wide: bool,
    for_item: bool,
    browser: Browser,
    diff: Option<crate::changes::Diff>,
    artifacts: Vec<crate::artifacts::Pane>,
    helpers: Vec<(String, crate::state::Load<crate::api::Conversation>)>,
}

pub struct SidePanel {
    pub open: bool,
    /// The tab chosen to be in front.
    pub front: SideTab,
    /// The chat's tabs after the browser, in the order they opened.
    pub items: Vec<SideTab>,
    /// Widened over the whole split, the chat out of view.
    pub wide: bool,
    /// Opened by an artifact or helper rather than by the person: it folds away
    /// again when the last of them closes, instead of falling back to the browser.
    pub for_item: bool,
    pub browser: Browser,
    /// The panel's own chat box, under an artifact or helper.
    pub composer: TextEdit,
    /// The browser's address when the panel was last drawn, to redraw when a page moves on.
    pub seen_url: Option<String>,
    /// Whether that page was light, to redraw the chat box over it when it changes.
    pub seen_light: Option<bool>,
    /// The chat this panel belongs to (`App::side_key`), and the other chats' panels.
    pub owner: String,
    pub stash: std::collections::HashMap<String, SideState>,
    /// The last browser tab number given out, across every chat's panel.
    pub web_ids: u32,
    /// The change open in the Changes tab.
    pub diff: Option<crate::changes::Diff>,
}

#[derive(Default)]
pub struct Browser {
    /// The address bar while it is being typed in.
    pub address: TextEdit,
    pub editing: bool,
    /// The page asked for last; the browser itself knows where it is now.
    pub url: Option<String>,
    /// To load once the view has a place on screen.
    pub pending: Option<String>,
    /// Pages opened this session, newest first.
    pub recents: Vec<String>,
    /// Where the page is drawn, in window points.
    pub rect: Option<[f32; 4]>,
    /// The landing page the browser was asked to show: an artifact from the chat.
    pub artifact: Option<String>,
    /// The page's zoom, apart from the app's (1 is 100%; 0 reads as 1).
    pub zoom: f32,
    /// This tab's number; the others wait in `parked`, in `order` on the strip.
    pub id: u32,
    pub parked: Vec<WebTab>,
    pub order: Vec<u32>,
    /// The browser has been opened in this chat's panel, so its tabs show.
    pub shown: bool,
}

/// A browser tab not in front: what it shows, kept until it comes back.
pub struct WebTab {
    pub id: u32,
    pub url: Option<String>,
    pub artifact: Option<String>,
    pub zoom: f32,
    /// Its name on the strip.
    pub title: String,
}

pub const ZOOMS: [f32; 9] = [0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];

impl Default for SidePanel {
    fn default() -> Self {
        Self {
            open: false,
            front: SideTab::Launcher,
            items: Vec::new(),
            wide: false,
            for_item: false,
            browser: Browser::default(),
            composer: TextEdit::default(),
            seen_url: None,
            seen_light: None,
            owner: String::new(),
            stash: Default::default(),
            web_ids: 0,
            diff: None,
        }
    }
}

const RECENTS: usize = 8;

impl App {
    /// The chat's artifacts and helpers can show: they belong to the chat on screen.
    fn side_items_here(&self) -> bool {
        (self.view == View::Agent || self.campaign_editor.is_some()) && (self.active.is_some() || self.general)
    }

    /// The tabs after the browser, when they can show.
    pub fn side_items(&self) -> &[SideTab] {
        if self.side_items_here() { &self.side.items } else { &[] }
    }

    /// An artifact or helper is there to show.
    pub fn side_item(&self) -> bool {
        !self.side_items().is_empty()
    }

    pub fn side_shown(&self) -> bool {
        self.screen == Screen::Workspace && self.side.open && (!self.side.for_item || self.side_item())
    }

    /// The tab in front: the chosen one while it is there, else the last one
    /// opened, the browser, or the list to choose from.
    pub fn side_tab(&self) -> SideTab {
        let f = &self.side.front;
        match f {
            SideTab::Launcher => return SideTab::Launcher,
            SideTab::Browser if self.side.browser.shown => return SideTab::Browser,
            _ if self.side_items().contains(f) => return f.clone(),
            _ => {}
        }
        if let Some(last) = self.side_items().last() {
            last.clone()
        } else if self.side.browser.shown {
            SideTab::Browser
        } else {
            SideTab::Launcher
        }
    }

    pub fn front_artifact(&self) -> Option<&crate::artifacts::Pane> {
        match self.side_tab() {
            SideTab::Artifact(id) => self.artifacts.iter().find(|p| p.id == id),
            _ => None,
        }
    }

    /// What a turn tells the agent is open beside the chat: with an artifact in
    /// front of the panel, that one first, then the chat's other open artifacts.
    pub fn viewing_artifacts(&self) -> Vec<String> {
        if !self.side_shown() {
            return Vec::new();
        }
        // A landing page open in the browser is what the person is looking at.
        let front = match self.side_tab() {
            SideTab::Artifact(id) => id,
            SideTab::Browser => match self.browser_artifact() {
                Some(p) => p.id.clone(),
                None => return Vec::new(),
            },
            _ => return Vec::new(),
        };
        let rest = self.side_items().iter().filter_map(|t| match t {
            SideTab::Artifact(id) if *id != front => Some(id.clone()),
            _ => None,
        });
        std::iter::once(front.clone()).chain(rest).take(8).collect()
    }

    pub fn front_artifact_mut(&mut self) -> Option<&mut crate::artifacts::Pane> {
        match self.side_tab() {
            SideTab::Artifact(id) => self.artifacts.iter_mut().find(|p| p.id == id),
            _ => None,
        }
    }

    pub fn front_helper(&self) -> Option<&(String, crate::state::Load<crate::api::Conversation>)> {
        match self.side_tab() {
            SideTab::Helper(id) => self.helpers.iter().find(|(h, _)| *h == id),
            _ => None,
        }
    }

    pub fn toggle_side(&mut self) {
        self.side.open = !self.side_shown();
        self.side.for_item = false;
        if !self.side.open {
            self.side.wide = false;
            self.side.browser.editing = false;
        }
    }

    /// The list of what can open beside the chat, in front (the + after the tabs).
    pub fn open_launcher(&mut self) {
        self.side.open = true;
        self.side.for_item = false;
        self.side.front = SideTab::Launcher;
        self.side.browser.editing = false;
    }

    /// Opens what was picked from the list. The browser opens a new tab when
    /// one already shows a page; the others are one tab each.
    pub fn launch(&mut self, what: Launch) {
        let tab = match what {
            Launch::Browser => {
                if self.side.browser.shown && self.side.browser.url.is_some() {
                    self.new_web_tab();
                } else {
                    self.show_browser_tab();
                }
                return;
            }
            Launch::Campaigns => {
                let Some(business) = self.active.clone().filter(|_| !self.general) else { return };
                if matches!(self.campaigns, crate::state::Load::Idle | crate::state::Load::Failed(_)) {
                    self.campaigns = crate::state::Load::Loading;
                    self.net.campaigns(business);
                }
                if !self.side.items.contains(&SideTab::Page(Page::Campaigns)) {
                    self.campaign_open = None;
                }
                self.show_view(View::Agent);
                self.open_page_tab(Page::Campaigns);
                return;
            }
            Launch::Changes => SideTab::Changes,
            Launch::Files => SideTab::Files,
            Launch::Analytics => {
                if let (Some(id), crate::state::Load::Idle) = (self.active.clone(), &self.insights) {
                    self.insights = crate::state::Load::Loading;
                    self.net.insights(id, self.days);
                }
                SideTab::Analytics
            }
        };
        if !self.side.items.contains(&tab) {
            self.side.items.push(tab.clone());
        }
        self.side.open = true;
        self.side.for_item = false;
        self.side.front = tab;
    }

    /// Which chat the panel belongs to: the business (or general) and the chat,
    /// or a new chat before its first message.
    pub fn side_key(&self) -> String {
        let scope = self.chat_scope().unwrap_or_else(|| "-".into());
        format!("{scope}:{}", self.chat_id.as_deref().unwrap_or("new"))
    }

    /// A new chat just got its id: its panel goes with it.
    pub fn adopt_side(&mut self) {
        self.side.owner = self.side_key();
    }

    /// Another chat came on screen: the last one's panel is put away with its
    /// tabs, pages and zoom, and this one's comes back (closed if it had none).
    pub fn switch_side(&mut self) {
        let key = self.side_key();
        if key == self.side.owner {
            return;
        }
        let b = &self.side.browser;
        let top = b.parked.iter().map(|p| p.id).chain(b.order.iter().copied()).chain([b.id]).max().unwrap_or(0);
        self.side.web_ids = self.side.web_ids.max(top);
        let recents = std::mem::take(&mut self.side.browser.recents);
        let away = SideState {
            open: self.side.open,
            front: std::mem::take(&mut self.side.front),
            items: std::mem::take(&mut self.side.items),
            wide: self.side.wide,
            for_item: self.side.for_item,
            browser: std::mem::take(&mut self.side.browser),
            diff: self.side.diff.take(),
            artifacts: std::mem::take(&mut self.artifacts),
            helpers: std::mem::take(&mut self.helpers),
        };
        let old = std::mem::replace(&mut self.side.owner, key.clone());
        self.side.stash.insert(old, away);
        let back = match self.side.stash.remove(&key) {
            Some(st) => st,
            None => {
                self.side.web_ids += 1;
                SideState { browser: Browser { id: self.side.web_ids, zoom: 1.0, ..Browser::default() }, ..SideState::default() }
            }
        };
        self.side.open = back.open;
        self.side.front = back.front;
        self.side.items = back.items;
        self.side.wide = back.wide;
        self.side.for_item = back.for_item;
        self.side.browser = back.browser;
        self.side.diff = back.diff;
        self.artifacts = back.artifacts;
        self.helpers = back.helpers;
        let b = &mut self.side.browser;
        b.recents = recents;
        b.editing = false;
        // Its page is kept natively; this reloads it only if it was lost.
        b.pending = b.url.clone();
        native_preview::browser_select(b.id);
        self.side.seen_url = None;
        self.side.seen_light = None;
    }

    pub fn show_tab(&mut self, tab: SideTab) {
        if let SideTab::Page(page) = &tab { self.page = *page; }
        self.side.front = tab;
    }

    /// Brings a tab forward, opening the panel for it if it was folded.
    fn show_side_item(&mut self, tab: SideTab) {
        if !self.side_shown() {
            self.side.open = true;
            self.side.for_item = true;
        }
        self.side.front = tab;
    }

    /// Keeps the originating workspace page beside the new main chat.
    pub fn open_page_tab(&mut self, page: Page) {
        let tab = SideTab::Page(page);
        if !self.side.items.contains(&tab) { self.side.items.push(tab.clone()); }
        self.page = page;
        self.side.wide = false;
        self.show_side_item(tab);
    }

    pub fn open_campaign_document(&mut self) {
        let tab = SideTab::CampaignBrief;
        if !self.side.items.contains(&tab) { self.side.items.push(tab.clone()); }
        self.side.wide = false;
        self.show_side_item(tab);
    }

    pub fn open_channel_connections(&mut self) {
        self.chat_actions = false;
        self.open_page_tab(Page::Channels);
        if !self.general {
            if let Some(business) = self.active.clone() {
                if !matches!(self.channel_status, crate::state::Load::Ready(_) | crate::state::Load::Loading) {
                    self.channel_status = crate::state::Load::Loading;
                    self.net.channel_status(business.clone());
                }
                if !matches!(self.channels, crate::state::Load::Ready(_) | crate::state::Load::Loading) {
                    self.channels = crate::state::Load::Loading;
                    self.net.channels(business);
                }
            }
        }
    }

    /// Adds an artifact's tab (or brings it forward when it is already open).
    /// True when it is new and has to be read.
    pub fn add_artifact_tab(&mut self, pane: crate::artifacts::Pane) -> bool {
        let tab = SideTab::Artifact(pane.id.clone());
        let new = !self.side.items.contains(&tab);
        if new {
            self.artifacts.retain(|p| p.id != pane.id);
            self.artifacts.push(pane);
            self.side.items.push(tab.clone());
        }
        self.show_side_item(tab);
        new
    }

    /// Adds a helper session's tab, or brings it forward. True when it is new.
    pub fn add_helper_tab(&mut self, id: &str, load: crate::state::Load<crate::api::Conversation>) -> bool {
        let tab = SideTab::Helper(id.to_string());
        let new = !self.side.items.contains(&tab);
        if new {
            self.helpers.retain(|(h, _)| h != id);
            self.helpers.push((id.to_string(), load));
            self.side.items.push(tab.clone());
        }
        self.show_side_item(tab);
        new
    }

    /// Closes one tab; the one before it comes forward. A panel opened only
    /// for the chat's tabs folds away with the last of them.
    pub fn close_tab(&mut self, tab: &SideTab) {
        if *tab == SideTab::CampaignBrief {
            if let Some(editor) = &mut self.campaign_editor {
                if editor.busy || editor.dirty() {
                    editor.error = Some("Save or discard this brief before closing it.".into());
                    self.side.open = true;
                    self.side.front = SideTab::CampaignBrief;
                    return;
                }
            }
            self.campaign_editor = None;
        }
        if *tab == SideTab::Launcher {
            // Back to what was in front before; with nothing else, the panel folds.
            self.side.front = self.side.items.last().cloned().unwrap_or(SideTab::Browser);
            if self.side.items.is_empty() && !self.side.browser.shown {
                self.side.open = false;
                self.side.wide = false;
            }
            return;
        }
        if *tab == SideTab::Browser {
            let id = self.side.browser.id;
            self.close_web_tab(id);
            return;
        }
        let Some(i) = self.side.items.iter().position(|x| x == tab) else { return };
        self.side.items.remove(i);
        match tab {
            SideTab::Artifact(id) => self.artifacts.retain(|p| &p.id != id),
            SideTab::Helper(id) => self.helpers.retain(|(h, _)| h != id),
            SideTab::Changes => self.side.diff = None,
            _ => {}
        }
        if &self.side.front == tab {
            self.side.front = if i > 0 { self.side.items[i - 1].clone() } else { self.side.items.first().cloned().unwrap_or(SideTab::Browser) };
        }
        if self.side.items.is_empty() && (self.side.for_item || !self.side.browser.shown) {
            self.side.open = false;
            self.side.wide = false;
        }
    }

    /// Escape: closes the artifact or helper in front.
    pub fn close_side_item(&mut self) {
        let tab = self.side_tab();
        self.close_tab(&tab);
    }

    pub fn show_browser_tab(&mut self) {
        self.side.open = true;
        self.side.for_item = false;
        self.side.front = SideTab::Browser;
        if !self.side.browser.shown {
            self.side.browser.shown = true;
            self.side.browser.zoom = 1.0;
        }
    }

    /// Sends what the panel's chat box holds to the chat, naming a helper in
    /// front so the agent knows what it is about (an artifact goes with the turn). Queued behind a turn under way.
    pub fn send_side(&mut self, tx: &mut Tx) {
        let text = self.side.composer.text.trim().to_string();
        if text.is_empty() || self.model_unavailable() {
            return;
        }
        let about = match self.side_tab() {
            // The turn names the artifact in front itself (`viewing_artifacts`).
            SideTab::Artifact(_) => text,
            SideTab::Helper(id) => {
                let title = self.front_helper().and_then(|(_, l)| l.ready()).and_then(|c| c.session.as_ref()).and_then(|i| i.title.clone()).unwrap_or_else(|| "helper".into());
                format!("About the helper \"{title}\" (session {id}): {text}")
            }
            _ => text,
        };
        self.side.composer.clear();
        if matches!(self.turn, crate::state::Turn::Working { .. }) {
            self.steer_or_queue(about);
        } else {
            self.dispatch(about, tx);
        }
    }

    /// The browser's side of the poll: redraws when its page moves on, so the
    /// address bar and back and forward follow. Checked often while it shows.
    pub fn poll_native(&mut self, tx: &mut Tx) -> bool {
        let mut changed = false;
        // Feedforward waits for a pause in typing: note each change, and look
        // again once the pause would be over.
        if self.composer_seen.0 != self.composer.text {
            self.composer_seen = (self.composer.text.clone(), std::time::Instant::now());
        }
        if !self.composer.text.trim().is_empty() && matches!(self.turn, crate::state::Turn::Idle) {
            let waited = self.composer_seen.1.elapsed();
            if waited < App::PAUSE {
                tx.wake_after(App::PAUSE - waited + std::time::Duration::from_millis(20));
            } else if waited < App::PAUSE + std::time::Duration::from_millis(400) {
                changed = true;
            }
        }
        // The address bar goes back to the page's name once the person clicks
        // anywhere else: elsewhere in the app takes its focus, and a click on
        // the page itself is told by the browser.
        if self.side.browser.editing {
            let clicked = native_preview::browser_take_click();
            if clicked || !self.side.browser.address.focused {
                self.side.browser.editing = false;
                if clicked {
                    tx.blur();
                }
                changed = true;
            } else {
                tx.wake_after(std::time::Duration::from_millis(120));
            }
        }
        if self.browser_visible() {
            let now = native_preview::browser_url();
            if now != self.side.seen_url {
                self.side.seen_url = now;
                changed = true;
            }
            let light = native_preview::browser_page_light();
            if light != self.side.seen_light {
                self.side.seen_light = light;
                changed = true;
            }
            tx.wake_after(std::time::Duration::from_millis(400));
        }
        changed
    }

    /// Nothing app-drawn (a menu, a dialog) is over the panel, so a native view may show.
    pub fn native_view_clear(&self) -> bool {
        self.settings.is_none()
            && self.menu.is_none()
            && self.find.is_none()
            && self.new_chat.is_none()
            && !self.chat_actions
            && !self.notices_open
            && self.share.is_none()
            && self.save_playbook.is_none()
            && self.add_business.is_none()
            && self.menu_entries().is_empty()
    }

    /// A page is open in the browser tab in front: it runs to the panel's foot.
    pub fn browser_page_shown(&self) -> bool {
        self.side_shown() && self.side_tab() == SideTab::Browser && self.side.browser.url.is_some()
    }

    /// The page is drawn behind the app, so a menu or dialog the app opens
    /// draws over it: it stays in view, and only gives the app back its clicks.
    pub fn browser_visible(&self) -> bool {
        self.side_shown() && self.side_tab() == SideTab::Browser && self.side.browser.url.is_some()
    }

    /// The browser's tabs on the strip, in order: number, name, and whether in front.
    pub fn web_tabs(&self) -> Vec<(u32, String, bool)> {
        let b = &self.side.browser;
        let order = if b.order.is_empty() { vec![b.id] } else { b.order.clone() };
        order
            .into_iter()
            .map(|id| {
                if id == b.id {
                    (id, self.web_tab_title(), true)
                } else {
                    (id, b.parked.iter().find(|p| p.id == id).map(|p| p.title.clone()).unwrap_or_else(|| "New tab".into()), false)
                }
            })
            .collect()
    }

    /// The tab in front's name: the landing page's title, the site, or "New tab".
    fn web_tab_title(&self) -> String {
        let b = &self.side.browser;
        if let Some(a) = b.artifact.as_deref().and_then(|id| self.artifacts.iter().find(|p| p.id == id)).and_then(|p| p.loaded.ready()) {
            return a.title.clone();
        }
        match &b.url {
            Some(u) => crate::ui::side::host(&native_preview::browser_url().unwrap_or_else(|| u.clone())),
            None => "Browser".into(),
        }
    }

    fn park_web_tab(&mut self) {
        let title = self.web_tab_title();
        let b = &mut self.side.browser;
        if b.order.is_empty() {
            b.order.push(b.id);
        }
        b.parked.push(WebTab { id: b.id, url: b.url.take(), artifact: b.artifact.take(), zoom: b.zoom, title });
        b.pending = None;
        b.editing = false;
    }

    fn unpark_web_tab(&mut self, id: u32) {
        let b = &mut self.side.browser;
        let tab = b.parked.iter().position(|p| p.id == id).map(|i| b.parked.remove(i));
        b.id = id;
        b.url = tab.as_ref().and_then(|t| t.url.clone());
        b.artifact = tab.as_ref().and_then(|t| t.artifact.clone());
        b.zoom = tab.as_ref().map(|t| t.zoom).unwrap_or(1.0);
        // Its page is kept natively; this reloads it only if it was lost.
        b.pending = b.url.clone();
        native_preview::browser_select(id);
    }

    /// A new, empty browser tab in front.
    pub fn new_web_tab(&mut self) {
        if !self.side.browser.shown {
            self.show_browser_tab();
            return;
        }
        self.park_web_tab();
        let b = &mut self.side.browser;
        let top = b.order.iter().copied().chain([b.id]).max().unwrap_or(0);
        self.side.web_ids = self.side.web_ids.max(top) + 1;
        let id = self.side.web_ids;
        let b = &mut self.side.browser;
        b.order.push(id);
        b.id = id;
        b.zoom = 1.0;
        b.address.clear();
        native_preview::browser_select(id);
        self.show_browser_tab();
    }

    pub fn select_web_tab(&mut self, id: u32) {
        if id != self.side.browser.id {
            self.park_web_tab();
            self.unpark_web_tab(id);
        }
        self.show_browser_tab();
    }

    /// Closes a browser tab; the last one only goes back to its start list.
    pub fn close_web_tab(&mut self, id: u32) {
        let order = self.web_tabs().into_iter().map(|t| t.0).collect::<Vec<_>>();
        if order.len() <= 1 {
            // The last one closes the browser; the panel shows what else is open.
            self.browser_home();
            self.side.browser.shown = false;
            self.side.browser.zoom = 1.0;
            if self.side_items().is_empty() {
                self.side.open = false;
                self.side.wide = false;
            }
            return;
        }
        let at = order.iter().position(|&x| x == id).unwrap_or(0);
        self.side.browser.order.retain(|&x| x != id);
        if id == self.side.browser.id {
            native_preview::browser_drop(id);
            let next = order[if at > 0 { at - 1 } else { 1 }];
            self.unpark_web_tab(next);
        } else {
            self.side.browser.parked.retain(|p| p.id != id);
            native_preview::browser_drop(id);
        }
    }

    /// Zooms the page by a step (or back to 100% with 0), leaving the app as it is.
    pub fn zoom_page(&mut self, step: i32) {
        let b = &mut self.side.browser;
        let now = if b.zoom > 0.0 { b.zoom } else { 1.0 };
        b.zoom = if step == 0 {
            1.0
        } else {
            let i = ZOOMS.iter().position(|z| (z - now).abs() < 0.01).unwrap_or(4) as i32;
            ZOOMS[(i + step).clamp(0, ZOOMS.len() as i32 - 1) as usize]
        };
    }

    /// Loads the app's own copy of a page in the browser, kept out of recents.
    pub fn browser_open_page(&mut self, url: &str) {
        let b = &mut self.side.browser;
        b.editing = false;
        b.url = Some(url.to_string());
        match self.side.browser.rect {
            Some(r) if self.browser_visible() => native_preview::browser_show(Some(url), r),
            _ => self.side.browser.pending = Some(url.to_string()),
        }
    }

    /// Opens what the address bar holds: an address, a host, or a search.
    pub fn browser_go(&mut self, input: &str) {
        let Some(url) = native_preview::browser_target(input) else { return };
        let b = &mut self.side.browser;
        b.artifact = None;
        b.editing = false;
        b.recents.retain(|u| u != &url);
        b.recents.insert(0, url.clone());
        b.recents.truncate(RECENTS);
        b.url = Some(url.clone());
        match self.side.browser.rect {
            Some(r) if self.browser_visible() => native_preview::browser_show(Some(&url), r),
            _ => self.side.browser.pending = Some(url),
        }
    }

    pub fn browser_command(&mut self, c: BrowserCommand) {
        if self.side.browser.url.is_some() {
            native_preview::browser_command(c);
        }
    }

    /// The address bar takes the keys, holding the page's address to edit.
    pub fn edit_address(&mut self, tx: &mut Tx) {
        let now = native_preview::browser_url().or_else(|| self.side.browser.url.clone()).unwrap_or_default();
        let n = now.len();
        self.side.browser.address.replace_text(now);
        self.side.browser.address.set_selection(0, n);
        // Asked for here so the field is built focused; the runtime clears it
        // when focus moves elsewhere.
        self.side.browser.address.focused = true;
        native_preview::browser_take_click();
        self.side.browser.editing = true;
        tx.focus("browser-address", false);
    }

    /// Back to the start list, the page put away.
    pub fn browser_home(&mut self) {
        let b = &mut self.side.browser;
        b.url = None;
        b.artifact = None;
        b.pending = None;
        b.editing = false;
        native_preview::browser_close();
    }
}

#[cfg(test)]
mod steer_tests {
    use crate::state::{App, Turn};

    #[test]
    fn a_message_sent_while_the_agent_works_goes_to_the_run_and_unread_ones_go_next() {
        let mut s = App::new();
        crate::fixtures::agent_working(&mut s);
        s.queued.clear();
        s.steer_or_queue("Only the pricing page".into());
        assert_eq!(s.steer.len(), 1, "steered, not queued");
        assert!(s.queued.is_empty());
        // A slash command still waits for the turn to end.
        s.steer_or_queue("/summary".into());
        assert_eq!(s.queued, vec!["/summary".to_string()]);
        // The run reads the first; a second it never reads goes out next, ahead of the queue.
        s.steer[0].id = Some("n1".into());
        if let Turn::Working { progress, .. } = &mut s.turn {
            progress.apply(&[crate::chat::RunEvent { seq: 9, kind: "VERIFICATION".into(), payload: serde_json::json!({ "action": "NOTES_READ", "noteIds": ["n1"] }) }]);
            assert_eq!(progress.notes_read, vec!["n1".to_string()]);
        }
        s.steer[0].read = true;
        s.steer_or_queue("One paragraph".into());
        s.settle_steer_for_test();
        assert!(s.steer.is_empty());
        assert_eq!(s.queued, vec!["One paragraph".to_string(), "/summary".to_string()]);
    }

    #[test]
    fn answering_a_question_mid_turn_reaches_the_run_and_marks_it_answered() {
        let mut s = App::new();
        crate::fixtures::agent_working(&mut s);
        s.queued.clear();
        let b = crate::chat::Blank { id: "b1".into(), question: "Who is the page for?".into(), options: vec!["Agencies".into()], assumed: "Marketing leads".into() };
        assert_eq!(s.blank_answer(&b), None);
        s.blank_answers.clear();
        // Picked through the run: it goes as a note, and reads as answered.
        s.steer_or_queue(b.answer_text("Agencies"));
        assert_eq!(s.steer[0].text, "For «Who is the page for?»: Agencies");
        assert_eq!(s.blank_answer(&b).as_deref(), Some("Agencies"));
    }

    #[test]
    fn a_turn_being_stopped_queues_instead() {
        let mut s = App::new();
        crate::fixtures::agent_working(&mut s);
        if let Turn::Working { stopping, .. } = &mut s.turn {
            *stopping = true;
        }
        s.steer_or_queue("Never mind".into());
        assert!(s.steer.is_empty());
        assert_eq!(s.queued.last().map(String::as_str), Some("Never mind"));
    }
}

#[cfg(test)]
mod tests {
    use super::SideTab;
    use crate::state::{App, Load};

    #[test]
    fn connecting_channels_opens_one_tab_without_replacing_the_chat_or_draft() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        let chat = s.chat_id.clone();
        s.composer.replace_text("Keep this draft");
        s.chat_actions = true;
        s.open_channel_connections();
        s.open_channel_connections();
        assert!(!s.chat_actions);
        assert_eq!(s.chat_id, chat);
        assert_eq!(s.composer.text, "Keep this draft");
        assert_eq!(s.view, crate::state::View::Agent);
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Channels));
        assert_eq!(s.side_items().len(), 1);
        assert!(s.side_shown());
    }

    fn pane(id: &str) -> crate::artifacts::Pane {
        crate::artifacts::Pane { business: "b1".into(), id: id.into(), requested: None, loaded: Load::Loading, source: false }
    }

    #[test]
    fn asking_from_a_page_starts_a_fresh_main_chat_and_keeps_the_page_in_a_tab() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.chat_id = Some("existing-chat".into());
        s.adopt_side();
        s.add_helper_tab("existing-helper", Load::Loading);
        s.view = crate::state::View::Workspace;
        s.page = crate::state::Page::Campaigns;
        s.campaign_open = Some("campaign-123".into());
        let sidebar_was_open = s.sidebar_open;
        s.sync_draft();
        let old_draft = s.draft_key.clone();
        s.composer.replace_text("Unsent text for the previous chat");
        s.ask_agent("Prepare this campaign brief");
        assert_eq!(s.view, crate::state::View::Agent);
        assert!(s.chat_id.is_none());
        assert!(matches!(s.conversation, Load::Idle));
        assert!(matches!(s.turn, crate::state::Turn::Idle));
        s.sync_draft();
        assert_eq!(s.composer.text, "Prepare this campaign brief");
        assert_eq!(s.drafts.get(&old_draft), "Unsent text for the previous chat");
        assert_eq!(s.campaign_open.as_deref(), Some("campaign-123"));
        assert_eq!(s.sidebar_open, sidebar_was_open);
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
        assert!(s.side_shown());
        assert!(!s.side.wide);
        // Assigning the server's new session id must keep its page tab.
        s.chat_id = Some("created-chat".into());
        s.adopt_side();
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
        // The previous chat keeps its own tabs.
        s.chat_id = Some("existing-chat".into());
        s.switch_side();
        assert_eq!(s.side_tab(), SideTab::Helper("existing-helper".into()));
        s.chat_id = Some("created-chat".into());
        s.switch_side();
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
        s.close_tab(&s.side_tab());
        assert!(!s.side_shown());
        assert_eq!(s.view, crate::state::View::Agent);
    }

    #[test]
    fn asking_from_a_page_already_in_the_panel_keeps_it_with_the_new_chat() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.chat_id = Some("current-chat".into());
        s.adopt_side();
        s.open_page_tab(crate::state::Page::Campaigns);
        s.ask_agent("Review this campaign");
        s.sync_draft();
        assert!(s.chat_id.is_none());
        assert_eq!(s.view, crate::state::View::Agent);
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
        assert_eq!(s.composer.text, "Review this campaign");
    }

    #[test]
    fn analytics_navigation_in_the_source_tab_keeps_the_main_chat_visible() {
        let mut s = App::new();
        crate::fixtures::overview(&mut s);
        s.ask_agent("Plan the next step");
        s.show_section(crate::insights::Section::Revenue);
        assert_eq!(s.view, crate::state::View::Agent);
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Overview));
        assert_eq!(s.section, crate::insights::Section::Revenue);
    }

    #[test]
    fn launching_campaigns_keeps_the_current_chat_and_reuses_its_tab() {
        let mut s = App::new();
        crate::fixtures::campaigns(&mut s);
        s.chat_id = Some("current-chat".into());
        s.launch(super::Launch::Campaigns);
        assert_eq!(s.view, crate::state::View::Agent);
        assert_eq!(s.chat_id.as_deref(), Some("current-chat"));
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
        assert!(s.side_shown());
        s.campaign_open = Some("cp1".into());
        s.launch(super::Launch::Campaigns);
        assert_eq!(s.side.items.len(), 1);
        assert_eq!(s.campaign_open.as_deref(), Some("cp1"));
    }

    #[test]
    fn launching_campaigns_requires_a_business_chat() {
        let mut s = App::new();
        s.launch(super::Launch::Campaigns);
        assert!(s.side.items.is_empty());
        crate::fixtures::agent(&mut s);
        s.general = true;
        s.launch(super::Launch::Campaigns);
        assert!(s.side.items.is_empty());
    }

    #[test]
    fn only_home_and_startup_enable_the_animated_starters() {
        let mut s = App::new();
        assert!(s.home);
        crate::fixtures::agent_empty(&mut s);
        s.new_chat();
        assert!(!s.home);
        s.go_home();
        assert!(s.home);
        s.start_chat(s.active.clone());
        assert!(!s.home);
        s.go_home();
        s.view = crate::state::View::Workspace;
        s.page = crate::state::Page::Campaigns;
        s.ask_agent("Plan this campaign");
        assert!(!s.home);
    }

    #[test]
    fn the_only_browser_tab_can_close_and_preserve_other_panel_tabs() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.launch(super::Launch::Browser);
        let id = s.side.browser.id;
        s.close_web_tab(id);
        assert!(!s.side.browser.shown);
        assert!(!s.side_shown());
        s.launch(super::Launch::Campaigns);
        s.launch(super::Launch::Browser);
        let id = s.side.browser.id;
        s.close_web_tab(id);
        assert!(!s.side.browser.shown);
        assert!(s.side_shown());
        assert_eq!(s.side_tab(), SideTab::Page(crate::state::Page::Campaigns));
    }

    #[test]
    fn composer_menu_commands_prepare_the_current_draft_without_sending() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.composer.replace_text("Improve qualified demo requests");
        let chat = s.chat_id.clone();
        s.prepare_composer_command("plan");
        assert_eq!(s.composer.text, "/plan Improve qualified demo requests");
        assert_eq!(s.chat_id, chat);
        assert!(matches!(s.turn, crate::state::Turn::Idle));
        assert!(s.queued.is_empty());
    }

    #[test]
    fn composer_menu_commands_use_the_composer_that_opened_the_menu() {
        let mut s = App::new();
        s.composer.replace_text("Keep this main draft");
        s.side.composer.replace_text("Refine this landing page");
        s.composer_slot = crate::state::ComposerSlot::Side;
        s.prepare_composer_command("campaign");
        assert_eq!(s.side.composer.text, "/campaign Refine this landing page");
        assert_eq!(s.composer.text, "Keep this main draft");
        let draft = s.side.composer.text.clone();
        s.prepare_composer_command("unsupported-command");
        assert_eq!(s.side.composer.text, draft);
    }

    #[test]
    fn a_helper_and_an_artifact_open_side_by_side_as_tabs_after_the_browser() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        assert!(s.add_helper_tab("h1", Load::Loading));
        assert!(s.add_artifact_tab(pane("a1")));
        // Neither replaces the other; the newest is in front, after the pinned browser.
        assert_eq!(s.side.items, vec![SideTab::Helper("h1".into()), SideTab::Artifact("a1".into())]);
        assert_eq!(s.side_tab(), SideTab::Artifact("a1".into()));
        assert!(s.side_shown());
        // Opening one again brings it forward instead of adding a second tab.
        assert!(!s.add_helper_tab("h1", Load::Loading));
        assert_eq!(s.side.items.len(), 2);
        assert_eq!(s.side_tab(), SideTab::Helper("h1".into()));
    }

    #[test]
    fn closing_a_tab_brings_its_neighbour_forward_and_the_last_folds_the_panel() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.add_helper_tab("h1", Load::Loading);
        s.add_artifact_tab(pane("a1"));
        s.close_side_item();
        assert_eq!(s.side_tab(), SideTab::Helper("h1".into()));
        assert!(s.artifacts.is_empty());
        s.close_side_item();
        assert!(!s.side_shown(), "opened for the chat's tabs, it folds with the last");
    }

    #[test]
    fn each_chat_keeps_its_own_panel() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.chat_id = Some("c1".into());
        s.switch_side();
        s.show_browser_tab();
        s.add_artifact_tab(pane("a1"));
        s.side.browser.zoom = 1.5;
        // Another chat opens with its panel closed and none of the first one's tabs.
        s.chat_id = Some("c2".into());
        s.switch_side();
        assert!(!s.side_shown());
        assert!(s.side.items.is_empty() && s.artifacts.is_empty());
        assert!(!s.side.browser.shown);
        // Back on the first chat, its panel is as it was left.
        s.chat_id = Some("c1".into());
        s.switch_side();
        assert!(s.side_shown());
        assert_eq!(s.side.items, vec![SideTab::Artifact("a1".into())]);
        assert!(s.side.browser.shown);
        assert_eq!(s.side.browser.zoom, 1.5);
    }

    #[test]
    fn opening_the_panel_lists_what_can_open_and_a_pick_takes_its_place() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.toggle_side();
        assert!(s.side_shown());
        assert_eq!(s.side_tab(), SideTab::Launcher);
        s.launch(super::Launch::Files);
        assert_eq!(s.side_tab(), SideTab::Files);
        // The + lists them again; picking the same one brings its tab forward.
        s.open_launcher();
        s.launch(super::Launch::Files);
        assert_eq!(s.side.items, vec![SideTab::Files]);
        // Closing the last tab folds the panel.
        s.close_side_item();
        assert!(!s.side_shown());
    }

    #[test]
    fn a_new_chat_keeps_its_panel_once_it_gets_an_id() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.chat_id = None;
        s.switch_side();
        s.launch(super::Launch::Analytics);
        s.chat_id = Some("c9".into());
        s.adopt_side();
        s.chat_id = Some("c1".into());
        s.switch_side();
        s.chat_id = Some("c9".into());
        s.switch_side();
        assert_eq!(s.side_tab(), SideTab::Analytics);
    }
}
