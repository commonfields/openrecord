//! The panel on the right of the workspace: tabs for what opened beside the
//! chat (an artifact or a helper session) and a browser. It folds away with its
//! own button (⌥⌘B), and can widen over the whole split.

use rune::{TextEdit, Tx};

use crate::native_preview::{self, BrowserCommand};
use crate::state::{App, Screen, View};

/// One of the panel's tabs. The browser is always there, pinned first; the
/// artifacts and helper sessions opened from the chat follow it, in the order
/// they were opened.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SideTab {
    #[default]
    Browser,
    Artifact(String),
    Helper(String),
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
        Self { open: false, front: SideTab::Browser, items: Vec::new(), wide: false, for_item: false, browser: Browser::default(), composer: TextEdit::default(), seen_url: None }
    }
}

const RECENTS: usize = 8;

impl App {
    /// The chat's artifacts and helpers can show: they belong to the chat on screen.
    fn side_items_here(&self) -> bool {
        self.view == View::Agent && (self.active.is_some() || self.general)
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

    /// The tab in front: the chosen one while it is there, else the browser.
    pub fn side_tab(&self) -> SideTab {
        if self.side.front != SideTab::Browser && self.side_items().contains(&self.side.front) { self.side.front.clone() } else { SideTab::Browser }
    }

    pub fn front_artifact(&self) -> Option<&crate::artifacts::Pane> {
        match self.side_tab() {
            SideTab::Artifact(id) => self.artifacts.iter().find(|p| p.id == id),
            _ => None,
        }
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
        }
    }

    pub fn show_tab(&mut self, tab: SideTab) {
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
        let Some(i) = self.side.items.iter().position(|x| x == tab) else { return };
        self.side.items.remove(i);
        match tab {
            SideTab::Artifact(id) => self.artifacts.retain(|p| &p.id != id),
            SideTab::Helper(id) => self.helpers.retain(|(h, _)| h != id),
            SideTab::Browser => {}
        }
        if &self.side.front == tab {
            self.side.front = if i > 0 { self.side.items[i - 1].clone() } else { self.side.items.first().cloned().unwrap_or(SideTab::Browser) };
        }
        if self.side.items.is_empty() && self.side.for_item {
            self.side.open = false;
            self.side.wide = false;
        }
    }

    /// Escape: closes the artifact or helper in front.
    pub fn close_side_item(&mut self) {
        let tab = self.side_tab();
        self.close_tab(&tab);
    }

    /// The chat's tabs belong to it: another chat opens with none.
    pub fn clear_side_items(&mut self) {
        self.artifacts.clear();
        self.helpers.clear();
        self.side.items.clear();
        if self.side.for_item {
            self.side.open = false;
            self.side.wide = false;
        }
    }

    pub fn show_browser_tab(&mut self) {
        self.side.open = true;
        self.side.for_item = false;
        self.side.front = SideTab::Browser;
    }

    /// Sends what the panel's chat box holds to the chat, naming the tab in
    /// front so the agent knows what it is about. Queued behind a turn under way.
    pub fn send_side(&mut self, tx: &mut Tx) {
        let text = self.side.composer.text.trim().to_string();
        if text.is_empty() || self.model_unavailable() {
            return;
        }
        let about = match self.side_tab() {
            SideTab::Artifact(id) => {
                let title = self.front_artifact().and_then(|p| p.loaded.ready()).map(|a| a.title.clone()).unwrap_or_else(|| "page".into());
                format!("About the page \"{title}\" (artifact {id}) open beside the chat: {text}")
            }
            SideTab::Helper(id) => {
                let title = self.front_helper().and_then(|(_, l)| l.ready()).and_then(|c| c.session.as_ref()).and_then(|i| i.title.clone()).unwrap_or_else(|| "helper".into());
                format!("About the helper \"{title}\" (session {id}): {text}")
            }
            SideTab::Browser => text,
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
        if self.browser_visible() {
            let now = native_preview::browser_url();
            if now != self.side.seen_url {
                self.side.seen_url = now;
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

    fn pane(id: &str) -> crate::artifacts::Pane {
        crate::artifacts::Pane { business: "b1".into(), id: id.into(), requested: None, loaded: Load::Loading, source: false }
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
    fn another_chat_opens_with_none_of_the_last_ones_tabs() {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.show_browser_tab();
        s.add_artifact_tab(pane("a1"));
        s.clear_side_items();
        assert!(s.side_shown(), "opened by the person, the panel stays on the browser");
        assert_eq!(s.side_tab(), SideTab::Browser);
    }
}
