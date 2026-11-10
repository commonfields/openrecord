//! The app's state and what each reply from the API does to it.

use rune::{TextEdit, Tx};

use crate::api::{ApiError, ApiResult, Business, Campaign, Channel, ChatSummary, Conversation, Decision, Issue, Message, Overview};
use crate::insights::{Insights, Section};
use crate::net::{Net, Reply};

/// Something loaded from the API for the business on screen.
#[derive(Debug, Clone, PartialEq)]
pub enum Load<T> {
    Idle,
    Loading,
    Ready(T),
    Failed(String),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// Checking a saved session at launch.
    Restoring,
    SignIn,
    Workspace,
}

/// The header's two views, as on the web: the agent chat, or the workspace pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Agent,
    Workspace,
}

/// The workspace pages the sidebar lists, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Inbox,
    Overview,
    Campaigns,
    AiAnswers,
    Channels,
}

impl Page {
    pub const ALL: [Page; 5] = [Page::Inbox, Page::Overview, Page::Campaigns, Page::AiAnswers, Page::Channels];

    pub fn label(self) -> &'static str {
        match self {
            Page::Inbox => "Inbox",
            Page::Overview => "Overview",
            Page::Campaigns => "Campaigns",
            Page::AiAnswers => "AI answers",
            Page::Channels => "Channels",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Page::Inbox => "inbox",
            Page::Overview => "overview",
            Page::Campaigns => "campaigns",
            Page::AiAnswers => "ai-answers",
            Page::Channels => "channels",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Businesses,
    Account,
    Model,
    ChatFilter,
}

/// The turn the composer sent, while it runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    Idle,
    /// Sent and not yet answered; the message shows at once.
    Working {
        message: String,
        /// The request, once the API accepted it, and what its run is doing.
        request: Option<String>,
        progress: crate::chat::Progress,
        started: std::time::Instant,
        /// Stop was pressed; the turn settles on its own.
        stopping: bool,
    },
    Failed { message: String, error: String },
}

/// What the AI discovery chart plots (the web's `metric` URL parameter).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Partial and needs-review are reachable by link on the web, not by tab.
pub enum Metric {
    Accuracy,
    Wrong,
    Partial,
    Unreviewed,
    Answers,
    Checks,
    Goal,
}

pub struct App {
    pub net: Net,
    pub screen: Screen,
    pub email: TextEdit,
    pub password: TextEdit,
    pub signin_error: Option<String>,
    pub signing_in: bool,
    pub account_email: Option<String>,

    pub businesses: Vec<Business>,
    pub active: Option<String>,
    pub chats: Vec<ChatSummary>,
    pub show_all_chats: bool,
    pub decisions: Vec<Decision>,

    pub view: View,
    pub page: Page,
    pub sidebar_open: bool,
    pub menu: Option<Menu>,

    pub overview: Load<Overview>,
    pub issues: Load<Vec<Issue>>,
    pub channels: Load<Vec<Channel>>,
    pub campaigns: Load<Vec<Campaign>>,
    /// The Overview section on screen and its period in days.
    pub section: Section,
    pub days: u32,
    /// The AI discovery chart: which metric, trend or split, and which models.
    pub metric: Metric,
    pub split: bool,
    pub hidden_models: std::collections::BTreeSet<String>,
    pub model_focus: Option<String>,
    pub all_models: bool,
    /// The chart and day under the pointer.
    pub chart_hover: Option<(String, usize)>,
    /// The models the composer offers, the one picked, and the picker's filter.
    pub catalog: Load<Vec<crate::chat::ModelOption>>,
    pub agent_model: Option<String>,
    pub model_filter: Option<String>,
    /// Finished replies whose work log is open, and copied messages.
    pub open_logs: std::collections::BTreeSet<usize>,
    pub open_sources: std::collections::BTreeSet<usize>,
    pub copied: Option<usize>,
    /// Messages waiting for the turn under way, and files for the next message.
    pub queued: Vec<String>,
    pub attachments: Vec<crate::chat::Attachment>,
    pub attach_error: Option<String>,
    /// The chat history: archived chats instead of live ones, and one business only.
    pub show_archived: bool,
    pub archived: Load<Vec<ChatSummary>>,
    pub chat_filter: Option<String>,
    pub insights: Load<Insights>,

