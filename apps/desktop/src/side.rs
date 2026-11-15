//! The panel on the right of the workspace: tabs for what opened beside the
//! chat (an artifact or a helper session) and a browser. It folds away with its
//! own button (⌥⌘B), and can widen over the whole split.

use rune::{TextEdit, Tx};

use crate::native_preview::{self, BrowserCommand};
use crate::state::{App, Screen, View};

/// Which of the panel's tabs is in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SideTab {
    /// What opened beside the chat: an artifact or a helper session.
    #[default]
    Item,
    Browser,
}

pub struct SidePanel {
    pub open: bool,
    pub tab: SideTab,
    /// Widened over the whole split, the chat out of view.
    pub wide: bool,
    /// Opened by an artifact or helper rather than by the person: it folds away
    /// again when that item goes, instead of falling back to the browser.
    pub for_item: bool,
    pub browser: Browser,
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
}

impl Default for SidePanel {
    fn default() -> Self {
        Self { open: false, tab: SideTab::Item, wide: false, for_item: false, browser: Browser::default() }
    }
}

const RECENTS: usize = 8;

impl App {
    /// An artifact or helper is there to show (they belong to the chat on screen).
    pub fn side_item(&self) -> bool {
        self.view == View::Agent && (self.active.is_some() || self.general) && (self.artifact.is_some() || self.helper.is_some())
    }

    pub fn side_shown(&self) -> bool {
        self.screen == Screen::Workspace && self.side.open && (!self.side.for_item || self.side_item())
    }

    /// The tab in front: the item's when there is one and it was chosen, else the browser.
    pub fn side_tab(&self) -> SideTab {
        if self.side.tab == SideTab::Item && self.side_item() { SideTab::Item } else { SideTab::Browser }
    }

    pub fn toggle_side(&mut self) {
        self.side.open = !self.side_shown();
        self.side.for_item = false;
        if !self.side.open {
            self.side.wide = false;
        }
    }

    /// Brings an artifact or helper forward, opening the panel for it if it was folded.
    pub fn show_side_item(&mut self) {
        if !self.side_shown() {
            self.side.open = true;
            self.side.for_item = true;
        }
        self.side.tab = SideTab::Item;
    }

    /// Closes the artifact or helper; a panel opened only for it folds away.
    pub fn close_side_item(&mut self) {
        self.artifact = None;
        self.helper = None;
        if self.side.for_item {
            self.side.open = false;
            self.side.wide = false;
        }
    }

    pub fn show_browser_tab(&mut self) {
        self.side.open = true;
        self.side.for_item = false;
        self.side.tab = SideTab::Browser;
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

    pub fn browser_visible(&self) -> bool {
        self.side_shown() && self.side_tab() == SideTab::Browser && self.side.browser.url.is_some() && self.native_view_clear()
    }

    /// Opens what the address bar holds: an address, a host, or a search.
    pub fn browser_go(&mut self, input: &str) {
        let Some(url) = native_preview::browser_target(input) else { return };
        let b = &mut self.side.browser;
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
        self.side.browser.editing = true;
        tx.focus("browser-address", false);
    }

    /// Back to the start list, the page put away.
    pub fn browser_home(&mut self) {
        let b = &mut self.side.browser;
        b.url = None;
        b.pending = None;
        b.editing = false;
        native_preview::browser_close();
    }
}
