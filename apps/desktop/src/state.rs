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
    Reasoning,
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

/// A section of Settings (`SettingsSection`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPage {
    General,
    Agent,
    Checks,
    Shortcuts,
    Account,
    Privacy,
    About,
}

impl SettingsPage {
    pub fn title(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Agent => "Agent",
            Self::Checks => "Checks",
            Self::Shortcuts => "Keyboard shortcuts",
            Self::Account => "Account",
            Self::Privacy => "Privacy and data",
            Self::About => "About",
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            Self::General => "Appearance, language and how the app opens.",
            Self::Agent => "How the chat box behaves, and which agent it talks to.",
            Self::Checks => "Defaults for running buyer questions against AI providers.",
            Self::Shortcuts => "Move around OpenRecord without the mouse.",
            Self::Account => "Your sign-in details and current session.",
            Self::Privacy => "What leaves this app, and what is kept.",
            Self::About => "Version and build information.",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Agent => "agent",
            Self::Checks => "checks",
            Self::Shortcuts => "shortcuts",
            Self::Account => "account",
            Self::Privacy => "privacy",
            Self::About => "about",
        }
    }
}

/// A reviewer's verdict on a claim, as the web's review form offers them.
pub const VERDICTS: [(&str, &str, &str); 4] = [
    ("SUPPORTED", "Supported", "Matches your approved facts"),
    ("CONTRADICTED", "Wrong", "Disagrees with an approved fact"),
    ("PARTIAL", "Partially correct", "Some of it is right, some is not"),
    ("INSUFFICIENT_EVIDENCE", "Not enough information", "No approved fact covers it"),
];

/// What can be recorded as done for an issue (`interventionTypes`).
pub const ACTION_KINDS: [(&str, &str); 6] = [
    ("SOURCE_UPDATED", "Source updated"),
    ("SOURCE_PUBLISHED", "Source published"),
    ("THIRD_PARTY_CORRECTION_REQUESTED", "Correction requested"),
    ("KNOWLEDGE_BASE_UPDATED", "Knowledge base updated"),
    ("STRUCTURED_DATA_UPDATED", "Structured data updated"),
    ("OTHER", "Other"),
];

/// The AI answer open on its own page, and its review and action forms.
pub struct AnswerView {
    pub claim: String,
    pub detail: Load<crate::api::AnswerDetail>,
    /// The facts or actions did not load; the claim still shows.
    pub partial: bool,
    /// The review form is open (always, until the claim has a verdict).
    pub reviewing: bool,
    pub verdict: Option<&'static str>,
    pub facts: std::collections::BTreeSet<String>,
    pub notes: TextEdit,
    pub judging: bool,
    pub error: Option<String>,
    /// The record-an-action form.
    pub recording: bool,
    pub action_kind: usize,
    pub action_target: TextEdit,
    pub action_notes: TextEdit,
    pub saving_action: bool,
    pub action_error: Option<String>,
}

impl AnswerView {
    pub fn fixture(claim: String) -> AnswerView {
        AnswerView::new(claim)
    }

    fn new(claim: String) -> AnswerView {
        AnswerView {
            claim,
            detail: Load::Loading,
            partial: false,
            reviewing: false,
            verdict: None,
            facts: Default::default(),
            notes: TextEdit::new(""),
            judging: false,
            error: None,
            recording: false,
            action_kind: 0,
            action_target: TextEdit::new(""),
            action_notes: TextEdit::new(""),
            saving_action: false,
            action_error: None,
        }
    }
}

/// The "Save as playbook" dialog.
pub struct SavePlaybook {
    pub title: TextEdit,
    /// The command; empty means the title's slug.
    pub name: TextEdit,
    pub prompt: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
}

impl SavePlaybook {
    /// The command it saves as: the one typed, or the title's slug.
    pub fn command(&self) -> String {
        let typed = crate::chat::slug(&self.name.text);
        if typed.is_empty() { crate::chat::slug(&self.title.text) } else { typed }
    }
}

/// The "Start a new chat" dialog: a search and the account's client records.
pub struct NewChat {
    pub query: TextEdit,
    pub clients: Load<Vec<(String, String)>>,
}