    pub chat_id: Option<String>,
    pub conversation: Load<Conversation>,
    pub composer: TextEdit,
    pub turn: Turn,

    /// The decision open in the inbox (its `key`); the first one when unset.
    pub decision: Option<String>,
    /// The decline reason field is open for the open decision.
    pub declining: bool,
    pub decline_reason: TextEdit,
    /// A decision whose approve or decline call is in flight.
    pub deciding: Option<String>,
    /// Why the last decision call failed, for the decision it was about.
    pub decision_error: Option<(String, String)>,
    /// Re-check measurement models, loaded when a re-check is opened.
    pub models: Load<Vec<String>>,
    pub model: Option<String>,

    /// The last failure the shell itself hit, shown in a toast.
    pub notice: Option<String>,
}

pub const API_ENV: &str = "OPENRECORD_API_URL";
pub const DEFAULT_API: &str = "http://localhost:3001";

impl App {
    pub fn new() -> App {
        let base = std::env::var(API_ENV).unwrap_or_else(|_| DEFAULT_API.to_string());
        // Headless runs (snapshots, scripted scenes) draw fixture data and never touch the network.
        let live = rune::tooling::headless_run().is_none();
        App::with_net(Net::new(live.then_some(base)))
    }

    pub fn with_net(net: Net) -> App {
        let screen = if net.has_session() { Screen::Restoring } else { Screen::SignIn };
        let mut email = TextEdit::new("");
        if let Some(saved) = remembered_email() {
            email.replace_text(&saved);
        }
        App {
            net,
            screen,
            email,
            password: TextEdit::new("").secure(),
            signin_error: None,
            signing_in: false,
            account_email: remembered_email(),
            businesses: Vec::new(),
            active: None,
            chats: Vec::new(),
            show_all_chats: false,
            decisions: Vec::new(),
            view: View::Agent,
            page: Page::Inbox,
            sidebar_open: true,
            menu: None,
            overview: Load::Idle,
            issues: Load::Idle,
            channels: Load::Idle,
            campaigns: Load::Idle,
            section: Section::Summary,
            days: 30,
            metric: Metric::Accuracy,
            split: false,
            hidden_models: Default::default(),
            model_focus: None,
            all_models: false,
            chart_hover: None,
            catalog: Load::Idle,
            agent_model: crate::chat::stored_model(),
            model_filter: None,
            open_logs: Default::default(),
            open_sources: Default::default(),
            copied: None,
            queued: Vec::new(),
            attachments: Vec::new(),
            attach_error: None,
            show_archived: false,
            archived: Load::Idle,
            chat_filter: None,
            insights: Load::Idle,
            chat_id: None,
            conversation: Load::Idle,
            composer: TextEdit::new(""),
            turn: Turn::Idle,
            decision: None,
            declining: false,
            decline_reason: TextEdit::new(""),
            deciding: None,
            decision_error: None,
            models: Load::Idle,
            model: None,
            notice: None,
        }
    }

    pub fn active_business(&self) -> Option<&Business> {
        let id = self.active.as_deref()?;
        self.businesses.iter().find(|b| b.id == id)
    }

    /// Open AI-answer claims and unreviewed answers: the sidebar's count.
    pub fn attention(&self) -> i64 {
        self.overview.ready().map_or(0, |o| o.needs_attention + o.unreviewed)
    }

    /// Decisions waiting on the person for the business on screen.
    pub fn waiting(&self) -> usize {
        match &self.active {
            Some(id) => self.decisions.iter().filter(|d| &d.business_id == id).count(),
            None => self.decisions.len(),
        }
    }

    /// The inbox's decisions: the business on screen's, or every business's.
    pub fn inbox(&self) -> Vec<&Decision> {
        self.decisions.iter().filter(|d| self.active.as_ref().is_none_or(|b| &d.business_id == b)).collect()
    }

    /// The decision open in the inbox.
    pub fn open_decision(&self) -> Option<&Decision> {
        let list = self.inbox();
        self.decision.as_ref().and_then(|k| list.iter().find(|d| &d.key == k).copied()).or_else(|| list.first().copied())
    }

    // ---- Actions --------------------------------------------------------

