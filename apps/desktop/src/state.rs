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
    /// The account menu's pages, in the app rather than the browser.
    Usage,
    Businesses,
    Clients,
}

impl Page {
    pub const ALL: [Page; 5] = [Page::Inbox, Page::Overview, Page::Campaigns, Page::AiAnswers, Page::Channels];

    pub fn label(self) -> &'static str {
        match self {
            Page::Inbox => "Inbox",
            Page::Overview => "Analytics",
            Page::Campaigns => "Campaigns",
            Page::AiAnswers => "AI answers",
            Page::Channels => "Channels",
            Page::Usage => "Usage",
            Page::Businesses => "Businesses",
            Page::Clients => "Clients and products",
        }
    }

    /// An account page, not one of a business's.
    pub fn account(self) -> bool {
        matches!(self, Page::Usage | Page::Businesses | Page::Clients)
    }

    pub fn key(self) -> &'static str {
        match self {
            Page::Inbox => "inbox",
            Page::Overview => "overview",
            Page::Campaigns => "campaigns",
            Page::AiAnswers => "ai-answers",
            Page::Channels => "channels",
            Page::Usage => "usage",
            Page::Businesses => "businesses",
            Page::Clients => "clients",
        }
    }
}

/// The campaign open in the editor: the brief as saved, each text field as it
/// is being typed, and whether there are changes to save.
#[derive(Debug, Clone)]
pub struct CampaignEdit {
    pub campaign: crate::api::Campaign,
    /// Brief and distribution fields by their brief key; deliverable fields as "task.{i}.{field}".
    pub fields: std::collections::BTreeMap<String, TextEdit>,
    pub dirty: bool,
    pub saving: bool,
    pub error: Option<String>,
    /// A campaign to open once unsaved changes are kept or discarded (`None` inside: a new brief).
    pub pending: Option<Option<crate::api::Campaign>>,
}

pub const CAMPAIGN_TEXT: [&str; 22] = [
    "title", "owner", "goal", "audience", "offer", "message", "hypothesis", "launchDate", "metric", "baseline", "target", "reviewDate",
    "result", "learning", "nextMove", "primaryChannel", "rationale", "destination", "cadence", "budget", "conversionEvent", "trackingPlan",
];

impl CampaignEdit {
    pub fn new(c: crate::api::Campaign) -> CampaignEdit {
        let get = |k: &str| -> String {
            match k {
                "title" => c.title.clone(), "owner" => c.owner.clone(), "goal" => c.goal.clone(), "audience" => c.audience.clone(),
                "offer" => c.offer.clone(), "message" => c.message.clone(), "hypothesis" => c.hypothesis.clone(), "launchDate" => c.launch_date.clone(),
                "metric" => c.metric.clone(), "baseline" => c.baseline.clone(), "target" => c.target.clone(), "reviewDate" => c.review_date.clone(),
                "result" => c.result.clone(), "learning" => c.learning.clone(), "nextMove" => c.next_move.clone(), "primaryChannel" => c.channel.clone(),
                "rationale" => c.rationale.clone(), "destination" => c.destination.clone(), "cadence" => c.cadence.clone(), "budget" => c.budget.clone(),
                "conversionEvent" => c.conversion_event.clone(), "trackingPlan" => c.tracking_plan.clone(), _ => String::new(),
            }
        };
        let mut fields = std::collections::BTreeMap::new();
        for k in CAMPAIGN_TEXT {
            fields.insert(k.to_string(), TextEdit::new(&get(k)));
        }
        for (i, t) in c.tasks.iter().enumerate() {
            for (f, v) in [("title", &t.title), ("owner", &t.owner), ("due", &t.due), ("note", &t.note)] {
                fields.insert(format!("task.{i}.{f}"), TextEdit::new(v));
            }
        }
        CampaignEdit { campaign: c, fields, dirty: false, saving: false, error: None, pending: None }
    }

    pub fn text(&self, k: &str) -> String {
        self.fields.get(k).map(|e| e.text.clone()).unwrap_or_default()
    }

    /// The brief with every field as typed.
    pub fn current(&self) -> crate::api::Campaign {
        let mut c = self.campaign.clone();
        let t = |k: &str| self.text(k);
        c.title = t("title"); c.owner = t("owner"); c.goal = t("goal"); c.audience = t("audience"); c.offer = t("offer");
        c.message = t("message"); c.hypothesis = t("hypothesis"); c.launch_date = t("launchDate"); c.metric = t("metric");
        c.baseline = t("baseline"); c.target = t("target"); c.review_date = t("reviewDate"); c.result = t("result");
        c.learning = t("learning"); c.next_move = t("nextMove"); c.channel = t("primaryChannel"); c.rationale = t("rationale");
        c.destination = t("destination"); c.cadence = t("cadence"); c.budget = t("budget"); c.conversion_event = t("conversionEvent");
        c.tracking_plan = t("trackingPlan");
        for (i, task) in c.tasks.iter_mut().enumerate() {
            task.title = self.text(&format!("task.{i}.title"));
            task.owner = self.text(&format!("task.{i}.owner"));
            task.due = self.text(&format!("task.{i}.due"));
            task.note = self.text(&format!("task.{i}.note"));
        }
        c
    }
}

#[derive(Debug, Clone)]
pub struct AddBusiness {
    pub text: TextEdit,
    /// "CLIENT" for a client's business, "DOGFOOD" for our own; None as the web's plain dialog.
    pub engagement: Option<&'static str>,
    pub busy: bool,
    pub error: Option<String>,
}