/// The "Share this chat" dialog.
pub struct ShareChat {
    pub conversation: String,
    pub shares: Load<Vec<crate::api::Share>>,
    /// A link just made: shown once.
    pub link: Option<String>,
    pub busy: bool,
    pub error: Option<String>,
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
    /// The AI answer open from the AI answers list.
    pub answer: Option<AnswerView>,
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
    /// The "/" menu: the playbooks it offers and the highlighted entry.
    pub playbooks: Vec<crate::chat::Playbook>,
    pub command_index: usize,
    /// The composer's "+" menu and the dialogs it opens.
    pub chat_actions: bool,
    pub save_playbook: Option<SavePlaybook>,
    pub share: Option<ShareChat>,
    /// Automatic follow-ups for the business on screen, and their dialog.
    pub followups: Load<crate::followups::Followups>,
    pub followups_open: bool,
    /// The model the confirmation would allow, while it asks.
    pub followup_confirm: Option<crate::followups::Model>,
    pub followup_saving: bool,
    pub followup_error: Option<String>,
    /// The menu row under the pointer (model picker and reasoning), for its eased highlight.
    pub row_hover: Option<String>,
    /// The next loaded conversation was opened, not answered: it lands as it is, without animation.
    pub settle_next: bool,
    /// The business's agent proposals, for the chat's work pane.
    pub proposals: Load<Vec<crate::api::Proposal>>,
    /// Accepted drafts in the work pane, folded open.
    pub drafts_open: bool,
    /// A helper session opened beside the conversation, to review (`?helper=` on the web).
    pub helper: Option<(String, Load<crate::api::Conversation>)>,
    /// The chat on screen has no business: a general chat (`/api/agent`).
    pub general: bool,
    /// "Start a new chat", while it is open.
    pub new_chat: Option<NewChat>,
    /// The reasoning effort picked for a model (`value`, effort); it applies only to that model.
    pub reasoning: Option<(String, String)>,
    /// A reply that just arrived, revealed word by word (its text, and when the reveal began),
    /// and whether the next loaded conversation brings one.
    pub reveal: Option<(String, std::time::Instant)>,
    pub reveal_next: bool,
    /// The model picker's search, while it is open.
    pub model_query: Option<TextEdit>,
    /// Finished replies whose work log is open, and copied messages.
    pub open_logs: std::collections::BTreeSet<(usize, usize)>,
    pub open_sources: std::collections::BTreeSet<usize>,
    pub copied: Option<usize>,
    /// Chart replies switched to their table view (`msg-part` keys).
    pub visual_tables: std::collections::BTreeSet<String>,
    /// Messages waiting for the turn under way, and files for the next message.
    pub queued: Vec<String>,
    pub attachments: Vec<crate::chat::Attachment>,
    pub attach_error: Option<String>,
    /// The chat history: archived chats instead of live ones, and one business only.
    pub show_archived: bool,
    pub archived: Load<Vec<ChatSummary>>,
    pub chat_filter: Option<String>,
    /// Settings, when open, and what it shows.
    pub settings: Option<SettingsPage>,
    pub prefs: crate::prefs::Prefs,
    pub identity: Load<crate::settings::Identity>,
    pub memory: Load<Vec<crate::settings::Note>>,
    pub memory_kind: usize,
    pub memory_text: TextEdit,
    pub providers: Load<crate::settings::Catalog>,
    pub open_models: std::collections::BTreeSet<String>,
    pub pairing: Load<crate::settings::Pairing>,
    pub settings_error: Option<String>,
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
            answer: None,
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
            model_query: None,
            reveal: None,
            reveal_next: false,
            reasoning: None,
            general: false,
            proposals: Load::Idle,
            drafts_open: false,
            helper: None,
            settle_next: false,
            new_chat: None,
            row_hover: None,
            playbooks: Vec::new(),
            followups: Load::Idle,
            followups_open: false,
            followup_confirm: None,
            followup_saving: false,
            followup_error: None,
            command_index: 0,
            chat_actions: false,
            save_playbook: None,
            share: None,
            open_logs: Default::default(),
            open_sources: Default::default(),
            copied: None,
            visual_tables: Default::default(),
            queued: Vec::new(),
            attachments: Vec::new(),
            attach_error: None,
            show_archived: false,
            archived: Load::Idle,
            chat_filter: None,
            settings: None,
            prefs: crate::prefs::Prefs::load(),
            identity: Load::Idle,
            memory: Load::Idle,
            memory_kind: 0,
            memory_text: TextEdit::new(""),
            providers: Load::Idle,
            open_models: Default::default(),
            pairing: Load::Idle,
            settings_error: None,
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
        self.answer = None;
        self.insights = Load::Idle;
        self.memory = Load::Idle;
        self.new_chat();
        // A business opens on the agent or its Overview, as the person chose.
        if self.prefs.landing == crate::prefs::Landing::Today {
            self.view = View::Workspace;
            self.page = Page::Overview;
        }
        self.net.playbooks(Some(id.to_string()));
        self.proposals = Load::Loading;
        self.helper = None;
        self.net.proposals(id.to_string());
        self.followups = Load::Loading;
        self.net.followups(id.to_string());
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
        self.answer = None;
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

    // ---- AI answers -------------------------------------------------------