    pub fn select_decision(&mut self, key: &str) {
        if self.decision.as_deref() != Some(key) {
            self.decision = Some(key.to_string());
            self.declining = false;
            self.decline_reason.clear();
        }
        self.load_models();
    }

    /// Fetches the re-check models the first time a re-check is open.
    fn load_models(&mut self) {
        let is_check = self.open_decision().is_some_and(|d| d.act == crate::decisions::Act::Check);
        if is_check && matches!(self.models, Load::Idle | Load::Failed(_)) {
            self.models = Load::Loading;
            self.net.models();
        }
    }

    pub fn choose_model(&mut self, model: &str) {
        self.model = Some(model.to_string());
    }

    pub fn approve_decision(&mut self) {
        let Some(d) = self.open_decision().cloned() else { return };
        if self.deciding.is_some() || d.blocked(self.model.as_deref()).is_some() {
            return;
        }
        self.decision_error = None;
        self.deciding = Some(d.key.clone());
        let model = (d.act == crate::decisions::Act::Check).then(|| self.model.clone()).flatten();
        self.net.decide(d, true, model, None);
    }

    pub fn start_decline(&mut self, tx: &mut Tx) {
        self.declining = true;
        tx.focus("decline-reason", false);
    }

    pub fn cancel_decline(&mut self) {
        self.declining = false;
        self.decline_reason.clear();
    }

    pub fn confirm_decline(&mut self) {
        let Some(d) = self.open_decision().cloned() else { return };
        if self.deciding.is_some() {
            return;
        }
        let reason = self.decline_reason.text.trim().to_string();
        self.decision_error = None;
        self.deciding = Some(d.key.clone());
        self.net.decide(d, false, None, (!reason.is_empty()).then_some(reason));
    }

    pub fn start(&mut self) {
        if self.screen == Screen::Restoring {
            self.net.restore();
        }
    }

    pub fn submit_signin(&mut self) {
        let email = self.email.text.trim().to_string();
        let password = self.password.text.clone();
        if email.is_empty() || password.is_empty() {
            self.signin_error = Some("Enter your email and password.".into());
            return;
        }
        self.signin_error = None;
        self.signing_in = true;
        remember_email(&email);
        self.account_email = Some(email.clone());
        self.net.signin(email, password);
    }

    pub fn fill_demo(&mut self) {
        self.email.replace_text("demo@northstar.test");
        self.password.replace_text("password123");
    }

    pub fn sign_out(&mut self) {
        self.menu = None;
        self.net.signout();
    }

    pub fn select_business(&mut self, id: &str) {
        self.menu = None;
        if self.active.as_deref() == Some(id) {
            return;
        }
        self.active = Some(id.to_string());
        self.overview = Load::Idle;
        self.issues = Load::Idle;
        self.channels = Load::Idle;
        self.campaigns = Load::Idle;
        self.insights = Load::Idle;
        self.new_chat();
        self.load_business();
    }

    fn load_business(&mut self) {
        let Some(id) = self.active.clone() else { return };
        self.overview = Load::Loading;
        self.net.overview(id);
        self.load_page();
    }

    pub fn show_view(&mut self, view: View) {
        self.view = view;
        if view == View::Workspace {
            self.load_page();
        }
    }

    pub fn show_section(&mut self, section: Section) {
        self.section = section;
        if self.page != Page::Overview || self.view != View::Workspace {
            self.show_page(Page::Overview);
        }
    }

    pub fn set_metric(&mut self, m: Metric) {
        self.metric = m;
        // Checks have no split; the split of answers is per model.
        if m == Metric::Checks || m == Metric::Goal {
            self.split = false;
        }
        self.chart_hover = None;
    }

    pub fn set_split(&mut self, split: bool) {
        self.split = split;
        self.chart_hover = None;
    }

    /// Hides or shows one model; hiding the last one shows them all again.
    pub fn toggle_model(&mut self, key: &str, total: usize) {
        if !self.hidden_models.remove(key) {
            self.hidden_models.insert(key.to_string());
        }
        if self.hidden_models.len() >= total {
            self.hidden_models.clear();
        }
        if self.hidden_models.contains(key) && self.model_focus.as_deref() == Some(key) {
            self.model_focus = None;
        }
    }