/// What a form's select changes.
#[derive(Debug, Clone, PartialEq)]
pub enum ChoiceTarget {
    /// A campaign choice: status, decision, motion or funnelStage.
    Campaign(&'static str),
    /// A deliverable's channel or status.
    Task(usize, &'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub anchor: String,
    pub options: Vec<&'static str>,
    pub current: String,
    pub target: ChoiceTarget,
}

/// The AI answers page's filters and view, as the web keeps them in its URL.
#[derive(Debug, Clone)]
pub struct IssueQuery {
    /// "ALL" or one state: NEEDS_REVIEW, WRONG, PARTIAL, UNKNOWN.
    pub state: String,
    /// "Every answer" rather than "By claim".
    pub answers: bool,
    pub q: TextEdit,
    /// A provider key, or "all".
    pub provider: String,
    /// A fact's predicate, "none" or "all".
    pub fact: String,
    /// "frequent", "recent" or "oldest"; empty for the view's own default.
    pub sort: String,
    pub page: usize,
    /// Claim groups opened, and those showing every answer.
    pub open: std::collections::BTreeSet<String>,
    pub all: std::collections::BTreeSet<String>,
}

impl Default for IssueQuery {
    fn default() -> Self {
        IssueQuery { state: "ALL".into(), answers: false, q: TextEdit::new(""), provider: "all".into(), fact: "all".into(), sort: String::new(), page: 1, open: Default::default(), all: Default::default() }
    }
}

/// The Businesses list's order, as the web's sort select offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortfolioSort {
    Attention,
    Accuracy,
    Recent,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Businesses,
    Account,
    Model,
    Reasoning,
    ChatFilter,
    /// A form's select, open over its button.
    Choice,
    /// The AI answers toolbar's model, fact and sort pickers.
    IssueModel,
    IssueFact,
    IssueSort,
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
    ("SUPPORTED", "Correct", "Matches your facts"),
    ("CONTRADICTED", "Wrong", "Goes against one of your facts"),
    ("PARTIAL", "Partly right", "Some of it is right, some is not"),
    ("INSUFFICIENT_EVIDENCE", "Can't tell", "None of your facts cover it"),
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

/// "Find…" (the web's command palette): the query and the highlighted result.
pub struct Find {
    pub query: TextEdit,
    pub index: usize,
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
    /// The decisions stack in the corner: whether it is spread out, and the ones put away with "Hide".
    pub notices_open: bool,
    pub notices_hidden: std::collections::BTreeSet<String>,
    /// The key number each source's wide chart shows on Analytics, by the source's key.
    pub metric_pick: std::collections::HashMap<String, usize>,
    /// The sign-in card's server field, and whether it is shown.
    pub server: TextEdit,
    pub server_open: bool,
    pub account_email: Option<String>,

    pub businesses: Vec<Business>,
    pub active: Option<String>,
    pub chats: Vec<ChatSummary>,
    pub show_all_chats: bool,
    pub decisions: Vec<Decision>,

    pub view: View,
    pub page: Page,
    pub sidebar_open: bool,
    /// With the sidebar collapsed, whether it is showing over the page because the pointer reached the left edge.
    pub sidebar_peek: bool,
    pub menu: Option<Menu>,

    pub overview: Load<Overview>,
    pub issues: Load<Vec<Issue>>,
    pub channels: Load<Vec<Channel>>,
    pub campaigns: Load<Vec<Campaign>>,
    /// The Campaigns page: the status shown ("" for all).
    pub campaign_filter: String,
    /// The Campaigns page's campaign open, by id.
    pub campaign_open: Option<String>,
    /// The account pages: usage and its period, the businesses and clients
    /// lists, and the search and order those lists are in.
    pub usage: Load<crate::account::Usage>,
    pub usage_days: u32,
    pub portfolio: Load<Vec<crate::account::Portfolio>>,
    pub client_rows: Load<Vec<crate::account::ClientRow>>,
    pub list_query: TextEdit,
    /// The Channels page: its account statuses, the tab shown, and the row open.
    pub channel_status: Load<crate::channel_status::Status>,
    pub channel_tools: bool,
    pub channel_open: Option<String>,
    pub campaign_edit: Option<CampaignEdit>,
    /// The select open in a form: its button's key, its options and what picking one changes.
    pub choice: Option<Choice>,
    /// "Add a business": the line typed, whether it is a client or our own, and how it went.
    pub add_business: Option<AddBusiness>,
    pub issue_query: IssueQuery,
    pub portfolio_sort: PortfolioSort,
    /// The conversation split's width, measured, for the helper's share of it.
    pub split_w: f32,
    /// The window's size in window points, measured, for the zoom.
    pub window: (f32, f32),
    /// The drag edge held right now, if any.
    pub resizing: Option<crate::ui::Resize>,
    /// The Realtime map: how far in, and the point at its centre (longitude, latitude).
    pub map_zoom: f32,
    pub map_center: (f32, f32),
    /// The map's measured width, and where its centre was when a drag began.
    pub map_w: f32,
    pub map_drag: Option<(f32, f32)>,
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
    /// A background look at the open chat is out (a pending turn, or a newer revision).
    pub syncing: bool,
    /// The agent open in its pane beside a workspace page (`WorkspaceAgentProvider`).
    pub pane: bool,
    /// The pane's share of the space beside the sidebar, 30 to 70 percent.
    pub pane_split: f32,
    /// That space's width, measured.
    pub pane_row_w: f32,
    /// The pane folded the sidebar away when it opened, and gives it back on close.
    pub pane_folded_sidebar: bool,
    /// When the open chat was last looked at in the background.
    pub synced_at: std::time::Instant,
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
    /// "Find…", while it is open, and the approved facts it lists.
    pub find: Option<Find>,
    pub find_facts: Load<Vec<crate::api::Fact>>,
    /// The reasoning effort picked for a model (`value`, effort); it applies only to that model.
    pub reasoning: Option<(String, String)>,
    /// A reply that just arrived, revealed word by word (its text, and when the reveal began),
    /// and whether the next loaded conversation brings one.
    pub reveal: Option<(String, std::time::Instant)>,
    pub reveal_next: bool,
    /// The answer a finished turn streamed, kept on screen until the stored reply loads in its place.
    pub pending_answer: Option<String>,
    /// The model picker's search, while it is open.
    pub model_query: Option<TextEdit>,
    /// Finished replies whose work log is open, and copied messages.
    pub open_logs: std::collections::BTreeSet<(usize, usize)>,
    pub open_sources: std::collections::BTreeSet<usize>,
    pub copied: Option<usize>,
    /// Where updating the app stands (the account menu's update row).
    pub update: crate::update::Update,
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
    /// Unsent text per chat, kept on disk between launches, and the chat the composer holds now.
    pub drafts: crate::drafts::Drafts,
    pub draft_key: String,
    /// Which sent message ↑ brought back, counting back from the newest.
    pub history_at: Option<usize>,
    /// Replies rated in this chat, by message index: true for helpful (kept in the app only).
    pub rated: std::collections::HashMap<(String, usize), bool>,
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

/// The server chosen at sign-in, kept in the preferences.
static SERVER: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The API this app talks to: `OPENRECORD_API_URL` when set (development),
/// else the server chosen at sign-in, else the one on this Mac.
pub fn api_base() -> String {
    std::env::var(API_ENV).ok().or_else(|| SERVER.lock().ok().and_then(|s| s.clone())).unwrap_or_else(|| DEFAULT_API.to_string())
}

impl App {
    pub fn new() -> App {
        if let Ok(mut server) = SERVER.lock() {
            *server = crate::prefs::Prefs::load().server;
        }
        let base = api_base();
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
            notices_open: false,
            notices_hidden: std::collections::BTreeSet::new(),
            metric_pick: std::collections::HashMap::new(),
            server: TextEdit::new(""),
            server_open: false,
            account_email: remembered_email(),
            businesses: Vec::new(),
            active: None,
            chats: Vec::new(),
            show_all_chats: false,
            decisions: Vec::new(),
            view: View::Agent,
            page: Page::Inbox,
            sidebar_open: true,
            sidebar_peek: false,
            menu: None,
            overview: Load::Idle,
            issues: Load::Idle,
            channels: Load::Idle,
            campaigns: Load::Idle,
            campaign_filter: String::new(),
            campaign_open: None,
            usage: Load::Idle,
            usage_days: 30,
            portfolio: Load::Idle,
            client_rows: Load::Idle,
            list_query: TextEdit::new(""),
            channel_status: Load::Idle,
            channel_tools: false,
            channel_open: None,
            campaign_edit: None,
            choice: None,
            add_business: None,
            issue_query: IssueQuery::default(),
            portfolio_sort: PortfolioSort::Attention,
            split_w: 0.0,
            window: (0.0, 0.0),
            resizing: None,
            map_zoom: 1.0,
            map_center: crate::ui::world::HOME,
            map_w: 0.0,
            map_drag: None,
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
            pending_answer: None,
            reasoning: None,
            general: false,
            proposals: Load::Idle,
            drafts_open: false,
            helper: None,
            settle_next: false,
            syncing: false,
            pane: false,
            pane_split: PANE_DEFAULT,
            pane_row_w: 0.0,
            pane_folded_sidebar: false,
            synced_at: std::time::Instant::now(),
            new_chat: None,
            find: None,
            find_facts: Load::Idle,
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
            update: crate::update::Update::Unknown,
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
            drafts: crate::drafts::Drafts::load(),
            draft_key: String::new(),
            history_at: None,
            rated: Default::default(),
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

    /// Opens the item `by` places above or below the open one.
    pub fn step_decision(&mut self, by: i32) {
        let keys: Vec<String> = self.inbox().iter().map(|d| d.key.clone()).collect();
        let Some(open) = self.open_decision().map(|d| d.key.clone()) else { return };
        let at = keys.iter().position(|k| k == &open).unwrap_or(0) as i32;
        let next = (at + by).clamp(0, keys.len() as i32 - 1) as usize;
        if let Some(k) = keys.get(next).cloned() {
            self.select_decision(&k);
        }
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
        // Look for a newer version once at launch, so the account menu can offer it.
        self.check_update();
    }

    /// Asks GitHub for a newer version, unless a check or an install is under way.
    pub fn check_update(&mut self) {
        use crate::update::Update;
        if !self.net.live() || matches!(self.update, Update::Checking | Update::Installing(_)) {
            return;
        }
        self.update = Update::Checking;
        self.net.check_update();
    }

    /// Downloads and installs the newer version, then restarts into it.
    pub fn install_update(&mut self) {
        use crate::update::Update;
        let Update::Available(r) = &self.update else { return };
        let r = r.clone();
        self.update = Update::Installing(r.version.clone());
        self.net.install_update(r);
    }

    pub fn submit_signin(&mut self) {
        let email = self.email.text.trim().to_string();
        let password = self.password.text.clone();
        if email.is_empty() || password.is_empty() {
            self.signin_error = Some("Enter your email and password.".into());
            return;
        }
        // A server typed on the sign-in card replaces the one in use before the sign-in is sent.
        if self.server_open {
            match crate::api::server_url(&self.server.text) {
                Ok(base) if base != api_base() => {
                    self.prefs.server = Some(base.clone());
                    self.prefs.save();
                    if let Ok(mut server) = SERVER.lock() {
                        *server = Some(base.clone());
                    }
                    self.net.rebase(api_base());
                }
                Ok(_) => {}
                Err(e) => {
                    self.signin_error = Some(e);
                    return;
                }
            }
            self.server_open = false;
        }
        self.signin_error = None;
        self.signing_in = true;
        remember_email(&email);
        self.account_email = Some(email.clone());
        self.net.signin(email, password);
    }

    /// Shows the server field on the sign-in card, filled with the server in use.
    pub fn edit_server(&mut self) {
        self.server.replace_text(&api_base());
        self.server_open = true;
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
        // Another business closes the pane: it belongs to the business it opened on.
        self.close_pane();
        self.overview = Load::Idle;
        self.issues = Load::Idle;
        self.channels = Load::Idle;
        self.campaigns = Load::Idle;
        self.answer = None;
        self.campaign_open = None;
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
        if view == View::Agent {
            self.close_pane();
        }
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

    /// Opens a campaign in the editor, or a new brief (`None`); with unsaved
    /// changes it asks first, as the web's discard dialog does.
    pub fn open_campaign(&mut self, c: Option<crate::api::Campaign>) {
        if let Some(e) = self.campaign_edit.as_mut().filter(|e| e.dirty) {
            e.pending = Some(c);
            return;
        }
        let c = c.unwrap_or_else(|| crate::api::Campaign { id: crate::api::uuid(), status: "DRAFT".into(), decision: "UNDECIDED".into(), ..Default::default() });
        self.campaign_edit = Some(CampaignEdit::new(c));
    }

    /// Discards unsaved edits and opens what was waiting.
    pub fn discard_campaign_changes(&mut self) {
        let next = self.campaign_edit.as_mut().and_then(|e| e.pending.take());
        if let Some(e) = self.campaign_edit.as_mut() {
            e.dirty = false;
        }
        if let Some(c) = next {
            self.open_campaign(c);
        }
    }

    /// Changes one of the brief's choices (stage, decision, motion, funnel stage).
    pub fn set_campaign_choice(&mut self, which: &str, value: &str) {
        let Some(e) = self.campaign_edit.as_mut() else { return };
        let c = &mut e.campaign;
        match which {
            "status" => c.status = value.into(),
            "decision" => c.decision = value.into(),
            "motion" => c.motion = value.into(),
            "funnelStage" => c.funnel_stage = value.into(),
            _ => return,
        }
        e.dirty = true;
    }

    /// Changes a deliverable's channel or status.
    pub fn set_task_choice(&mut self, i: usize, which: &str, value: &str) {
        let Some(e) = self.campaign_edit.as_mut() else { return };
        if let Some(t) = e.campaign.tasks.get_mut(i) {
            if which == "channel" { t.channel = value.into() } else { t.status = value.into() }
            e.dirty = true;
        }
    }

    pub fn add_task(&mut self) {
        let Some(e) = self.campaign_edit.as_mut() else { return };
        if e.campaign.tasks.len() >= 100 {
            return;
        }
        let mut c = e.current();
        c.tasks.push(crate::api::CampaignTask { id: crate::api::uuid(), title: "New deliverable".into(), channel: "WEBSITE".into(), status: "TODO".into(), ..Default::default() });
        let dirty = true;
        let mut next = CampaignEdit::new(c);
        next.dirty = dirty;
        next.campaign.revision = e.campaign.revision;
        *e = next;
    }

    pub fn remove_task(&mut self, i: usize) {
        let Some(e) = self.campaign_edit.as_mut() else { return };
        let mut c = e.current();
        if i < c.tasks.len() {
            c.tasks.remove(i);
        }
        let mut next = CampaignEdit::new(c);
        next.dirty = true;
        *e = next;
    }

    /// Starts the next experiment from a closed one (the web's "Start the next experiment").
    pub fn next_experiment(&mut self) {
        let Some(e) = self.campaign_edit.as_mut() else { return };
        if e.dirty {
            e.error = Some("Save your learning before starting the next experiment.".into());
            return;
        }
        let was = e.current();
        let mut c = crate::api::Campaign { id: crate::api::uuid(), status: "DRAFT".into(), decision: "UNDECIDED".into(), ..Default::default() };
        c.title = format!("Next: {}", was.title).chars().take(200).collect();
        c.goal = was.goal;
        c.audience = was.audience;
        c.hypothesis = was.next_move;
        c.baseline = was.result.chars().take(500).collect();
        self.campaign_edit = Some(CampaignEdit::new(c));
    }

    pub fn save_campaign(&mut self) {
        let Some(b) = self.active.clone() else { return };
        let Some(e) = self.campaign_edit.as_mut() else { return };
        if e.saving {
            return;
        }
        e.saving = true;
        e.error = None;
        self.net.save_campaign(b, e.current());
    }

    /// Opens "Add a business" (the web's `CreateBusinessDialog`).
    pub fn open_add_business(&mut self, engagement: Option<&'static str>) {
        self.menu = None;
        self.new_chat = None;
        self.add_business = Some(AddBusiness { text: TextEdit::new(""), engagement, busy: false, error: None });
    }

    pub fn submit_add_business(&mut self) {
        let Some(a) = self.add_business.as_mut() else { return };
        if a.busy {
            return;
        }
        let (website, goal) = crate::setup::parse_start(&a.text.text);
        let Some(website) = website else {
            a.error = Some("Add your website address, like acme.com".into());
            return;
        };
        a.busy = true;
        a.error = None;
        let engagement = a.engagement;
        self.net.start_setup(website, goal, engagement);
    }

    /// Opens (or closes) a form's select.
    pub fn open_choice(&mut self, c: Choice) {
        if self.choice.as_ref().is_some_and(|x| x.anchor == c.anchor) && self.menu == Some(Menu::Choice) {
            self.menu = None;
            self.choice = None;
        } else {
            self.choice = Some(c);
            self.menu = Some(Menu::Choice);
        }
    }

    pub fn pick_choice(&mut self, value: &str) {
        self.menu = None;
        if let Some(c) = self.choice.take() {
            match c.target {
                ChoiceTarget::Campaign(which) => self.set_campaign_choice(which, value),
                ChoiceTarget::Task(i, which) => self.set_task_choice(i, which, value),
            }
        }
    }

    pub fn set_issue_state(&mut self, state: &str) {
        self.issue_query.state = state.to_string();
        self.issue_query.page = 1;
    }

    pub fn set_issue_view(&mut self, answers: bool) {
        self.issue_query.answers = answers;
        self.issue_query.sort.clear();
        self.issue_query.page = 1;
    }

    pub fn set_issue_provider(&mut self, provider: &str) {
        self.issue_query.provider = provider.to_string();
        self.issue_query.page = 1;
    }

    pub fn set_issue_filter_fact(&mut self, fact: &str) {
        self.issue_query.fact = fact.to_string();
        self.issue_query.page = 1;
    }

    pub fn set_issue_sort(&mut self, sort: &str) {
        self.issue_query.sort = sort.to_string();
        self.issue_query.page = 1;
    }

    pub fn clear_issue_filters(&mut self) {
        let q = &mut self.issue_query;
        q.q.clear();
        q.provider = "all".into();
        q.fact = "all".into();
        q.state = "ALL".into();
        q.page = 1;
    }

    pub fn toggle_issue_group(&mut self, key: &str) {
        if !self.issue_query.open.remove(key) {
            self.issue_query.open.insert(key.to_string());
        }
    }

    /// Writes the filtered answers as CSV to Downloads, as the web's "Export CSV" downloads them.
    pub fn export_issues(&mut self) {
        let list = crate::ui::issues::visible(self);
        if list.is_empty() {
            return;
        }
        let name = self.active_business().map(|b| b.name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>()).unwrap_or_else(|| "business".into());
        let dir = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Downloads")).unwrap_or_else(std::env::temp_dir);
        let path = dir.join(format!("openrecord-issues-{name}.csv"));
        self.notice = Some(match std::fs::write(&path, crate::ui::issues::csv(&list)) {
            Ok(()) => format!("Saved {} answers to {}.", list.len(), path.display()),
            Err(e) => format!("The CSV could not be saved: {e}"),
        });
    }

    pub fn set_usage_days(&mut self, days: u32) {
        if self.usage_days != days {
            self.usage_days = days;
            self.usage = Load::Loading;
            self.net.usage(days);
        }
    }

    /// Opens one of a business's pages from an account page: that business, its Overview.
    pub fn open_business(&mut self, id: &str) {
        self.select_business(id);
        self.show_page(Page::Overview);
    }

    pub fn show_page(&mut self, page: Page) {
        self.view = View::Workspace;
        self.page = page;
        self.answer = None;
        self.campaign_open = None;
        self.list_query.clear();
        self.load_page();
    }

    /// Fetches what the page on screen shows, every time it opens, as the
    /// web pages do on mount.
    fn load_page(&mut self) {
        if self.view != View::Workspace {
            return;
        }
        // The account pages need no business.
        match self.page {
            Page::Usage => {
                self.usage = keep_or_load(&self.usage);
                self.net.usage(self.usage_days);
                return;
            }
            Page::Businesses => {
                self.portfolio = keep_or_load(&self.portfolio);
                self.net.portfolio(self.businesses.iter().map(|b| (b.id.clone(), b.name.clone())).collect());
                return;
            }
            Page::Clients => {
                self.client_rows = keep_or_load(&self.client_rows);
                self.net.client_rows();
                return;
            }
            _ => {}
        }
        let Some(id) = self.active.clone() else { return };
        match self.page {
            Page::Usage | Page::Businesses | Page::Clients => {}
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
                self.net.issues(id.clone());
                // The page opens with the AI discovery summary the Overview reads.
                if !matches!(self.insights, Load::Ready(_) | Load::Loading) {
                    self.insights = Load::Loading;
                    self.net.insights(id, self.days);
                }
            }
            Page::Channels => {
                self.channels = keep_or_load(&self.channels);
                self.channel_status = keep_or_load(&self.channel_status);
                self.net.channel_status(id.clone());
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
        self.campaign_open = None;
        self.list_query.clear();
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
            if matches!(self.turn, Turn::Working { .. }) {
                self.net.conversation(scope, chat);
            } else {
                self.syncing = true;
                self.net.sync(scope, chat);
            }
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
    /// Opens "Find…", or closes it when it is open (F and ⌘K toggle it, as on the web).
    /// Claims and facts load only while it is open.
    pub fn toggle_find(&mut self, tx: &mut Tx) {
        if self.find.take().is_some() {
            return;
        }
        self.menu = None;
        self.find = Some(Find { query: TextEdit::new(""), index: 0 });
        if let Some(b) = self.active.clone() {
            if self.issues.ready().is_none() {
                self.net.issues(b.clone());
            }
            self.find_facts = Load::Loading;
            self.net.facts(b);
        }
        tx.focus("find-query", false);
    }

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

    /// Hands the agent a request, as the web's "Ask the agent" links do: the
    /// business's current conversation opens with it typed in, never sent until
    /// the person sends it. On a workspace page it opens in the pane beside the
    /// page; elsewhere in the Agent view.
    pub fn ask_agent(&mut self, request: &str) {
        if self.pane_allowed() {
            self.open_pane(Some(request));
            return;
        }
        self.business_chat();
        self.enter_agent();
        self.composer.replace_text(request);
    }

    /// A general chat or a helper session on screen gives way to a new chat
    /// about the business; the business's own chat stays.
    fn business_chat(&mut self) {
        let helper = self.conversation.ready().is_some_and(|c| c.session.as_ref().is_some_and(|i| i.parent_session_id.is_some()));
        if self.general || helper || self.active.is_none() {
            let view = self.view;
            self.new_chat();
            self.view = view;
        }
    }

    /// Whether the page on screen is one the agent pane can open beside: a
    /// business's workspace page, not an account page.
    pub fn pane_allowed(&self) -> bool {
        self.view == View::Workspace && self.active.is_some() && !self.page.account() && self.settings.is_none()
    }

    /// Whether the agent pane is on screen.
    pub fn pane_shown(&self) -> bool {
        self.pane && self.pane_allowed()
    }

    /// Whether a conversation is on screen, full or in the pane.
    pub fn chat_shown(&self) -> bool {
        (self.view == View::Agent && (self.active.is_some() || self.general)) || self.pane_shown()
    }

    /// How large the interface draws: everything inside the window is laid out in
    /// points divided by this, so sizes measured in window points divide by it too.
    pub fn zoom(&self) -> f32 {
        self.prefs.zoom()
    }

    /// ⌘+, ⌘− and ⌘0.
    pub fn zoom_by(&mut self, dir: i32) {
        if dir == 0 {
            self.prefs.zoom = crate::prefs::ZOOM_DEFAULT;
        } else {
            self.prefs.step_zoom(dir);
        }
        self.prefs.save();
    }

    /// Whether the sidebar shows in full: docked open, or over the page on hover.
    pub fn sidebar_full(&self) -> bool {
        self.sidebar_open || self.sidebar_peek
    }

    /// Docks or collapses the sidebar (⌘B and the header's button).
    pub fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
        self.sidebar_peek = false;
    }

    /// Opens the agent beside the page, with a request typed in when there is
    /// one. The sidebar folds away so the page keeps its room.
    pub fn open_pane(&mut self, request: Option<&str>) {
        self.menu = None;
        self.business_chat();
        if !self.pane {
            self.pane = true;
            if self.sidebar_open {
                self.sidebar_open = false;
                self.pane_folded_sidebar = true;
            }
        }
        if let Some(r) = request {
            self.composer.replace_text(r);
        }
        if let (Some(scope), Some(id)) = (self.chat_scope(), self.chat_id.clone()) {
            if self.conversation.ready().is_none_or(|c| c.id != id) && !matches!(self.conversation, Load::Loading) {
                self.conversation = Load::Loading;
                self.syncing = true;
                self.net.sync(scope, id);
            }
        }
    }

    /// Closes the pane and gives the sidebar back if the pane folded it.
    pub fn close_pane(&mut self) {
        if !self.pane {
            return;
        }
        self.pane = false;
        self.helper = None;
        if std::mem::take(&mut self.pane_folded_sidebar) {
            self.sidebar_open = true;
        }
    }

    /// Goes to the full Agent view; the pane gives way to it.
    fn enter_agent(&mut self) {
        self.close_pane();
        self.view = View::Agent;
    }

    /// Opens one of a business's conversations, such as the one a decision came from.
    pub fn open_business_chat(&mut self, business: &str, id: &str) {
        if !business.is_empty() && self.active.as_deref() != Some(business) {
            self.select_business(business);
        }
        self.general = business.is_empty();
        self.helper = None;
        self.open_session(id);
    }

    /// Home: the agent with a fresh chat for the business on screen, and what waits on the person.
    pub fn go_home(&mut self) {
        self.menu = None;
        self.new_chat();
        self.net.decisions();
    }

    pub fn new_chat(&mut self) {
        self.enter_agent();
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
        self.enter_agent();
        self.chat_id = Some(chat.id.clone());
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        self.settle_next = true;
        if let Some(scope) = self.chat_scope() {
            self.syncing = true;
            self.net.sync(scope, chat.id.clone());
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
        self.enter_agent();
        self.chat_id = Some(id.to_string());
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        self.settle_next = true;
        self.open_logs.clear();
        self.open_sources.clear();
        if let Some(scope) = self.chat_scope() {
            self.syncing = true;
            self.net.sync(scope, id.to_string());
        }
    }

    pub fn stop_turn(&mut self) {
        let (Some(b), Some(c)) = (self.chat_scope(), self.chat_id.clone()) else { return };
        if let Turn::Working { stopping, request, .. } = &mut self.turn {
            *stopping = true;
            self.net.cancel(b, c, request.clone());
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
        // ↑ in an empty composer brings back the last message you sent; ↑ and ↓
        // then step through the earlier ones, as a terminal does.
        if !ev.mods.cmd && !ev.mods.ctrl && !ev.mods.alt && matches!(ev.key, rune::Key::Up | rune::Key::Down) && !self.composer.text.starts_with('/') {
            let sent: Vec<String> = self.transcript().into_iter().filter(|m| m.role == "user" && !m.text.trim().is_empty()).map(|m| m.text).collect();
            let browsing = self.history_at.is_some_and(|i| sent.iter().rev().nth(i).is_some_and(|t| *t == self.composer.text));
            if !sent.is_empty() && (self.composer.text.is_empty() || browsing) {
                let next = match (ev.key.clone(), self.history_at.filter(|_| browsing)) {
                    (rune::Key::Up, None) => Some(0),
                    (rune::Key::Up, Some(i)) => Some((i + 1).min(sent.len() - 1)),
                    (_, Some(0)) | (_, None) => None,
                    (_, Some(i)) => Some(i - 1),
                };
                self.history_at = next;
                match next.and_then(|i| sent.iter().rev().nth(i)) {
                    Some(text) => self.composer.replace_text(text),
                    None => self.composer.clear(),
                }
                return true;
            }
        }
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
    /// A paste into the composer: files attach as a drop does, long text becomes
    /// an attachment instead of flooding the box, and an image says it can't be
    /// sent yet. Anything else pastes as usual (false).
    pub fn composer_paste(&mut self, content: &rune::ClipboardContent) -> bool {
        if !content.files().is_empty() {
            for p in content.files().to_vec() {
                self.attach_path(&p);
            }
            return true;
        }
        if content.image().is_some() && content.text().trim().is_empty() {
            self.attach_error = Some("Images can't be attached yet. Paste text, or attach a text, Markdown, CSV or JSON file.".into());
            return true;
        }
        let text = content.text();
        let lines = text.lines().count();
        if text.chars().count() > crate::chat::PASTE_AS_FILE_CHARS || lines > crate::chat::PASTE_AS_FILE_LINES {
            if self.attachments.len() >= crate::chat::MAX_FILES {
                self.attach_error = Some("You can attach up to three files.".into());
                return true;
            }
            let used: usize = self.attachments.iter().map(|a| a.text.chars().count()).sum();
            if used + text.chars().count() > crate::chat::MAX_ATTACHMENT_CHARS {
                self.attach_error = Some("That paste is too long. Attachments can be 80,000 characters together.".into());
                return true;
            }
            let n = self.attachments.iter().filter(|a| a.name.starts_with("Pasted text")).count();
            let name = if n == 0 { "Pasted text".to_string() } else { format!("Pasted text {}", n + 1) };
            self.attachments.push(crate::chat::Attachment { name, kind: "text/plain".into(), text: text.to_string() });
            self.attach_error = None;
            return true;
        }
        false
    }

    /// Keeps the composer's text as the draft of the chat it belongs to: on a
    /// switch of chat the old text is saved and the new chat's draft comes back.
    pub fn sync_draft(&mut self) {
        let key = format!("{}:{}", self.chat_scope().unwrap_or_else(|| "general".into()), self.chat_id.clone().unwrap_or_else(|| "new".into()));
        if key != self.draft_key {
            let restored = self.drafts.get(&key).to_string();
            self.draft_key = key;
            self.history_at = None;
            if self.composer.text != restored {
                self.composer.replace_text(&restored);
            }
        } else if self.drafts.get(&self.draft_key) != self.composer.text {
            let k = self.draft_key.clone();
            self.drafts.set(&k, &self.composer.text);
        }
    }

    /// Marks a reply helpful or not (pressing the same again clears it).
    pub fn rate_reply(&mut self, i: usize, good: bool) {
        let key = (self.chat_id.clone().unwrap_or_default(), i);
        if self.rated.get(&key) == Some(&good) {
            self.rated.remove(&key);
        } else {
            self.rated.insert(key, good);
        }
    }

    /// Asks the question behind the latest reply again.
    pub fn retry_reply(&mut self, tx: &mut Tx) {
        if matches!(self.turn, Turn::Working { .. }) {
            return;
        }
        let Some(q) = self.transcript().into_iter().rev().find(|m| m.role == "user" && !m.text.trim().is_empty()).map(|m| m.text) else { return };
        self.dispatch(q, tx);
    }

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
        // The sent message and the bottom of the chat land at once, with no glide up.
        tx.instant();
        tx.scroll_to_bottom("transcript");
    }

    // ---- Replies --------------------------------------------------------

    /// Applies the replies that have landed; true when anything changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        self.sync_draft();
        let replies = self.net.take();
        let mut changed = !replies.is_empty();
        for r in replies {
            self.apply(r, tx);
        }
        // The Realtime globe turns while it is on screen.
        if self.view == View::Workspace && self.page == Page::Overview && self.section == crate::insights::Section::Realtime && !self.prefs.reduce_motion {
            tx.wake_after(std::time::Duration::from_millis(40));
            changed = true;
        }
        // While a turn runs, the thinking glyph steps every 220 milliseconds and the clock ticks.
        if matches!(self.turn, Turn::Working { .. }) && !self.prefs.reduce_motion {
            tx.wake_after(std::time::Duration::from_millis(220));
            changed = true;
        }
        self.sync_open_chat(tx);
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

    /// Keeps the open chat current while it sits idle on screen, as the web's
    /// chat does: every 4 seconds while a helper it started still works (its
    /// result and the turn after it land on the server), otherwise every 20
    /// seconds, which also picks up a turn started on another device or a
    /// follow-up posted into the chat.
    fn sync_open_chat(&mut self, tx: &mut Tx) {
        if self.screen != Screen::Workspace || !self.chat_shown() || self.syncing || !matches!(self.turn, Turn::Idle) {
            return;
        }
        let (Some(scope), Some(id)) = (self.chat_scope(), self.chat_id.clone()) else { return };
        let Some(c) = self.conversation.ready().filter(|c| c.id == id) else { return };
        let every = std::time::Duration::from_secs(if helpers_working(&c.messages) { 4 } else { 20 });
        let since = self.synced_at.elapsed();
        if since >= every {
            self.syncing = true;
            self.synced_at = std::time::Instant::now();
            self.net.sync(scope, id);
        } else {
            tx.wake_after(every - since);
        }
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
            Reply::Facts(b, r) if here(self, &b) => self.find_facts = to_load(self.failed(r)),
            Reply::Facts(..) => {}
            Reply::Channels(b, r) if here(self, &b) => self.channels = to_load(self.failed(r)),
            Reply::Campaigns(b, r) if here(self, &b) => self.campaigns = to_load(self.failed(r)),
            Reply::Usage(days, r) if days == self.usage_days => self.usage = to_load(self.failed(r)),
            Reply::Usage(..) => {}
            Reply::SetupStarted(r) => match r {
                Ok(id) => {
                    // As the web does: the list reloads and the new business's agent opens.
                    self.add_business = None;
                    self.net.workspace();
                    self.select_business(&id);
                    self.show_view(View::Agent);
                }
                Err(ApiError::Unauthorized) => {
                    let _ = self.failed::<()>(Err(ApiError::Unauthorized));
                }
                Err(e) => {
                    if let Some(a) = self.add_business.as_mut() {
                        a.busy = false;
                        a.error = Some(crate::setup::setup_error(&e));
                    }
                }
            },
            Reply::CampaignSaved(b, r) if here(self, &b) => {
                let r = match r {
                    Ok(saved) => Ok(saved),
                    Err(ApiError::Unauthorized) => Err(self.failed::<()>(Err(ApiError::Unauthorized)).err().unwrap_or_default()),
                    Err(ApiError::Status(409, _)) => Err("Someone changed this campaign. Keep your draft, then reopen the latest version before saving.".to_string()),
                    Err(ApiError::Status(422, body)) => Err(serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("reason").and_then(|x| x.as_str()).map(str::to_string))
                        .unwrap_or_else(|| "Could not save the campaign. Your draft is still here.".into())),
                    Err(_) => Err("Could not save the campaign. Your draft is still here.".to_string()),
                };
                match r {
                    Ok(saved) => {
                        self.campaign_edit = Some(CampaignEdit::new(saved));
                        if let Some(id) = self.active.clone() {
                            self.net.campaigns(id);
                        }
                    }
                    Err(msg) => {
                        if let Some(e) = self.campaign_edit.as_mut() {
                            e.saving = false;
                            e.error = Some(msg);
                        }
                    }
                }
            }
            Reply::CampaignSaved(..) => {}
            Reply::ChannelStatus(b, r) if here(self, &b) => self.channel_status = to_load(self.failed(r)),
            Reply::ChannelStatus(..) => {}
            Reply::Portfolio(r) => self.portfolio = to_load(self.failed(r)),
            Reply::ClientRows(r) => self.client_rows = to_load(self.failed(r)),
            Reply::Conversation(b, r) if self.chat_scope().as_deref() == Some(b.as_str()) => {
                self.syncing = false;
                self.synced_at = std::time::Instant::now();
                match self.failed(r) {
                    // Nothing new since the chat on screen: leave it, and its scroll, as they are.
                    Ok(Some(c)) if self.conversation.ready().is_some_and(|o| o.id == c.id && o.revision >= c.revision) && matches!(self.turn, Turn::Idle) && self.queued.is_empty() => {
                        std::mem::take(&mut self.settle_next);
                        std::mem::take(&mut self.reveal_next);
                    }
                    Ok(Some(c)) if Some(&c.id) == self.chat_id.as_ref() => {
                        // Newer work landed while the chat sat idle (a helper's result or
                        // a follow-up): what it saved may wait for a decision.
                        if matches!(self.turn, Turn::Idle) && self.conversation.ready().is_some_and(|o| o.id == c.id) && c.messages.iter().any(|m| !m.decisions.is_empty()) {
                            self.net.decisions();
                            if !b.is_empty() {
                                self.net.proposals(b.clone());
                            }
                        }
                        // A chat opened from the history shows as it is: no message slides in.
                        if std::mem::take(&mut self.settle_next) {
                            tx.settle();
                        }
                        self.pending_answer = None;
                        if std::mem::take(&mut self.reveal_next) {
                            if let Some(m) = c.messages.last().filter(|m| m.role != "user") {
                                self.reveal = Some((m.text.clone(), std::time::Instant::now()));
                            }
                        }
                        self.conversation = Load::Ready(c);
                        tx.instant();
                        tx.scroll_to_bottom("transcript");
                        // The reply is in and the revision current: the next queued message goes.
                        if matches!(self.turn, Turn::Idle) && !self.queued.is_empty() {
                            let next = self.queued.remove(0);
                            self.dispatch(next, tx);
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => self.conversation = Load::Failed("This chat no longer exists.".into()),
                    // A background look that failed keeps the chat on screen; the next one tries again.
                    Err(_) if self.conversation.ready().is_some_and(|o| Some(&o.id) == self.chat_id.as_ref()) => {}
                    Err(e) => self.conversation = Load::Failed(e),
                }
            }
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
            Reply::TurnResumed { business, conversation, request, message } => {
                self.syncing = false;
                self.synced_at = std::time::Instant::now();
                if self.chat_scope().as_deref() == Some(business.as_str()) && self.chat_id.as_deref() == Some(conversation.as_str()) && matches!(self.turn, Turn::Idle) {
                    self.open_logs.retain(|(i, _)| *i != usize::MAX);
                    self.turn = Turn::Working { message, request: Some(request), progress: Default::default(), started: std::time::Instant::now(), stopping: false };
                    // What the chat said before the turn shows while it runs.
                    if self.conversation.ready().is_none_or(|c| c.id != conversation) {
                        self.net.conversation(business, conversation);
                    }
                    tx.scroll_to_bottom("transcript");
                }
            }
            Reply::CancelFailed => {
                if let Turn::Working { stopping, .. } = &mut self.turn {
                    *stopping = false;
                }
                self.notice = Some("Couldn't stop the agent. Try again.".into());
            }
            Reply::TurnDone { business, conversation, request, result } => {
                self.net.chats();
                if self.chat_scope().as_deref() != Some(business.as_str()) || self.chat_id.as_deref().is_some_and(|c| c != conversation) {
                    return;
                }
                // A turn this window no longer follows, such as one picked up while
                // another was being sent: the turn on screen settles on its own.
                if let (Turn::Working { request: Some(on_screen), .. }, Some(done)) = (&self.turn, &request) {
                    if on_screen != done {
                        return;
                    }
                }
                if request.is_some() && !matches!(self.turn, Turn::Working { .. }) {
                    return;
                }
                match self.failed(result) {
                    Ok(()) => {
                        // An answer that was shown as it was written stays until the stored
                        // reply replaces it, and is not replayed word by word.
                        self.pending_answer = match &self.turn {
                            Turn::Working { progress, .. } if !progress.answer.is_empty() => Some(progress.answer.clone()),
                            _ => None,
                        };
                        self.turn = Turn::Idle;
                        if !business.is_empty() {
                            self.net.proposals(business.clone());
                        }
                        // A reply that arrives all at once is revealed word by word once it loads.
                        self.reveal_next = self.pending_answer.is_none() && rune::tooling::headless_run().is_none() && !self.prefs.reduce_motion;
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
                let api = api_base();
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
            Reply::UpdateChecked(r) => {
                use crate::update::Update;
                // A check that lands during an install leaves the install alone.
                if !matches!(self.update, Update::Installing(_)) {
                    self.update = match r {
                        Ok(Some(rel)) => Update::Available(rel),
                        Ok(None) => Update::UpToDate,
                        Err(e) => Update::Failed(e),
                    };
                }
            }
            Reply::UpdateInstalled(Ok(())) => tx.quit(),
            Reply::UpdateInstalled(Err(e)) => self.update = crate::update::Update::Failed(e),
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

/// The agent pane's share when it first opens, and on a double-click of its edge.
pub const PANE_DEFAULT: f32 = 50.0;

/// Whether a helper session the chat started is still working: each task's
/// latest status, since a later message (its posted result) supersedes the
/// card that started it.
fn helpers_working(messages: &[Message]) -> bool {
    let mut latest = std::collections::HashMap::new();
    for t in messages.iter().flat_map(|m| m.tasks.iter()) {
        latest.insert(t.id.as_str(), t.status.as_str());
    }
    latest.values().any(|s| *s == "RUNNING")
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

#[cfg(test)]
mod agent_sync_tests {
    use super::*;

    #[test]
    fn a_helper_works_until_its_result_supersedes_its_card() {
        let msg = |status: &str| -> Message {
            serde_json::from_value(serde_json::json!({ "role": "agent", "text": "", "tasks": [{ "id": "t1", "sessionId": "s2", "title": "Research", "role": "researcher", "status": status }] })).unwrap()
        };
        assert!(helpers_working(&[msg("RUNNING")]));
        assert!(!helpers_working(&[msg("RUNNING"), msg("COMPLETED")]));
        assert!(!helpers_working(&[]));
    }
}