    /// Opens one AI answer's claim on its own page.
    pub fn open_answer(&mut self, claim: &str) {
        let Some(b) = self.active.clone() else { return };
        self.view = View::Workspace;
        self.page = Page::AiAnswers;
        self.answer = Some(AnswerView::new(claim.to_string()));
        self.net.answer(b, claim.to_string());
    }

    pub fn close_answer(&mut self) {
        self.answer = None;
        self.load_page();
    }

    /// The claim before or after the open one in the list (`-1` or `1`).
    pub fn neighbour_answer(&self, step: i32) -> Option<String> {
        let list = self.issues.ready()?;
        let at = list.iter().position(|i| Some(&i.claim_id) == self.answer.as_ref().map(|a| &a.claim))? as i32;
        list.get(usize::try_from(at + step).ok()?).map(|i| i.claim_id.clone())
    }

    pub fn start_review(&mut self) {
        if let Some(a) = &mut self.answer {
            a.reviewing = true;
            a.error = None;
            // Start from the verdict and facts it has, so a change is one click.
            if let Some(d) = a.detail.ready() {
                a.verdict = d.issue.verdict.as_deref().and_then(|v| VERDICTS.iter().find(|x| x.0 == v)).map(|x| x.0);
                a.facts = d.issue.facts.iter().map(|f| f.id.clone()).collect();
            }
        }
    }

    pub fn cancel_review(&mut self) {
        if let Some(a) = &mut self.answer {
            a.reviewing = false;
            a.verdict = None;
            a.facts.clear();
            a.notes.clear();
            a.error = None;
        }
    }

    pub fn pick_verdict(&mut self, v: &'static str) {
        if let Some(a) = &mut self.answer {
            a.verdict = Some(v);
        }
    }

    pub fn toggle_verdict_fact(&mut self, id: &str) {
        if let Some(a) = &mut self.answer
            && !a.facts.remove(id)
        {
            a.facts.insert(id.to_string());
        }
    }

    pub fn record_verdict(&mut self) {
        let Some(b) = self.active.clone() else { return };
        let Some(a) = &mut self.answer else { return };
        let Some(v) = a.verdict else { return };
        if a.judging {
            return;
        }
        a.judging = true;
        a.error = None;
        let notes = a.notes.text.trim().to_string();
        self.net.judge(b, a.claim.clone(), v.to_string(), a.facts.iter().cloned().collect(), (!notes.is_empty()).then_some(notes));
    }

    pub fn toggle_record_action(&mut self, tx: &mut Tx) {
        if let Some(a) = &mut self.answer {
            a.recording = !a.recording;
            a.action_error = None;
            if a.recording {
                tx.focus("action-target", false);
            }
        }
    }

    pub fn pick_action_kind(&mut self, i: usize) {
        if let Some(a) = &mut self.answer {
            a.action_kind = i;
        }
    }

    pub fn save_action(&mut self) {
        let Some(b) = self.active.clone() else { return };
        let Some(a) = &mut self.answer else { return };
        let target = a.action_target.text.trim().to_string();
        if target.is_empty() || a.saving_action {
            return;
        }
        a.saving_action = true;
        a.action_error = None;
        let notes = a.action_notes.text.trim().to_string();
        let kind = ACTION_KINDS[a.action_kind % ACTION_KINDS.len()].0.to_string();
        self.net.record_action(b, a.claim.clone(), kind, target, (!notes.is_empty()).then_some(notes));
    }

    /// Fetches everything on screen again: the account's lists, the business's
    /// counts, the page and the open chat.
    pub fn refresh(&mut self) {
        self.net.workspace();
        if let Some(b) = self.active.clone() {
            self.net.overview(b.clone());
            self.load_page();
            if let Some(a) = &self.answer {
                self.net.answer(b.clone(), a.claim.clone());
            }
        }
        if let (Some(scope), Some(chat)) = (self.chat_scope(), self.chat_id.clone()) {
            self.net.conversation(scope, chat);
        }
    }

    /// Whose agent the chat on screen talks to: the business's, or `""` for a general chat.
    pub fn chat_scope(&self) -> Option<String> {
        if self.general { Some(String::new()) } else { self.active.clone() }
    }

    /// Opens a helper session beside the conversation, read-only.
    pub fn open_helper(&mut self, id: &str) {
        let Some(scope) = self.chat_scope() else { return };
        self.helper = Some((id.to_string(), Load::Loading));
        self.net.helper(scope, id.to_string());
    }

    /// Makes the helper the main chat, where replies can be written.
    pub fn helper_as_main(&mut self) {
        if let Some((id, _)) = self.helper.take() {
            self.open_session(&id);
        }
    }