    pub fn set_days(&mut self, days: u32) {
        if self.days == days {
            return;
        }
        self.days = days;
        if let Some(id) = self.active.clone() {
            self.insights = Load::Loading;
            self.net.insights(id, days);
        }
    }

    pub fn show_page(&mut self, page: Page) {
        self.view = View::Workspace;
        self.page = page;
        self.load_page();
    }

    /// Fetches what the page on screen shows, every time it opens, as the
    /// web pages do on mount.
    fn load_page(&mut self) {
        let Some(id) = self.active.clone() else { return };
        if self.view != View::Workspace {
            return;
        }
        match self.page {
            Page::Inbox => {
                self.net.decisions();
                self.load_models();
            }
            Page::Overview => {
                self.overview = keep_or_load(&self.overview);
                self.net.overview(id.clone());
                self.insights = keep_or_load(&self.insights);
                self.net.insights(id, self.days);
            }
            Page::Campaigns => {
                self.campaigns = keep_or_load(&self.campaigns);
                self.net.campaigns(id);
            }
            Page::AiAnswers => {
                self.issues = keep_or_load(&self.issues);
                self.net.issues(id);
            }
            Page::Channels => {
                self.channels = keep_or_load(&self.channels);
                self.net.channels(id);
            }
        }
    }

    /// Fetches everything on screen again: the account's lists, the business's
    /// counts, the page and the open chat.
    pub fn refresh(&mut self) {
        self.net.workspace();
        if let Some(b) = self.active.clone() {
            self.net.overview(b.clone());
            self.load_page();
            if let Some(chat) = self.chat_id.clone() {
                self.net.conversation(b, chat);
            }
        }
    }

    pub fn new_chat(&mut self) {
        self.view = View::Agent;
        self.chat_id = None;
        self.conversation = Load::Idle;
        self.turn = Turn::Idle;
    }

    pub fn open_chat(&mut self, chat: &ChatSummary) {
        if let Some(b) = chat.business_id.clone() {
            if self.active.as_deref() != Some(b.as_str()) {
                self.select_business(&b);
            }
        }
        self.view = View::Agent;
        self.chat_id = Some(chat.id.clone());
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        if let Some(b) = self.active.clone() {
            self.net.conversation(b, chat.id.clone());
        }
    }

    /// The model the next turn uses: the one picked if it's still offered,
    /// otherwise the first offered (the hosted default when there is one).
    pub fn chosen_model(&self) -> Option<&crate::chat::ModelOption> {
        let list = self.catalog.ready()?;
        self.agent_model.as_ref().and_then(|v| list.iter().find(|o| &o.value == v)).or_else(|| list.first())
    }

    /// The picked model is gone from the catalog: never re-routed silently.
    pub fn model_unavailable(&self) -> bool {
        match (self.catalog.ready(), &self.agent_model) {
            (Some(list), Some(v)) if v != "hosted" => !list.iter().any(|o| &o.value == v),
            _ => false,
        }
    }

    pub fn choose_agent_model(&mut self, value: String) {
        crate::chat::store_model(&value);
        self.agent_model = Some(value);
        self.menu = None;
    }

    pub fn open_model_menu(&mut self) {
        self.menu = Some(Menu::Model);
        self.model_filter = None;
        self.net.catalog();
    }

    /// Stops the turn running in this chat.
    pub fn toggle_archived(&mut self) {
        self.show_archived = !self.show_archived;
        if self.show_archived {
            self.archived = keep_or_load(&self.archived);
            self.net.archived_chats();
        }
    }

    /// Archives a chat, or restores an archived one.
    pub fn archive_chat(&mut self, id: &str, archived: bool) {
        if archived {
            self.chats.retain(|c| c.id != id);
        } else if let Load::Ready(list) = &mut self.archived {
            list.retain(|c| c.id != id);
        }
        self.net.archive(id.to_string(), archived);
    }

    /// Opens another session of this business, such as a helper, in the chat.
    pub fn open_session(&mut self, id: &str) {
        self.view = View::Agent;
        self.chat_id = Some(id.to_string());
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        self.open_logs.clear();
        self.open_sources.clear();
        if let Some(b) = self.active.clone() {
            self.net.conversation(b, id.to_string());
        }
    }

    pub fn stop_turn(&mut self) {
        let (Some(b), Some(c)) = (self.active.clone(), self.chat_id.clone()) else { return };
        if let Turn::Working { stopping, .. } = &mut self.turn {
            *stopping = true;
            self.net.cancel(b, c);
        }
    }

    /// Sends what the composer holds, or queues it while a turn runs: it
    /// goes out when the agent finishes, as the web composer queues follow-ups.
    pub fn send_message(&mut self, tx: &mut Tx) {
        let text = self.composer.text.trim().to_string();
        if text.is_empty() || self.model_unavailable() {
            return;
        }
        self.composer.clear();
        if matches!(self.turn, Turn::Working { .. }) {
            self.queued.push(text);
            return;
        }
        self.dispatch(text, tx);
    }

    /// Sends a slash command at once (or queues it behind the turn under way).
    pub fn run_command(&mut self, name: &str, tx: &mut Tx) {
        self.composer.clear();
        let text = format!("/{name}");
        if matches!(self.turn, Turn::Working { .. }) {
            self.queued.push(text);
        } else {
            self.dispatch(text, tx);
        }
    }

    /// Sends a queued message now: the turn under way stops, and this one goes next.
    pub fn send_queued_now(&mut self, i: usize) {
        if i < self.queued.len() {
            let m = self.queued.remove(i);
            self.queued.insert(0, m);
            self.stop_turn();
        }
    }

    pub fn unqueue(&mut self, i: usize) {
        if i < self.queued.len() {
            self.queued.remove(i);
        }
    }

    /// Picks a text file to send with the next message.
    pub fn attach(&mut self, tx: &mut Tx) {
        if self.attachments.len() >= crate::chat::MAX_FILES {
            self.attach_error = Some("You can attach up to three files.".into());
            return;
        }
        let options = rune::FileDialogOptions { title: "Attach a file".into(), ..Default::default() }.filter("Text", &["txt", "md", "markdown", "csv", "json", "html", "htm", "xml", "yaml", "yml", "log", "tsv"]);
        tx.open_file(options, |s: &mut App, answer, _tx| match answer {
            Ok(Some(path)) => {
                let used = s.attachments.iter().map(|a| a.text.chars().count()).sum();
                match crate::chat::read_attachment(&path, used) {
                    Ok(a) => {
                        s.attachments.push(a);
                        s.attach_error = None;
                    }
                    Err(e) => s.attach_error = Some(e),
                }
            }
            Ok(None) => {}
            Err(e) => s.attach_error = Some(e.0),
        });
    }

    fn dispatch(&mut self, text: String, tx: &mut Tx) {
        let Some(business) = self.active.clone() else { return };
        let conversation = match (&self.chat_id, self.conversation.ready()) {
            (Some(id), Some(c)) if &c.id == id => Some((id.clone(), c.revision)),
            _ => None,
        };
        self.turn = Turn::Working { message: text.clone(), request: None, progress: Default::default(), started: std::time::Instant::now(), stopping: false };
        let out = crate::chat::Outgoing { message: text, selection: self.chosen_model().and_then(|m| m.selection()), attachments: std::mem::take(&mut self.attachments) };
        self.attach_error = None;
        self.net.send(business, conversation, out);
        tx.scroll_to_bottom("transcript");
    }

    // ---- Replies --------------------------------------------------------