    /// Opens "Start a new chat".
    pub fn open_new_chat(&mut self, tx: &mut Tx) {
        self.menu = None;
        self.new_chat = Some(NewChat { query: TextEdit::new(""), clients: Load::Loading });
        self.net.clients();
        tx.focus("new-chat-search", false);
    }

    /// Starts an empty chat about a business, or a general one (`None`).
    pub fn start_chat(&mut self, business: Option<String>) {
        self.new_chat = None;
        match business {
            Some(b) => {
                if self.active.as_deref() != Some(b.as_str()) {
                    self.select_business(&b);
                }
                self.new_chat();
                self.view = View::Agent;
            }
            None => {
                self.new_chat();
                self.general = true;
            }
        }
    }

    pub fn new_chat(&mut self) {
        self.view = View::Agent;
        self.general = false;
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
        // A chat without a business is a general chat.
        self.general = chat.business_id.is_none();
        self.view = View::Agent;
        self.chat_id = Some(chat.id.clone());
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        self.settle_next = true;
        if let Some(scope) = self.chat_scope() {
            self.net.conversation(scope, chat.id.clone());
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

    /// The effort the next turn asks for: the one picked for this model, if it still offers it.
    pub fn reasoning_effort(&self) -> Option<&str> {
        let m = self.chosen_model()?;
        let (key, effort) = self.reasoning.as_ref()?;
        (key == &m.value && m.efforts.contains(effort)).then_some(effort.as_str())
    }

    pub fn choose_reasoning(&mut self, effort: Option<String>) {
        self.menu = None;
        self.reasoning = match (effort, self.chosen_model()) {
            (Some(e), Some(m)) => Some((m.value.clone(), e)),
            _ => None,
        };
    }

    /// The turn's `selection`: the model, with its reasoning effort when one is picked.
    pub fn turn_selection(&self) -> Option<serde_json::Value> {
        let mut sel = self.chosen_model()?.selection()?;
        if let Some(e) = self.reasoning_effort() {
            sel["reasoningEffort"] = serde_json::json!(e);
        }
        Some(sel)
    }

    pub fn choose_agent_model(&mut self, value: String) {
        crate::chat::store_model(&value);
        self.agent_model = Some(value);
        self.menu = None;
    }

    pub fn open_model_menu(&mut self) {
        self.menu = Some(Menu::Model);
        self.model_filter = None;
        self.model_query = None;
        self.net.catalog();
    }

    /// Stops the turn running in this chat.
    // ---- Settings ---------------------------------------------------------

    pub fn open_settings(&mut self, page: SettingsPage) {
        self.menu = None;
        self.settings = Some(page);
        self.settings_error = None;
        self.load_settings(page);
    }

    pub fn show_settings(&mut self, page: SettingsPage) {
        self.settings = Some(page);
        self.settings_error = None;
        self.load_settings(page);
    }

    fn load_settings(&mut self, page: SettingsPage) {
        match page {
            SettingsPage::Account => {
                self.identity = keep_or_load(&self.identity);
                self.net.identity();
            }
            SettingsPage::Agent => {
                self.providers = keep_or_load(&self.providers);
                self.net.providers();
                if let Some(b) = self.active.clone() {
                    self.memory = keep_or_load(&self.memory);
                    self.net.memory(b);
                }
            }
            _ => {}
        }
    }

    /// Changes a preference and saves it.
    pub fn set_pref(&mut self, f: impl FnOnce(&mut crate::prefs::Prefs)) {
        f(&mut self.prefs);
        self.prefs.save();
    }

    pub fn add_memory(&mut self) {
        let text = self.memory_text.text.trim().to_string();
        let Some(b) = self.active.clone() else { return };
        if text.is_empty() {
            return;
        }
        let kind = crate::settings::NOTE_KINDS[self.memory_kind % crate::settings::NOTE_KINDS.len()].0.to_string();
        self.memory_text.clear();
        self.net.change_memory(b, Some((kind, text)), None);
    }

    pub fn forget_memory(&mut self, id: &str) {
        if let Some(b) = self.active.clone() {
            if let Load::Ready(list) = &mut self.memory {
                list.retain(|n| n.id != id);
            }
            self.net.change_memory(b, None, Some(id.to_string()));
        }
    }

    pub fn change_provider(&mut self, change: crate::net::ProviderChange) {
        self.settings_error = None;
        // Switches answer at once; the reload confirms them.
        if let Load::Ready(cat) = &mut self.providers {
            match &change {
                crate::net::ProviderChange::Enable(id, on) => cat.instances.iter_mut().filter(|i| &i.id == id).for_each(|i| i.enabled = *on),
                crate::net::ProviderChange::Model(id, m, on) => cat.instances.iter_mut().filter(|i| &i.id == id).for_each(|i| {
                    i.disabled_models.retain(|x| x != m);
                    if !on {
                        i.disabled_models.push(m.clone());
                    }
                }),
                _ => {}
            }
        }
        self.net.change_provider(change);
    }

    pub fn new_pairing(&mut self) {
        self.pairing = Load::Loading;
        self.net.pair("Another computer".into());
    }

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
        self.settle_next = true;
        self.open_logs.clear();
        self.open_sources.clear();
        if let Some(scope) = self.chat_scope() {
            self.net.conversation(scope, id.to_string());
        }
    }

    pub fn stop_turn(&mut self) {
        let (Some(b), Some(c)) = (self.chat_scope(), self.chat_id.clone()) else { return };
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
        // "What's next?" and the like run their command, as on the web.
        if !self.general && self.attachments.is_empty() {
            if let Some(c) = crate::chat::phrase_command(&text) {
                self.run_command(c, tx);
                return;
            }
        }
        self.composer.clear();
        self.command_index = 0;
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

    // ---- The "/" menu and the "+" menu ---------------------------------------

    /// What the "/" menu lists for the text typed, unless Escape shut it for this text.
    pub fn menu_entries(&self) -> Vec<crate::chat::MenuEntry> {
        if self.active.is_none() || self.general {
            return Vec::new();
        }
        crate::chat::menu_entries(&self.composer.text, &self.playbooks)
    }

    /// Runs a command, or types a playbook's prompt in for the person to read and send.
    pub fn choose_entry(&mut self, id: &str, tx: &mut Tx) {
        let Some(e) = self.menu_entries().into_iter().find(|e| e.id() == id) else { return };
        self.command_index = 0;
        match e {
            crate::chat::MenuEntry::Command(n, _) => self.run_command(n, tx),
            crate::chat::MenuEntry::Playbook(p) => {
                let name = self.active_business().map(|b| b.name.clone());
                self.composer.replace_text(&crate::chat::playbook_text(&p, name.as_deref()));
                tx.focus("composer-input", false);
            }
        }
    }

    /// The composer's keys while the "/" menu is open: arrows move, Tab completes,
    /// Return chooses and Escape shuts it.
    pub fn composer_key(&mut self, ev: &rune::KeyEvent, tx: &mut Tx) -> bool {
        let entries = self.menu_entries();
        if entries.is_empty() || ev.mods.cmd || ev.mods.ctrl || ev.mods.alt {
            return false;
        }
        let n = entries.len();
        let at = self.command_index.min(n - 1);
        match ev.key {
            rune::Key::Down => self.command_index = (at + 1) % n,
            rune::Key::Up => self.command_index = (at + n - 1) % n,
            rune::Key::Tab => {
                self.composer.replace_text(&format!("/{}", entries[at].name()));
                self.command_index = 0;
            }
            rune::Key::Enter if !ev.mods.shift => {
                let id = entries[at].id();
                self.choose_entry(&id, tx);
            }
            // Escape clears what was typed, as the web composer does.
            rune::Key::Escape => {
                self.composer.clear();
                self.command_index = 0;
            }
            _ => return false,
        }
        true
    }

    // ---- Follow-ups ---------------------------------------------------------

    /// The composer's model, as follow-ups would run on it.
    pub fn followup_model(&self) -> Option<crate::followups::Model> {
        if self.model_unavailable() {
            return None;
        }
        let mut m = self.chosen_model().and_then(crate::followups::Model::of)?;
        if let (Some(sel), Some(e)) = (m.selection.as_mut(), self.reasoning_effort()) {
            sel["reasoningEffort"] = serde_json::json!(e);
        }
        Some(m)
    }

    pub fn open_followups(&mut self) {
        self.followups_open = true;
        self.followup_confirm = None;
        self.followup_error = None;
        self.refresh_followups();
    }

    pub fn refresh_followups(&mut self) {
        if let Some(b) = self.active.clone() {
            self.followups = match &self.followups {
                Load::Ready(v) => Load::Ready(v.clone()),
                _ => Load::Loading,
            };
            self.net.followups(b);
        }
    }

    /// Asks before allowing reviews on the composer's model.
    pub fn confirm_followups(&mut self) {
        self.followup_confirm = self.followup_model();
    }

    pub fn allow_followups(&mut self) {
        let (Some(b), Some(c), Some(m)) = (self.active.clone(), self.chat_id.clone(), self.followup_confirm.clone()) else { return };
        if self.followup_saving || matches!(self.turn, Turn::Working { .. }) {
            return;
        }
        let grant = self.followups.ready().and_then(|f| f.grant()).map(str::to_string);
        self.followup_saving = true;
        self.followup_error = None;
        self.net.configure_followups(b, Some((c, grant, m)));
    }

    pub fn pause_followups(&mut self) {
        let Some(b) = self.active.clone() else { return };
        if self.followup_saving {
            return;
        }
        self.followup_saving = true;
        self.followup_error = None;
        self.net.configure_followups(b, None);
    }

    pub fn open_save_playbook(&mut self, tx: &mut Tx) {
        self.chat_actions = false;
        // A playbook is for every business: this business's name becomes {business}.
        let mut prompt = self.composer.text.trim().to_string();
        if let Some(b) = self.active_business().map(|b| b.name.clone()).filter(|b| !b.is_empty()) {
            prompt = prompt.replace(&b, "{business}");
        }
        self.save_playbook = Some(SavePlaybook { title: TextEdit::new(""), name: TextEdit::new(""), prompt: TextEdit::new(&prompt), busy: false, error: None });
        tx.focus("playbook-title", false);
    }

    pub fn submit_playbook(&mut self) {
        let business = self.active.clone();
        let Some(f) = &mut self.save_playbook else { return };
        let name = f.command();
        let prompt = f.prompt.text.trim().to_string();
        if f.busy || prompt.is_empty() {
            return;
        }
        if !crate::chat::valid_command(&name) {
            f.error = Some("The command needs 2 to 40 lowercase letters, digits or hyphens, starting with a letter.".into());
            return;
        }
        let title = f.title.text.trim().to_string();
        f.busy = true;
        f.error = None;
        self.net.change_playbook(business, name.clone(), Some((if title.is_empty() { name } else { title }, prompt)));
    }

    pub fn delete_playbook(&mut self, name: &str) {
        self.playbooks.retain(|p| p.name != name);
        self.net.change_playbook(self.active.clone(), name.to_string(), None);
    }

    pub fn open_share(&mut self) {
        self.chat_actions = false;
        let (Some(b), Some(c)) = (self.active.clone(), self.chat_id.clone()) else { return };
        self.share = Some(ShareChat { conversation: c.clone(), shares: Load::Loading, link: None, busy: false, error: None });
        self.net.shares(b, c, false, None);
    }

    pub fn create_share(&mut self) {
        let Some(b) = self.active.clone() else { return };
        let Some(sh) = &mut self.share else { return };
        if sh.busy {
            return;
        }
        sh.busy = true;
        sh.error = None;
        self.net.shares(b, sh.conversation.clone(), true, None);
    }

    pub fn revoke_share(&mut self, id: &str) {
        let Some(b) = self.active.clone() else { return };
        let Some(sh) = &mut self.share else { return };
        sh.link = None;
        self.net.shares(b, sh.conversation.clone(), false, Some(id.to_string()));
    }

    /// Picks a text file to send with the next message.
    /// Attaches a file dropped on the composer, with the picker's limits.
    pub fn attach_path(&mut self, path: &std::path::Path) {
        if self.attachments.len() >= crate::chat::MAX_FILES {
            self.attach_error = Some("You can attach up to three files.".into());
            return;
        }
        let used = self.attachments.iter().map(|a| a.text.chars().count()).sum();
        match crate::chat::read_attachment(path, used) {
            Ok(a) => {
                self.attachments.push(a);
                self.attach_error = None;
            }
            Err(e) => self.attach_error = Some(e),
        }
    }

    pub fn attach(&mut self, tx: &mut Tx) {
        self.chat_actions = false;
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
        let Some(business) = self.chat_scope() else { return };
        let conversation = match (&self.chat_id, self.conversation.ready()) {
            (Some(id), Some(c)) if &c.id == id => Some((id.clone(), c.revision)),
            _ => None,
        };
        // The live steps' open lines belong to the turn before.
        self.open_logs.retain(|(i, _)| *i != usize::MAX);
        self.turn = Turn::Working { message: text.clone(), request: None, progress: Default::default(), started: std::time::Instant::now(), stopping: false };
        let out = crate::chat::Outgoing { message: text, selection: self.turn_selection(), attachments: std::mem::take(&mut self.attachments), style: Some(self.prefs.response_style.key().to_string()) };
        self.attach_error = None;
        self.net.send(business, conversation, out);
        tx.scroll_to_bottom("transcript");
    }

    // ---- Replies --------------------------------------------------------

    /// Applies the replies that have landed; true when anything changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let replies = self.net.take();
        let mut changed = !replies.is_empty();
        for r in replies {
            self.apply(r, tx);
        }
        // While a turn runs, the thinking glyph steps every 220 milliseconds and the clock ticks.
        if matches!(self.turn, Turn::Working { .. }) && !self.prefs.reduce_motion {
            tx.wake_after(std::time::Duration::from_millis(220));
            changed = true;
        }
        // A reply being revealed redraws every 40 milliseconds until it is whole, as the web paces it.
        if let Some((text, started)) = &self.reveal {
            if crate::chat::reveal_prefix(text, started.elapsed()).is_some() {
                tx.wake_after(std::time::Duration::from_millis(40));
                changed = true;
            } else {
                self.reveal = None;
                changed = true;
            }
        }
        changed
    }

    /// The prefix of a reply still being revealed, or `None` once it is whole.
    pub fn revealing(&self, text: &str) -> Option<String> {
        let (t, started) = self.reveal.as_ref()?;
        if t != text {
            return None;
        }
        crate::chat::reveal_prefix(text, started.elapsed())
    }

    /// Sends the message of a failed turn again.
    pub fn retry(&mut self, tx: &mut Tx) {
        if let Turn::Failed { message, .. } = &self.turn {
            let m = message.clone();
            self.turn = Turn::Idle;
            if !m.is_empty() {
                self.dispatch(m, tx);
            }
        }
    }

    /// Approves a decision from the chat card that shows it.
    pub fn approve_in_chat(&mut self, key: &str) {
        self.decision = Some(key.to_string());
        self.approve_decision();
    }

    /// Opens the decline reason on a chat card.
    pub fn decline_in_chat(&mut self, key: &str, tx: &mut Tx) {
        self.select_decision(key);
        self.start_decline(tx);
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
            Reply::Conversation(b, r) if self.chat_scope().as_deref() == Some(b.as_str()) => match self.failed(r) {
                Ok(Some(c)) if Some(&c.id) == self.chat_id.as_ref() => {
                    // A chat opened from the history shows as it is: no message slides in.
                    if std::mem::take(&mut self.settle_next) {
                        tx.settle();
                    }
                    if std::mem::take(&mut self.reveal_next) {
                        if let Some(m) = c.messages.last().filter(|m| m.role != "user") {
                            self.reveal = Some((m.text.clone(), std::time::Instant::now()));
                        }
                    }
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
            Reply::TurnQueued { business, conversation, request: id } if self.chat_scope().as_deref() == Some(business.as_str()) => {
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
            Reply::Identity(r) => self.identity = to_load(self.failed(r)),
            Reply::Memory(b, r) if here(self, &b) => self.memory = to_load(self.failed(r)),
            Reply::Memory(..) => {}
            Reply::Providers(r) => {
                let r = self.failed(r);
                // A failed refresh keeps the list it had and says it may be stale.
                match (&self.providers, r) {
                    (Load::Ready(_), Err(e)) => self.settings_error = Some(format!("The list may be stale ({e}).")),
                    (_, r) => self.providers = to_load(r),
                }
            }
            Reply::Pairing(r) => self.pairing = to_load(self.failed(r)),
            Reply::SettingFailed(e) => self.settings_error = Some(e),
            Reply::Archived { archived, result, .. } => {
                if let Err(e) = self.failed(result) {
                    if !e.is_empty() {
                        self.notice = Some(if archived { "Couldn't archive the chat. Try again." } else { "Couldn't restore the chat. Try again." }.into());
                    }
                }
            }
            Reply::TurnDone { business, conversation, result } => {
                self.net.chats();
                if self.chat_scope().as_deref() != Some(business.as_str()) || self.chat_id.as_deref().is_some_and(|c| c != conversation) {
                    return;
                }
                match self.failed(result) {
                    Ok(()) => {
                        self.turn = Turn::Idle;
                        if !business.is_empty() {
                            self.net.proposals(business.clone());
                        }
                        // The reply is revealed word by word once it loads.
                        self.reveal_next = rune::tooling::headless_run().is_none() && !self.prefs.reduce_motion;
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
                        if let Some(b) = self.active.clone() {
                            self.net.proposals(b);
                        }
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
            Reply::Answer(b, claim, r) if here(self, &b) => {
                let r = self.failed(r);
                if let Some(a) = self.answer.as_mut().filter(|a| a.claim == claim) {
                    match r {
                        Ok((d, complete)) => {
                            a.partial = !complete;
                            if d.issue.verdict.is_none() && !a.reviewing {
                                a.reviewing = true;
                            }
                            a.detail = Load::Ready(d);
                        }
                        Err(e) if e.is_empty() => {}
                        // A refresh that fails keeps what is on screen.
                        Err(e) if a.detail.ready().is_some() => self.notice = Some(e),
                        Err(e) => a.detail = Load::Failed(e),
                    }
                }
            }
            Reply::Answer(..) => {}
            Reply::Judged { claim, verdict, result } => {
                let r = self.failed(result);
                let business = self.active.clone();
                if let Some(a) = self.answer.as_mut().filter(|a| a.claim == claim) {
                    a.judging = false;
                    match r {
                        Ok(()) => {
                            a.reviewing = false;
                            a.verdict = None;
                            a.facts.clear();
                            a.notes.clear();
                            if let Some(b) = business {
                                self.net.answer(b, claim);
                            }
                            self.notice = Some(if verdict == "SUPPORTED" {
                                "Verdict recorded. Supported claims leave the AI answers list.".into()
                            } else {
                                "Verdict recorded. The claim stays in AI answers until it is fixed.".into()
                            });
                        }
                        Err(e) if e.is_empty() => {}
                        Err(e) => a.error = Some(format!("Couldn't record the verdict. {e}")),
                    }
                }
            }
            Reply::ActionRecorded { claim, result } => {
                let r = self.failed(result);
                let business = self.active.clone();
                if let Some(a) = self.answer.as_mut().filter(|a| a.claim == claim) {
                    a.saving_action = false;
                    match r {
                        Ok(()) => {
                            a.recording = false;
                            a.action_target.clear();
                            a.action_notes.clear();
                            if let Some(b) = business {
                                self.net.answer(b, claim);
                            }
                            self.notice = Some("Action recorded. Recheck the AI later to compare.".into());
                        }
                        Err(e) if e.is_empty() => {}
                        Err(e) => a.action_error = Some(format!("Couldn't record the action. {e}")),
                    }
                }
            }
            Reply::Proposals(b, r) if here(self, &b) => {
                let r = self.failed(r);
                // A failed refresh keeps what is on screen.
                match (r, &self.proposals) {
                    (Ok(list), _) => self.proposals = Load::Ready(list),
                    (Err(_), Load::Ready(_)) => {}
                    (Err(e), _) => self.proposals = Load::Failed(e),
                }
            }
            Reply::Proposals(..) => {}
            Reply::Helper(id, r) => {
                let r = self.failed(r);
                if let Some((open, load)) = &mut self.helper {
                    if *open == id {
                        *load = match r {
                            Ok(Some(c)) => Load::Ready(c),
                            Ok(None) => Load::Failed("This helper session no longer exists.".into()),
                            Err(e) => Load::Failed(e),
                        };
                    }
                }
            }
            Reply::Clients(r) => {
                let r = self.failed(r);
                if let Some(n) = &mut self.new_chat {
                    n.clients = to_load(r);
                }
            }
            Reply::Playbooks(b, r) if b == self.active => {
                if let Ok(list) = self.failed(r) {
                    self.playbooks = list;
                }
            }
            Reply::Playbooks(..) => {}
            Reply::PlaybookChanged { saved, result } => match (self.failed(result), saved) {
                (Ok(()), Some(name)) => {
                    self.save_playbook = None;
                    self.notice = Some(format!("Saved. Type /{name} in any business's chat to use it."));
                }
                (Ok(()), None) => {}
                (Err(e), _) if e.is_empty() => {}
                (Err(_), Some(name)) => {
                    if let Some(f) = &mut self.save_playbook {
                        f.busy = false;
                        f.error = Some(format!("/{name} could not be saved. It may already be an OpenRecord command or playbook; choose another name."));
                    }
                }
                (Err(_), None) => self.notice = Some("The playbook could not be deleted. Try again.".into()),
            },
            Reply::Followups { business, changed, result } if here(self, &business) => {
                if changed {
                    self.followup_saving = false;
                }
                match result {
                    Ok(f) => {
                        self.followups = Load::Ready(f);
                        if changed {
                            self.followup_confirm = None;
                            self.net.chats();
                        }
                    }
                    Err(ApiError::Unauthorized) => self.signed_out(Some(ApiError::Unauthorized.message())),
                    // A lost answer is not proof the change failed: ask for a fresh read.
                    Err(e) => {
                        self.followup_confirm = None;
                        let m = crate::followups::error_message(&e);
                        if changed || self.followups.ready().is_some() {
                            self.followup_error = Some(m);
                        } else {
                            self.followups = Load::Failed(m);
                        }
                    }
                }
            }
            Reply::Followups { .. } => {}
            Reply::Shares { conversation, created, list } => {
                let list = self.failed(list);
                let created = created.map(|r| self.failed(r));
                let api = std::env::var(API_ENV).unwrap_or_else(|_| DEFAULT_API.into());
                if let Some(sh) = self.share.as_mut().filter(|sh| sh.conversation == conversation) {
                    sh.busy = false;
                    match created {
                        Some(Ok(path)) => sh.link = Some(format!("{}{path}", crate::ui::web_url(&api))),
                        Some(Err(e)) if !e.is_empty() => sh.error = Some("That didn't work. Try again.".into()),
                        _ => {}
                    }
                    sh.shares = match list {
                        Ok(l) => Load::Ready(l),
                        Err(e) => Load::Failed(e),
                    };
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