    /// Applies the replies that have landed; true when anything changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let replies = self.net.take();
        let changed = !replies.is_empty();
        for r in replies {
            self.apply(r, tx);
        }
        changed
    }

    fn signed_out(&mut self, message: Option<String>) {
        let email = self.email.text.clone();
        let net = std::mem::replace(&mut self.net, Net::new(None));
        *self = App::with_net(net);
        self.screen = Screen::SignIn;
        self.email.replace_text(&email);
        self.signin_error = message;
    }

    /// Unauthorized anywhere ends the session; other failures stay where they happened.
    fn failed<T>(&mut self, r: ApiResult<T>) -> Result<T, String> {
        match r {
            Ok(v) => Ok(v),
            Err(ApiError::Unauthorized) => {
                self.signed_out(Some(ApiError::Unauthorized.message()));
                Err(String::new())
            }
            Err(e) => Err(e.message()),
        }
    }

    fn apply(&mut self, reply: Reply, tx: &mut Tx) {
        let here = |s: &App, b: &str| s.active.as_deref() == Some(b);
        match reply {
            Reply::Restored(r) => match r {
                Ok(()) => self.enter_workspace(),
                Err(ApiError::Offline(_)) => {
                    self.screen = Screen::SignIn;
                    self.signin_error = Some(ApiError::Offline(String::new()).message());
                }
                Err(_) => self.signed_out(None),
            },
            Reply::SignedIn(r) => {
                self.signing_in = false;
                match r {
                    Ok(()) => {
                        self.password.clear();
                        self.enter_workspace();
                    }
                    Err(ApiError::Unauthorized) | Err(ApiError::Status(400..=403, _)) => {
                        self.signin_error = Some("That email and password don't match an account.".into());
                    }
                    Err(e) => self.signin_error = Some(e.message()),
                }
            }
            Reply::SignedOut => self.signed_out(None),
            Reply::Businesses(r) => {
                if let Ok(list) = self.failed(r) {
                    self.businesses = list;
                    let still = self.active.as_ref().is_some_and(|a| self.businesses.iter().any(|b| &b.id == a));
                    if !still {
                        if let Some(first) = self.businesses.first().map(|b| b.id.clone()) {
                            self.active = None;
                            self.select_business(&first);
                        }
                    }
                }
            }
            Reply::Chats(r) => match self.failed(r) {
                Ok(list) => self.chats = list,
                Err(e) if !e.is_empty() => self.notice = Some(e),
                Err(_) => {}
            },
            Reply::Decisions(r) => {
                if let Ok(list) = self.failed(r) {
                    self.decisions = list;
                }
            }
            Reply::Overview(b, r) if here(self, &b) => self.overview = to_load(self.failed(r)),
            Reply::Issues(b, r) if here(self, &b) => self.issues = to_load(self.failed(r)),
            Reply::Channels(b, r) if here(self, &b) => self.channels = to_load(self.failed(r)),
            Reply::Campaigns(b, r) if here(self, &b) => self.campaigns = to_load(self.failed(r)),
            Reply::Conversation(b, r) if here(self, &b) => match self.failed(r) {
                Ok(Some(c)) if Some(&c.id) == self.chat_id.as_ref() => {
                    self.conversation = Load::Ready(c);
                    tx.scroll_to_bottom("transcript");
                    // The reply is in and the revision current: the next queued message goes.
                    if matches!(self.turn, Turn::Idle) && !self.queued.is_empty() {
                        let next = self.queued.remove(0);
                        self.dispatch(next, tx);
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => self.conversation = Load::Failed("This chat no longer exists.".into()),
                Err(e) => self.conversation = Load::Failed(e),
            },
            Reply::TurnQueued { business, conversation, request: id } if here(self, &business) => {
                if self.chat_id.is_none() {
                    self.chat_id = Some(conversation);
                }
                if let Turn::Working { request, .. } = &mut self.turn {
                    *request = Some(id);
                }
                self.net.chats();
            }
            Reply::Progress { request: id, events } => {
                if let Turn::Working { request: Some(r), progress, .. } = &mut self.turn {
                    if *r == id {
                        progress.apply(&events);
                    }
                }
            }
            Reply::Catalog(r) => self.catalog = to_load(self.failed(r)),
            Reply::ArchivedChats(r) => self.archived = to_load(self.failed(r)),
            Reply::Archived { archived, result, .. } => {
                if let Err(e) = self.failed(result) {
                    if !e.is_empty() {
                        self.notice = Some(if archived { "Couldn't archive the chat. Try again." } else { "Couldn't restore the chat. Try again." }.into());
                    }
                }
            }
            Reply::TurnDone { business, conversation, result } => {
                self.net.chats();
                if !here(self, &business) || self.chat_id.as_deref().is_some_and(|c| c != conversation) {
                    return;
                }
                match self.failed(result) {
                    Ok(()) => {
                        self.turn = Turn::Idle;
                        self.chat_id = Some(conversation.clone());
                        self.net.conversation(business, conversation);
                    }
                    Err(e) if e.is_empty() => {}
                    // Stopped on purpose: what the run said so far reloads with the chat.
                    Err(_) if matches!(self.turn, Turn::Working { stopping: true, .. }) => {
                        self.turn = Turn::Idle;
                        self.net.conversation(business, conversation);
                    }
                    Err(error) => {
                        let message = match &self.turn {
                            Turn::Working { message, .. } => message.clone(),
                            _ => String::new(),
                        };
                        self.turn = Turn::Failed { message, error };
                        if !conversation.is_empty() {
                            self.net.conversation(business, conversation);
                        }
                    }
                }
            }
            Reply::Decided { key, approved, result } => {
                self.deciding = None;
                let done = self.decisions.iter().find(|d| d.key == key).map(|d| d.done(approved));
                match result {
                    Ok(()) => {
                        let list = self.inbox();
                        let at = list.iter().position(|d| d.key == key);
                        let next = at.and_then(|i| list.get(i + 1).or_else(|| i.checked_sub(1).and_then(|j| list.get(j)))).map(|d| d.key.clone());
                        self.decisions.retain(|d| d.key != key);
                        if self.decision.as_deref() == Some(key.as_str()) || self.decision.is_none() {
                            self.decision = next;
                        }
                        self.declining = false;
                        self.decline_reason.clear();
                        self.notice = done.map(str::to_string);
                        self.net.decisions();
                    }
                    Err(ApiError::Unauthorized) => self.signed_out(Some(ApiError::Unauthorized.message())),
                    Err(e) => {
                        let message = match &e {
                            ApiError::Status(_, body) => crate::decisions::refusal(body).map(str::to_string),
                            _ => None,
                        }
                        .unwrap_or_else(|| match e {
                            ApiError::Status(409, _) => "This changed since it was prepared. It was reloaded; check it before deciding again.".into(),
                            other => other.message(),
                        });
                        self.decision_error = Some((key, message));
                        self.net.decisions();
                    }
                }
            }
            Reply::Insights(b, days, r) if here(self, &b) && days == self.days => self.insights = to_load(self.failed(r)),
            Reply::Insights(..) => {}
            Reply::Models(r) => {
                self.models = to_load(self.failed(r));
                if let (Load::Ready(list), None) = (&self.models, &self.model) {
                    if list.len() == 1 {
                        self.model = list.first().cloned();
                    }
                }
            }
            // A reply for a business no longer on screen.
            Reply::Overview(..)
            | Reply::Issues(..)
            | Reply::Channels(..)
            | Reply::Campaigns(..)
            | Reply::Conversation(..)
            | Reply::TurnQueued { .. } => {}
        }
    }

    fn enter_workspace(&mut self) {
        self.screen = Screen::Workspace;
        self.signin_error = None;
        self.net.workspace();
        self.net.catalog();
    }

    /// The messages the transcript shows: the loaded conversation, plus the
    /// message a running or failed turn sent, until the reload carries it.
    pub fn transcript(&self) -> Vec<Message> {
        let mut list = self.conversation.ready().map(|c| c.messages.clone()).unwrap_or_default();
        if let Turn::Working { message, .. } | Turn::Failed { message, .. } = &self.turn {
            let already = list.iter().rev().find(|m| m.role == "user").is_some_and(|m| &m.text == message);
            if !already && !message.is_empty() {
                list.push(Message::user(message.clone()));
            }
        }
        list
    }
}

fn keep_or_load<T: Clone>(l: &Load<T>) -> Load<T> {
    match l {
        Load::Ready(v) => Load::Ready(v.clone()),
        _ => Load::Loading,
    }
}

fn to_load<T>(r: Result<T, String>) -> Load<T> {
    match r {
        Ok(v) => Load::Ready(v),
        Err(e) => Load::Failed(e),
    }
}

fn email_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Application Support/OpenRecord/email"))
}

/// The email last signed in with, as the web app remembers it for the account menu.
fn remembered_email() -> Option<String> {
    if rune::tooling::headless_run().is_some() {
        return None;
    }
    let s = std::fs::read_to_string(email_path()?).ok()?;
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn remember_email(email: &str) {
    if let Some(p) = email_path() {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, email);
    }
}
