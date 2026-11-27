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

#[derive(Debug, Clone)]
pub struct AddBusiness {
    pub text: TextEdit,
    /// "CLIENT" for a client's business, "DOGFOOD" for our own; None as the web's plain dialog.
    pub engagement: Option<&'static str>,
    pub busy: bool,
    pub error: Option<String>,
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

/// Which chat box something came from: the main one, or the right panel's
/// under an artifact or helper. Their keys differ so each anchors its own menus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ComposerSlot {
    #[default]
    Main,
    Side,
}

impl ComposerSlot {
    pub fn key(self, name: &str) -> String {
        match self {
            ComposerSlot::Main => name.to_string(),
            ComposerSlot::Side => format!("side-{name}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Model,
    Reasoning,
    ChatFilter,
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
    /// A re-check request is on its way.
    pub rechecking: bool,
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
            rechecking: false,
        }
    }
}

/// The "Save as playbook" dialog.
/// Undoing the chat from one of the person's messages, while it asks to confirm.
pub struct UndoTurn {
    /// The message's place in the chat, and the chat it was in.
    pub index: usize,
    pub conversation: String,
    pub revision: i64,
    pub text: String,
    /// Kept across a retried click, so the server undoes once.
    pub request: String,
    pub busy: bool,
    pub error: Option<String>,
}

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

/// How the sidebar folds and the page widens into its place: no bounce.
pub const SIDEBAR_SPRING: rune::Spring = rune::Spring::new(0.38, 0.0);

/// `SIDEBAR_SPRING` from 0 to 1 (critically damped, as Rune samples it), so native
/// panes keep step with the panel they sit in.
fn spring_progress(seconds: f32) -> f32 {
    let x = std::f32::consts::TAU / SIDEBAR_SPRING.duration * seconds.max(0.0);
    1.0 - (1.0 + x) * (-x).exp()
}

/// The sidebar on the move: when it started, and where each native pane was drawn.
pub struct SidebarSlide {
    pub started: std::time::Instant,
    pub from: [Option<[f32; 4]>; 3],
}

/// What picking a business in the picker does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerMode {
    /// From the sidebar: switch to that business.
    Switch,
    /// From the composer's folder chip: start a chat about that business (or a general one).
    Chat,
}

/// The business picker: the businesses as a searchable list in a floating panel.
pub struct BusinessPicker {
    pub mode: PickerMode,
    /// The highlighted card in the filtered list.
    pub focus: usize,
    pub query: rune::TextEdit,
}

impl BusinessPicker {
    fn new(mode: PickerMode, focus: usize) -> Self {
        BusinessPicker { mode, focus, query: rune::TextEdit::default() }
    }
}

/// One row in the business picker list: the business it picks (`None` is a general chat),
/// its name, and whether its numbers are sample data.
pub struct PickerCard {
    pub id: Option<String>,
    pub name: String,
    pub sample: bool,
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
    /// Whether Home shows instead of a chat transcript.
    pub home: bool,
    /// The decisions stack in the corner: whether it is spread out, and the ones put away with "Hide".
    pub notices_open: bool,
    pub notices_hidden: std::collections::BTreeSet<String>,
    /// The key number each source's wide chart shows on Analytics, by the source's key.
    pub metric_pick: std::collections::HashMap<String, usize>,
    /// Cached smoothed chart polylines; cleared when insights reload.
    pub chart_lines: std::cell::RefCell<crate::ui::LineCache>,
    /// Bucketed Realtime pulse so we do not rebuild between animation steps.
    pub realtime_pulse_bucket: u64,
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
    /// Skip split springs for one layout after dock/collapse so the right panel does not ease.
    /// The sidebar folding or unfolding, while it moves (`SidebarSlide`).
    pub sidebar_slide: Option<SidebarSlide>,
    pub menu: Option<Menu>,
    /// The business switcher: archived businesses (for restoring), whether they
    /// show, and whether "Archive" is waiting for its second press.
    pub archived_businesses: Vec<crate::api::Business>,
    pub show_archived_businesses: bool,
    pub confirm_archive: bool,

    pub overview: Load<Overview>,
    pub issues: Load<Vec<Issue>>,
    pub channels: Load<Vec<Channel>>,
    pub campaigns: Load<Vec<Campaign>>,
    /// The Campaigns page: the status shown ("" for all).
    pub campaign_filter: String,
    /// The Campaigns page's campaign open, by id.
    pub campaign_open: Option<String>,
    pub campaign_editor: Option<crate::campaign_edit::Editor>,
    pub campaign_withdraw_confirm: Option<String>,
    pub campaign_contacts: Option<(String, String)>,
    pub campaign_run_id: Option<String>,
    pub campaign_runs: Load<Vec<crate::api::CampaignRun>>,
    /// The timing of the campaign with this id, and its plot's measured width.
    pub campaign_timeline: Option<(String, crate::api::CampaignTimeline)>,
    pub campaign_plot_w: f32,
    /// The account pages: usage and its period, the businesses and clients
    /// lists, and the search and order those lists are in.
    pub usage: Load<crate::account::Usage>,
    pub usage_days: u32,
    pub portfolio: Load<Vec<crate::account::Portfolio>>,
    pub client_rows: Load<Vec<crate::account::ClientRow>>,
    pub list_query: TextEdit,
    /// The Channels page: its account statuses and the channel being set up.
    pub channel_status: Load<crate::channel_status::Status>,
    pub channel_setup: Option<crate::channel_setup::Setup>,
    pub channel_generation: u64,
    /// "Add a business": the line typed, whether it is a client or our own, and how it went.
    pub add_business: Option<AddBusiness>,
    pub issue_query: IssueQuery,
    pub portfolio_sort: PortfolioSort,
    /// The split's width, measured, for the share of the artifact or helper beside the panel.
    pub split_w: f32,
    /// The Analytics folder's measured width, in the window and in the side panel, for laying out its tabs.
    pub analytics_w: [f32; 2],
    /// The window's size in window points, measured, for the zoom.
    pub window: (f32, f32),
    /// The drag edge held right now, if any.
    pub resizing: Option<crate::ui::Resize>,
    /// Width and height when an answer-popup resize drag began.
    pub answer_dialog_resize: Option<(f32, f32)>,
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
    /// Debounced chart hover so moving across Analytics does not rebuild every column.
    chart_hover_pending: Option<(String, usize)>,
    chart_hover_at: Option<std::time::Instant>,
    /// The models the composer offers, the one picked, and the picker's filter.
    pub catalog: Load<Vec<crate::chat::ModelOption>>,
    pub agent_model: Option<String>,
    pub model_filter: Option<String>,
    /// The "/" menu: the playbooks it offers and the highlighted entry.
    pub playbooks: Vec<crate::chat::Playbook>,
    pub command_index: usize,
    pub timeline: crate::timeline::State,
    /// The composer's "+" menu and the dialogs it opens.
    pub chat_actions: bool,
    /// The chat box whose "+", model or reasoning menu is open, to anchor it there.
    pub composer_slot: ComposerSlot,
    pub composer_widths: [f32; 2],
    pub save_playbook: Option<SavePlaybook>,
    pub undo: Option<UndoTurn>,
    pub share: Option<ShareChat>,
    /// Automatic follow-ups for the business on screen, and their dialog.
    pub followups: Load<crate::followups::Followups>,
    pub brief_schedule: crate::brief_schedule::State,
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
    /// When the open chat was last looked at in the background.
    pub synced_at: std::time::Instant,
    /// The business's agent proposals, for the chat's work pane.
    pub proposals: Load<Vec<crate::api::Proposal>>,
    /// Accepted drafts in the work pane, folded open.
    pub drafts_open: bool,
    /// A helper session opened beside the conversation, to review (`?helper=` on the web).
    /// Helper sessions opened beside the conversation, each a tab of the right panel.
    pub helpers: Vec<(String, Load<crate::api::Conversation>)>,
    /// Artifacts opened beside the conversation, each a tab of the right panel.
    pub artifacts: Vec<crate::artifacts::Pane>,
    /// The panel on the right: the artifact or helper, and a browser, as tabs.
    pub side: crate::side::SidePanel,
    pub preview_rect: Option<[f32; 4]>,
    /// The agent transcript slot for `@pierre/words` in a WKWebView.
    pub words_rect: Option<[f32; 4]>,
    /// Lines added and removed per artifact, for the Changes pill above the composer.
    pub artifact_line_stats: std::collections::HashMap<String, (usize, usize)>,
    pub artifact_diff_pending: std::collections::HashSet<String>,
    /// The chat on screen has no business: a general chat (`/api/agent`).
    pub general: bool,
    /// "Start a new chat", while it is open.
    pub new_chat: Option<NewChat>,
    /// "Switch business", while it is open.
    pub business_picker: Option<BusinessPicker>,
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
    /// Messages sent to the run under way (steering), oldest first, and the next local number.
    pub steer: Vec<crate::chat::Steer>,
    pub steer_next: u64,
    /// The chat box's text when it last changed, and when: the feedforward
    /// row shows once the person has paused.
    pub composer_seen: (String, std::time::Instant),
    /// Answers picked for the agent's questions this session, by question id.
    pub blank_answers: std::collections::HashMap<String, String>,
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
    /// The business's research spending and monthly limit, and the limit box.
    pub research_spend: Load<crate::settings::ResearchSpend>,
    pub research_limit: TextEdit,
    pub research_limit_busy: bool,
    pub research_limit_error: Option<String>,
    pub providers: Load<crate::settings::Catalog>,
    pub open_models: std::collections::BTreeSet<String>,
    pub pairing: Load<crate::settings::Pairing>,
    pub settings_error: Option<String>,
    /// The computer whose Disconnect is waiting for a second press.
    pub confirming_revoke: Option<String>,
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
    /// The agent's message is shown in place of the open decision, and the piece of approved work that is (its title).
    pub inbox_message: bool,
    pub inbox_work: Option<String>,
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
    /// The notice on screen and when it appeared (for auto-dismiss).
    notice_track: Option<(String, std::time::Instant)>,
}

/// How long confirmation and error toasts stay on screen.
const NOTICE_SHOW: std::time::Duration = std::time::Duration::from_secs(5);

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
            home: true,
            notices_open: false,
            notices_hidden: std::collections::BTreeSet::new(),
            metric_pick: std::collections::HashMap::new(),
            chart_lines: std::cell::RefCell::new(crate::ui::LineCache::default()),
            realtime_pulse_bucket: u64::MAX,
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
            sidebar_slide: None,
            menu: None,
            archived_businesses: Vec::new(),
            show_archived_businesses: false,
            confirm_archive: false,
            overview: Load::Idle,
            issues: Load::Idle,
            channels: Load::Idle,
            campaigns: Load::Idle,
            campaign_filter: String::new(),
            campaign_open: None,
            campaign_editor: None,
            campaign_withdraw_confirm: None,
            campaign_contacts: None,
            campaign_run_id: None,
            campaign_runs: Load::Idle,
            campaign_timeline: None,
            campaign_plot_w: 0.0,
            usage: Load::Idle,
            usage_days: 30,
            portfolio: Load::Idle,
            client_rows: Load::Idle,
            list_query: TextEdit::new(""),
            channel_status: Load::Idle,
            channel_setup: None,
            channel_generation: 0,
            add_business: None,
            issue_query: IssueQuery::default(),
            portfolio_sort: PortfolioSort::Attention,
            split_w: 0.0,
            analytics_w: [0.0; 2],
            window: (0.0, 0.0),
            resizing: None,
            answer_dialog_resize: None,
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
            chart_hover_pending: None,
            chart_hover_at: None,
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
            helpers: Vec::new(),
            artifacts: Vec::new(),
            side: Default::default(),
            preview_rect: None,
            words_rect: None,
            artifact_line_stats: Default::default(),
            artifact_diff_pending: Default::default(),
            settle_next: false,
            syncing: false,
            synced_at: std::time::Instant::now(),
            new_chat: None,
            business_picker: None,
            find: None,
            find_facts: Load::Idle,
            row_hover: None,
            playbooks: Vec::new(),
            followups: Load::Idle,
            brief_schedule: crate::brief_schedule::State::default(),
            followups_open: false,
            followup_confirm: None,
            followup_saving: false,
            followup_error: None,
            command_index: 0,
            timeline: crate::timeline::State::default(),
            chat_actions: false,
            composer_slot: ComposerSlot::Main,
            composer_widths: [0.0; 2],
            save_playbook: None,
            undo: None,
            share: None,
            open_logs: Default::default(),
            open_sources: Default::default(),
            copied: None,
            update: crate::update::Update::Unknown,
            visual_tables: Default::default(),
            queued: Vec::new(),
            steer: Vec::new(),
            steer_next: 0,
            blank_answers: Default::default(),
            composer_seen: (String::new(), std::time::Instant::now()),
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
            research_spend: Load::Idle,
            research_limit: TextEdit::new(""),
            research_limit_busy: false,
            research_limit_error: None,
            providers: Load::Idle,
            open_models: Default::default(),
            pairing: Load::Idle,
            settings_error: None,
            confirming_revoke: None,
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
            inbox_message: false,
            inbox_work: None,
            declining: false,
            decline_reason: TextEdit::new(""),
            deciding: None,
            decision_error: None,
            models: Load::Idle,
            model: None,
            notice: None,
            notice_track: None,
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

    /// Leaves the open decision waiting and opens the next one, round to the first.
    pub fn later_decision(&mut self) {
        let keys: Vec<String> = self.inbox().iter().map(|d| d.key.clone()).collect();
        let Some(at) = self.open_decision().and_then(|d| keys.iter().position(|k| k == &d.key)) else { return };
        if let Some(next) = keys.get((at + 1) % keys.len()).cloned() {
            self.select_decision(&next);
        }
    }

    /// Y, N and S in the Inbox: yes, no, later. True when the key did something.
    pub fn inbox_key(&mut self, key: &str, tx: &mut Tx) -> bool {
        if self.declining || self.deciding.is_some() {
            return false;
        }
        let Some(quick) = self.open_decision().map(|d| d.quick_yes()) else { return false };
        match key {
            "y" | "Y" if quick => self.approve_decision(),
            "n" | "N" => self.start_decline(tx),
            "s" | "S" => self.later_decision(),
            _ => return false,
        }
        true
    }

    /// The decision open in the inbox.
    pub fn open_decision(&self) -> Option<&Decision> {
        let list = self.inbox();
        self.decision.as_ref().and_then(|k| list.iter().find(|d| &d.key == k).copied()).or_else(|| list.first().copied())
    }

    // ---- Actions --------------------------------------------------------

    fn inbox_read_scope(&self) -> String {
        serde_json::to_string(&(api_base(), &self.account_email)).expect("Inbox account scope")
    }

    pub fn decision_opened(&self, d: &Decision) -> bool {
        self.prefs.inbox_opened(&self.inbox_read_scope(), &d.business_id, &d.key)
    }

    /// Called only once the message has actually been laid out in the Inbox.
    pub fn mark_decision_opened(&mut self, key: &str) {
        let Some(d) = self.open_decision().filter(|d| d.key == key) else { return };
        let (business, key) = (d.business_id.clone(), d.key.clone());
        let scope = self.inbox_read_scope();
        if self.prefs.open_inbox_item(&scope, &business, &key) {
            self.prefs.save();
        }
    }

    pub fn select_decision(&mut self, key: &str) {
        if self.decision.as_deref() != Some(key) {
            self.decision = Some(key.to_string());
            self.inbox_message = false;
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

    pub fn open_business_picker(&mut self) {
        self.menu = None;
        self.confirm_archive = false;
        let focus = self
            .active
            .as_deref()
            .and_then(|id| self.businesses.iter().position(|b| b.id == id))
            .unwrap_or(0);
        self.business_picker = Some(BusinessPicker::new(PickerMode::Switch, focus));
    }

    /// The composer's folder chip: same picker, to choose what the next chat is about.
    pub fn open_chat_picker(&mut self) {
        self.menu = None;
        let focus = if self.general {
            self.businesses.len()
        } else {
            self.active.as_deref().and_then(|id| self.businesses.iter().position(|b| b.id == id)).unwrap_or(0)
        };
        self.business_picker = Some(BusinessPicker::new(PickerMode::Chat, focus));
    }

    /// Cards shown in the picker: businesses, plus general chat in Chat mode.
    pub fn picker_cards(&self) -> Vec<PickerCard> {
        let mut cards: Vec<PickerCard> = self.businesses.iter().map(|b| PickerCard { id: Some(b.id.clone()), name: b.name.clone(), sample: b.sample }).collect();
        if self.business_picker.as_ref().is_some_and(|p| p.mode == PickerMode::Chat) {
            cards.push(PickerCard { id: None, name: "General chat".into(), sample: false });
        }
        cards
    }

    /// Chooses a card: switches business, or starts the chat.
    pub fn pick_card(&mut self, index: usize) {
        let Some(p) = &self.business_picker else { return };
        let mode = p.mode;
        let Some(card) = self.picker_cards().into_iter().nth(index) else { return };
        match (mode, card.id) {
            (PickerMode::Switch, Some(id)) => self.select_business(&id),
            (PickerMode::Switch, None) => self.close_business_picker(),
            (PickerMode::Chat, id) => {
                self.close_business_picker();
                self.start_chat(id);
            }
        }
    }

    pub fn close_business_picker(&mut self) {
        self.business_picker = None;
        self.confirm_archive = false;
    }

    pub fn select_business(&mut self, id: &str) {
        self.menu = None;
        self.business_picker = None;
        if self.active.as_deref() == Some(id) {
            return;
        }
        if self.campaign_editor.as_ref().is_some_and(|e| e.busy || e.dirty()) {
            if let Some(e) = &mut self.campaign_editor { e.error = Some("Save or discard your campaign brief before switching businesses.".into()); }
            self.open_campaign_document();
            self.page = Page::Campaigns;
            self.view = View::Workspace;
            return;
        }
        self.campaign_editor = None;
        self.active = Some(id.to_string());
        self.overview = Load::Idle;
        self.issues = Load::Idle;
        self.channels = Load::Idle;
        self.close_channel();
        self.campaigns = Load::Idle;
        self.campaign_withdraw_confirm = None;
        self.campaign_contacts = None;
        self.campaign_run_id = None;
        self.campaign_runs = Load::Idle;
        self.campaign_timeline = None;
        self.answer = None;
        self.campaign_open = None;
        self.insights = Load::Idle;
        self.memory = Load::Idle;
        self.new_chat();
        // A business opens on the agent or its Overview, as the person chose.
        if self.prefs.landing == crate::prefs::Landing::Today {
            self.view = View::Workspace;
            self.page = Page::Overview;
        } else {
            self.home = true;
        }
        self.net.playbooks(Some(id.to_string()));
        self.proposals = Load::Loading;
        self.net.proposals(id.to_string());
        self.followups = Load::Loading;
        self.net.followups(id.to_string());
        self.brief_schedule.value = Load::Idle;
        self.brief_schedule.saving = false;
        self.brief_schedule.error = None;
        self.refresh_brief_schedule();
        self.load_business();
    }

    fn load_business(&mut self) {
        let Some(id) = self.active.clone() else { return };
        self.overview = Load::Loading;
        self.net.overview(id);
        self.load_page();
    }

    pub fn show_view(&mut self, view: View) {
        if view == View::Agent { self.close_channel(); }
        self.view = view;
        if view == View::Workspace {
            self.load_page();
        }
    }

    pub fn show_section(&mut self, section: Section) {
        self.section = section;
        self.chart_hover = None;
        if (self.page != Page::Overview || self.view != View::Workspace) && !(self.view == View::Agent && matches!(self.side_tab(), crate::side::SideTab::Analytics | crate::side::SideTab::Page(Page::Overview))) {
            self.show_page(Page::Overview);
        }
    }

    pub fn clear_chart_lines(&self) {
        self.chart_lines.borrow_mut().clear();
    }

    pub(crate) fn schedule_chart_hover(&mut self, key: String, day: usize, tx: &mut rune::Tx) {
        const WAIT: std::time::Duration = std::time::Duration::from_millis(48);
        self.chart_hover_pending = Some((key, day));
        self.chart_hover_at = Some(std::time::Instant::now() + WAIT);
        tx.wake_after(WAIT);
    }

    pub(crate) fn flush_chart_hover(&mut self) -> bool {
        let Some(at) = self.chart_hover_at else {
            return false;
        };
        if std::time::Instant::now() < at {
            return false;
        }
        self.chart_hover_at = None;
        let Some((key, day)) = self.chart_hover_pending.take() else {
            return false;
        };
        let next = Some((key, day));
        if self.chart_hover == next {
            return false;
        }
        self.chart_hover = next;
        true
    }

    pub(crate) fn clear_chart_hover_now(&mut self, key: &str, day: usize) -> bool {
        self.chart_hover_pending = None;
        self.chart_hover_at = None;
        if self.chart_hover.as_ref() == Some(&(key.to_string(), day)) {
            self.chart_hover = None;
            return true;
        }
        false
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
        self.clear_chart_lines();
        if let Some(id) = self.active.clone() {
            self.insights = Load::Loading;
            self.net.insights(id, days);
        }
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
        if page != Page::Channels { self.close_channel(); }
        self.view = View::Workspace;
        self.page = page;
        self.answer = None;
        self.campaign_open = None;
        self.list_query.clear();
        // A full-page Analytics view already paints every chart; folding the side
        // panel avoids laying the same Overview out twice and gives the page width.
        if page == Page::Overview || self.side_panel_duplicates_page() {
            self.side.open = false;
        }
        self.load_page();
    }

    /// Fetches what the page on screen shows, every time it opens, as the
    /// web pages do on mount.
    fn load_page(&mut self) {
        if self.view != View::Workspace && !matches!(self.side_tab(), crate::side::SideTab::Page(_)) {
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
                // The numbers on the card and the approved work under it.
                if !matches!(self.insights, Load::Ready(_) | Load::Loading) {
                    self.insights = Load::Loading;
                    self.net.insights(id, self.days);
                }
            }
            Page::Overview => {
                self.overview = keep_or_load(&self.overview);
                self.net.overview(id.clone());
                self.insights = keep_or_load(&self.insights);
                self.net.insights(id, self.days);
            }
            Page::Campaigns => {
                self.campaigns = keep_or_load(&self.campaigns);
                self.net.campaigns(id.clone());
                if let Some(campaign) = self.campaign_open.clone() {
                    self.campaign_run_id = Some(campaign.clone());
                    self.campaign_runs = Load::Loading;
                    self.net.campaign_runs(id, campaign);
                }
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
        // The list is already on screen behind the popup; refetching here replaces it
        // when the request fails even though the data was fine.
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
        self.refresh_brief_schedule();
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
        if self.add_helper_tab(id, Load::Loading) {
            self.net.helper(scope, id.to_string());
        }
    }

    /// Makes the helper the main chat, where replies can be written.
    pub fn helper_as_main(&mut self) {
        if let Some(id) = self.front_helper().map(|(id, _)| id.clone()) {
            self.close_tab(&crate::side::SideTab::Helper(id.clone()));
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
                self.adopt_side();
            }
        }
    }

    /// Opens a saved campaign and reloads its scoped delivery evidence.
    pub fn open_campaign(&mut self, id: &str) {
        self.campaign_open = Some(id.into());
        self.campaign_run_id = Some(id.into());
        self.campaign_runs = Load::Loading;
        if let Some(b) = self.active.clone() { self.net.campaign_runs(b, id.into()); }
    }

    /// Starts a fresh main chat with a request ready to send. The originating
    /// business page stays open as a tab beside it; no request is sent here.
    /// Asks for a re-check of the open AI answer, tied to its latest recorded fix.
    pub fn recheck_answer(&mut self) {
        let Some(business) = self.active.clone() else { return };
        let Some(a) = self.answer.as_mut() else { return };
        if a.rechecking {
            return;
        }
        let latest = a.detail.ready().and_then(|d| d.actions.iter().max_by(|x, y| x.performed_at.cmp(&y.performed_at)).map(|x| x.id.clone()));
        a.rechecking = true;
        a.error = None;
        self.net.recheck(business, a.claim.clone(), latest);
    }

    pub fn ask_agent(&mut self, request: &str) {
        let origin = if self.view == View::Workspace {
            Some(self.page)
        } else if self.side_shown() {
            match self.side_tab() {
                crate::side::SideTab::Page(page) => Some(page),
                crate::side::SideTab::Analytics => Some(Page::Overview),
                _ => None,
            }
        } else { None }.filter(|page| self.active.is_some() && !page.account());
        self.sync_draft();
        self.new_chat();
        self.sync_draft();
        self.composer.replace_text(request);
        if let Some(page) = origin {
            self.open_page_tab(page);
        }
    }

    pub fn chat_shown(&self) -> bool {
        self.view == View::Agent && (self.active.is_some() || self.general)
    }

    /// Whether the main chat draws its transcript in the Words WKWebView (macOS only).
    /// Off unless the pref is on and `OPENRECORD_WORDS_TRANSCRIPT=1` is set; native Rune markdown is the default.
    pub fn words_transcript_webview(&self) -> bool {
        if !cfg!(target_os = "macos") || !self.prefs.words_webview {
            return false;
        }
        matches!(std::env::var("OPENRECORD_WORDS_TRANSCRIPT"), Ok(v) if v == "1")
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
    /// Folds or unfolds the sidebar. Everything that moves does so on one spring,
    /// and the split's new width is known at once: waiting for layout to report it
    /// laid the right panel out twice, so the page was pushed one way and back.
    pub fn toggle_sidebar(&mut self, tx: &mut Tx) {
        let from = [self.words_rect, self.preview_rect, self.side.browser.rect];
        let from = [0, 1, 2].map(|i| from[i].map(|r| self.gliding(i, r)));
        self.sidebar_open = !self.sidebar_open;
        self.sidebar_peek = false;
        if self.split_w > 0.0 {
            let w = self.prefs.sidebar();
            self.split_w = (self.split_w + if self.sidebar_open { -w } else { w }).max(0.0);
        }
        if !self.prefs.reduce_motion {
            self.sidebar_slide = Some(SidebarSlide { started: std::time::Instant::now(), from });
            tx.wake_after(std::time::Duration::ZERO);
        }
        tx.motion(SIDEBAR_SPRING);
    }

    /// Where a native pane (0 the chat's text, 1 the artifact preview, 2 the
    /// browser) is drawn now, on its way to `to` while the sidebar slides. Rune
    /// reports where layout ends, so a pane placed there would run ahead of the
    /// panel around it.
    pub fn gliding(&self, pane: usize, to: [f32; 4]) -> [f32; 4] {
        match &self.sidebar_slide {
            Some(SidebarSlide { started, from }) => match from[pane] {
                Some(from) => {
                    let p = spring_progress(started.elapsed().as_secs_f32());
                    std::array::from_fn(|i| from[i] + (to[i] - from[i]) * p)
                }
                None => to,
            },
            None => to,
        }
    }

    /// Widens the side panel over the chat, or brings it back. The page inside
    /// glides on the panel's own spring, as it does when the sidebar folds:
    /// placed at the end at once, it ran ahead of the tab strip and left the
    /// window showing through until the strip caught up.
    pub fn toggle_wide(&mut self, tx: &mut Tx) {
        let from = [self.words_rect, self.preview_rect, self.side.browser.rect];
        let from = [0, 1, 2].map(|i| from[i].map(|r| self.gliding(i, r)));
        self.side.wide = !self.side.wide;
        if !self.prefs.reduce_motion {
            self.sidebar_slide = Some(SidebarSlide { started: std::time::Instant::now(), from });
            tx.wake_after(std::time::Duration::ZERO);
        }
        tx.motion(SIDEBAR_SPRING);
    }

    fn enter_agent(&mut self) {
        self.view = View::Agent;
    }

    /// Opens one of a business's conversations, such as the one a decision came from.
    pub fn open_business_chat(&mut self, business: &str, id: &str) {
        if !business.is_empty() && self.active.as_deref() != Some(business) {
            self.select_business(business);
        }
        self.general = business.is_empty();
        self.open_session(id);
    }

    /// Home: the agent with a fresh chat for the business on screen, and what waits on the person.
    pub fn go_home(&mut self) {
        self.menu = None;
        self.new_chat();
        self.home = true;
        self.net.decisions();
    }

    pub fn new_chat(&mut self) {
        self.home = false;
        self.enter_agent();
        self.general = false;
        self.chat_id = None;
        self.clear_artifact_diff_stats();
        // Each chat keeps its own panel; a new chat's opens closed.
        self.switch_side();
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
        self.clear_artifact_diff_stats();
        // What was open beside the last chat stays with it; this chat's comes back.
        self.switch_side();
        self.turn = Turn::Idle;
        self.conversation = Load::Loading;
        self.settle_next = true;
        if let Some(scope) = self.chat_scope() {
            self.syncing = true;
            self.net.sync(scope, chat.id.clone());
        }
    }

    /// The model the next turn uses: the one picked if it's still offered.
    /// When it is not (its tool hit a usage limit or went offline), the same
    /// model through another connection, otherwise the first offered, and
    /// `model_stand_in` says so. The pick is kept, so it comes back by itself.
    pub fn chosen_model(&self) -> Option<&crate::chat::ModelOption> {
        let list = self.catalog.ready()?;
        let Some(v) = self.agent_model.as_ref() else { return list.first() };
        let model_id = |value: &str| value.split_once(':').map(|(_, m)| m.to_string());
        list.iter()
            .find(|o| &o.value == v)
            .or_else(|| model_id(v).and_then(|m| list.iter().find(|o| model_id(&o.value).as_deref() == Some(m.as_str()))))
            .or_else(|| list.first())
    }

    /// The picked model is gone and another runs in its place: the one running, to say so.
    pub fn model_stand_in(&self) -> Option<&crate::chat::ModelOption> {
        let list = self.catalog.ready()?;
        let v = self.agent_model.as_ref()?;
        if v == "hosted" || list.iter().any(|o| &o.value == v) {
            return None;
        }
        self.chosen_model()
    }

    /// No model can run a turn at all: the picked one is gone and nothing else is offered.
    pub fn model_unavailable(&self) -> bool {
        match (self.catalog.ready(), &self.agent_model) {
            (Some(list), Some(v)) if v != "hosted" => list.is_empty(),
            _ => false,
        }
    }

    /// Whether a turn can be queued: catalog resolved, a model chosen, and harness picks include `selection`.
    pub fn can_send_turn(&self) -> bool {
        if self.model_unavailable() {
            return false;
        }
        let Some(m) = self.chosen_model() else {
            return false;
        };
        m.value == "hosted" || self.turn_selection().is_some()
    }

    pub(crate) fn send_blocked_notice(&mut self) {
        self.notice = Some(if matches!(self.catalog, Load::Loading) {
            "Agent models are still loading. Try again in a moment.".into()
        } else if self.model_unavailable() {
            "No agent model is available. Connect one in Settings → Agent, or pick a model under the chat box.".into()
        } else {
            "Pick an agent model under the chat box before sending.".into()
        });
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
        // Before the model list arrives, the saved pick still names the model: a turn
        // sent in that moment must not fall back to the hosted model, which may not exist.
        if self.catalog.ready().is_none() {
            let (instance, model) = self.agent_model.as_deref()?.split_once(':')?;
            return Some(serde_json::json!({ "instanceId": instance, "model": model }));
        }
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
                    self.net.memory(b.clone());
                    self.research_spend = keep_or_load(&self.research_spend);
                    self.research_limit_error = None;
                    self.net.research_spend(b);
                }
            }
            _ => {}
        }
    }

    /// Changes a preference and saves it.
    /// Picks a picture for Home's backdrop; it is dithered when Home next draws.
    pub fn choose_home_background(&mut self, tx: &mut Tx) {
        let options = rune::FileDialogOptions { title: "Choose a picture for Home".into(), ..Default::default() }.filter("Pictures", &["png", "jpg", "jpeg"]);
        tx.open_file(options, |s: &mut App, answer, _tx| match answer {
            Ok(Some(path)) => match crate::backdrop::store(&path) {
                Ok(()) => {
                    s.settings_error = None;
                    s.set_pref(|p| p.home_background = crate::backdrop::HomeBackground::Custom);
                }
                Err(e) => s.settings_error = Some(e),
            },
            Ok(None) => {}
            Err(e) => s.settings_error = Some(e.0),
        });
    }

    pub fn set_pref(&mut self, f: impl FnOnce(&mut crate::prefs::Prefs)) {
        f(&mut self.prefs);
        self.prefs.save();
    }

    /// Saves the monthly research limit typed in settings; an empty box removes it.
    pub fn save_research_limit(&mut self) {
        let Some(b) = self.active.clone() else { return };
        if self.research_limit_busy {
            return;
        }
        match crate::settings::parse_limit(&self.research_limit.text) {
            Ok(limit) => {
                self.research_limit_busy = true;
                self.research_limit_error = None;
                self.net.set_research_budget(b, limit);
            }
            Err(e) => self.research_limit_error = Some(e.into()),
        }
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
        self.confirming_revoke = None;
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
            self.prefs.chat_order.retain(|x| x != id);
        } else if let Load::Ready(list) = &mut self.archived {
            list.retain(|c| c.id != id);
        }
        self.net.archive(id.to_string(), archived);
        self.prefs.save();
    }

    /// Sidebar order: saved `chat_order`, then any new chats by recency.
    pub fn ordered_chats<'a>(&self, source: impl IntoIterator<Item = &'a crate::api::ChatSummary>) -> Vec<&'a crate::api::ChatSummary> {
        let source: Vec<_> = source.into_iter().collect();
        let mut out = Vec::with_capacity(source.len());
        for id in &self.prefs.chat_order {
            if let Some(c) = source.iter().find(|c| c.id == *id) {
                out.push(*c);
            }
        }
        let mut rest: Vec<_> = source.into_iter().filter(|c| !self.prefs.chat_order.contains(&c.id)).collect();
        rest.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out.extend(rest);
        out
    }

    fn chat_business_key(c: &crate::api::ChatSummary) -> String {
        c.business_id.clone().unwrap_or_else(|| "_general".into())
    }

    /// Moves a chat within its business folder after a drag (positive `dy` moves up).
    pub fn reorder_chat(&mut self, id: &str, dy: f32) {
        const THRESHOLD: f32 = 14.0;
        if dy.abs() < THRESHOLD {
            return;
        }
        let Some(chat) = self.chats.iter().find(|c| c.id == id) else { return };
        let biz = Self::chat_business_key(chat);
        let group: Vec<_> = self.chats.iter().filter(|c| Self::chat_business_key(c) == biz).collect();
        let mut order: Vec<String> = self.ordered_chats(group.iter().copied()).into_iter().map(|c| c.id.clone()).collect();
        let Some(pos) = order.iter().position(|x| x == id) else { return };
        let to = if dy > 0.0 {
            pos.saturating_sub(1)
        } else {
            (pos + 1).min(order.len().saturating_sub(1))
        };
        if to == pos {
            return;
        }
        let moved = order.remove(pos);
        order.insert(to, moved);
        let anchor = self
            .prefs
            .chat_order
            .iter()
            .position(|id| order.iter().any(|x| x == id))
            .unwrap_or(self.prefs.chat_order.len());
        let mut next: Vec<String> = self.prefs.chat_order.iter().filter(|id| !order.iter().any(|x| *id == x)).cloned().collect();
        for (i, id) in order.iter().enumerate() {
            next.insert(anchor + i, id.clone());
        }
        self.prefs.chat_order = next;
        self.prefs.save();
    }

    pub fn toggle_chat_group(&mut self, key: &str) {
        if let Some(i) = self.prefs.chat_groups_collapsed.iter().position(|k| k == key) {
            self.prefs.chat_groups_collapsed.remove(i);
        } else {
            self.prefs.chat_groups_collapsed.push(key.to_string());
            self.prefs.chat_groups_list_expanded.retain(|k| k != key);
        }
        self.prefs.save();
    }

    pub fn toggle_chat_group_list(&mut self, key: &str) {
        if let Some(i) = self.prefs.chat_groups_list_expanded.iter().position(|k| k == key) {
            self.prefs.chat_groups_list_expanded.remove(i);
        } else {
            self.prefs.chat_groups_list_expanded.push(key.to_string());
        }
        self.prefs.save();
    }

    /// Opens another session of this business, such as a helper, in the chat.
    pub fn open_session(&mut self, id: &str) {
        self.enter_agent();
        self.chat_id = Some(id.to_string());
        self.switch_side();
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
    /// Sends from either chat box.
    pub fn send_from(&mut self, slot: ComposerSlot, tx: &mut Tx) {
        match slot {
            ComposerSlot::Main => self.send_message(tx),
            ComposerSlot::Side => self.send_side(tx),
        }
    }

    pub fn send_message(&mut self, tx: &mut Tx) {
        let text = self.composer.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if !self.can_send_turn() {
            self.send_blocked_notice();
            return;
        }
        if self.chat_scope().is_none() {
            self.notice = Some("Choose a business to chat about first.".into());
            return;
        }
        self.composer.clear();
        self.command_index = 0;
        if matches!(self.turn, Turn::Working { .. }) {
            self.steer_or_queue(text);
            return;
        }
        self.dispatch(text, tx);
    }

    /// While a turn runs: a message goes to the run itself, which reads it at
    /// its next step. A slash command, or a turn not yet accepted or being
    /// stopped, queues it for after instead.
    pub fn steer_or_queue(&mut self, text: String) {
        let request = match &self.turn {
            Turn::Working { request: Some(r), stopping: false, .. } if !text.starts_with('/') => r.clone(),
            _ => {
                self.queued.push(text);
                return;
            }
        };
        let local = self.steer_next;
        self.steer_next += 1;
        self.steer.push(crate::chat::Steer { local, id: None, text: text.clone(), read: false });
        self.net.note(request, local, text);
    }

    #[cfg(test)]
    pub fn settle_steer_for_test(&mut self) {
        self.settle_steer();
    }

    /// How long a pause in typing is before the feedforward row shows.
    pub const PAUSE: std::time::Duration = std::time::Duration::from_millis(700);

    /// What the agent will take as given for the message being typed, once the
    /// person has paused; empty while they type, for a command, or mid-turn.
    pub fn feedforward(&self) -> Vec<crate::chat::Forward> {
        let text = self.composer.text.trim();
        if text.is_empty() || text.starts_with('/') || !matches!(self.turn, Turn::Idle) || self.composer_seen.0 != self.composer.text || self.composer_seen.1.elapsed() < Self::PAUSE {
            return Vec::new();
        }
        let business = if self.general { None } else { self.active_business().map(|b| b.name.as_str()) };
        crate::chat::feedforward(text, business, self.attachments.len(), self.prefs.response_style)
    }

    /// The next reply style, for the feedforward chip.
    pub fn cycle_style(&mut self) {
        use crate::prefs::Style;
        self.prefs.response_style = match self.prefs.response_style {
            Style::Friendly => Style::Concise,
            Style::Concise => Style::Detailed,
            Style::Detailed => Style::Friendly,
        };
        self.prefs.save();
    }

    /// The answer the person gave to a question the agent left: one they just
    /// picked, or one in a later message or note.
    pub fn blank_answer(&self, b: &crate::chat::Blank) -> Option<String> {
        if let Some(a) = self.blank_answers.get(&b.id) {
            return Some(a.clone());
        }
        let mut texts: Vec<&str> = self.steer.iter().map(|n| n.text.as_str()).collect();
        texts.extend(self.queued.iter().map(String::as_str));
        if let Some(c) = self.conversation.ready() {
            for m in c.messages.iter().filter(|m| m.role == "user") {
                texts.push(m.text.as_str());
                texts.extend(m.notes.iter().map(String::as_str));
            }
        }
        b.answered_in(texts)
    }

    /// Answers a question the agent left. While it works the answer reaches the
    /// run at its next step; afterwards it goes as a message, for the agent to
    /// redo what depended on the assumption.
    pub fn answer_blank(&mut self, b: &crate::chat::Blank, answer: &str, tx: &mut Tx) {
        let answer = answer.trim();
        if answer.is_empty() || self.model_unavailable() {
            return;
        }
        self.blank_answers.insert(b.id.clone(), answer.to_string());
        let text = b.answer_text(answer);
        if matches!(self.turn, Turn::Working { .. }) {
            self.steer_or_queue(text);
        } else if answer != b.assumed {
            self.dispatch(format!("{text}. You had assumed «{}»: update what depended on it.", b.assumed), tx);
        }
    }

    /// Puts "For «question»: " in the chat box, for an answer of the person's own.
    pub fn answer_blank_freely(&mut self, b: &crate::chat::Blank, tx: &mut Tx) {
        self.composer.replace_text(format!("For «{}»: ", b.question));
        tx.focus("composer-input", false);
    }

    /// The turn ended: notes it never read go out next, as ordinary messages.
    fn settle_steer(&mut self) {
        let unread: Vec<String> = self.steer.drain(..).filter(|n| !n.read).map(|n| n.text).collect();
        for (i, text) in unread.into_iter().enumerate() {
            self.queued.insert(i, text);
        }
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
            rune::Key::Down => {
                self.command_index = (at + 1) % n;
                tx.scroll_into_view(format!("command-{}", entries[self.command_index].id()));
            }
            rune::Key::Up => {
                self.command_index = (at + n - 1) % n;
                tx.scroll_into_view(format!("command-{}", entries[self.command_index].id()));
            }
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

    /// Prepare a supported command without sending or losing the current draft.
    pub fn prepare_composer_command(&mut self, command: &str) {
        if !crate::chat::COMMANDS.iter().any(|(name, _)| *name == command) { return; }
        self.chat_actions = false;
        let draft = match self.composer_slot { ComposerSlot::Main => &mut self.composer, ComposerSlot::Side => &mut self.side.composer };
        let request = format!("/{command} {}", draft.text.trim());
        draft.replace_text(&request);
    }

    pub fn open_save_playbook(&mut self, tx: &mut Tx) {
        self.chat_actions = false;
        // A playbook is for every business: this business's name becomes {business}.
        let mut prompt = match self.composer_slot { ComposerSlot::Main => &self.composer, ComposerSlot::Side => &self.side.composer }.text.trim().to_string();
        if let Some(b) = self.active_business().filter(|_| !self.general).map(|b| b.name.clone()).filter(|b| !b.is_empty()) {
            prompt = prompt.replace(&b, "{business}");
        }
        self.save_playbook = Some(SavePlaybook { title: TextEdit::new(""), name: TextEdit::new(""), prompt: TextEdit::new(&prompt), busy: false, error: None });
        tx.focus("playbook-title", false);
    }

    pub fn submit_playbook(&mut self) {
        let business = if self.general { None } else { self.active.clone() };
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

    /// Reads a private artifact into the split beside this business's chat.
    pub fn open_artifact(&mut self, artifact: &str) {
        self.notices_open = false;
        self.preview_rect = None;
        let Some(business) = self.active.clone() else { return };
        let pane = crate::artifacts::Pane { business: business.clone(), id: artifact.into(), requested: None, loaded: Load::Loading, source: false };
        if self.add_artifact_tab(pane) {
            self.net.artifact(business, artifact.into(), None);
        }
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

    /// Makes the composer's current text the open chat's draft, so the next
    /// sync keeps it rather than restoring an older one.
    pub fn adopt_draft(&mut self) {
        self.draft_key = format!("{}:{}", self.chat_scope().unwrap_or_else(|| "general".into()), self.chat_id.clone().unwrap_or_else(|| "new".into()));
        let (k, text) = (self.draft_key.clone(), self.composer.text.clone());
        self.drafts.set(&k, &text);
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
    /// Asks to undo the chat from the person's message `i`.
    pub fn ask_undo(&mut self, i: usize) {
        if matches!(self.turn, Turn::Working { .. }) {
            return;
        }
        let Some(c) = self.conversation.ready() else { return };
        if self.chat_id.as_deref() != Some(c.id.as_str()) {
            return;
        }
        let Some(m) = c.messages.get(i) else { return };
        if m.role != "user" || m.origin.is_some() {
            return;
        }
        self.undo = Some(UndoTurn { index: i, conversation: c.id.clone(), revision: c.revision, text: m.text.clone(), request: crate::api::uuid(), busy: false, error: None });
    }

    pub fn confirm_undo(&mut self) {
        let Some(scope) = self.chat_scope() else { return };
        let Some(u) = &mut self.undo else { return };
        if u.busy || matches!(self.turn, Turn::Working { .. }) {
            return;
        }
        u.busy = true;
        u.error = None;
        self.net.rollback(scope, u.conversation.clone(), u.index, u.revision, u.request.clone(), u.text.clone());
    }

    /// Carries the chat up to message `i` into a new chat and opens it there;
    /// the original stays as it was in the history.
    pub fn branch_reply(&mut self, i: usize) {
        if matches!(self.turn, Turn::Working { .. }) {
            return;
        }
        let (Some(scope), Some(id)) = (self.chat_scope(), self.chat_id.clone()) else { return };
        if self.conversation.ready().is_none_or(|c| c.id != id || i >= c.messages.len()) {
            return;
        }
        self.net.branch(scope, id, i);
    }

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

    pub(crate) fn dispatch(&mut self, text: String, tx: &mut Tx) {
        let Some(business) = self.chat_scope() else { return };
        let conversation = match (&self.chat_id, self.conversation.ready()) {
            (Some(id), Some(c)) if &c.id == id => Some((id.clone(), c.revision)),
            _ => None,
        };
        // The live steps' open lines belong to the turn before.
        self.open_logs.retain(|(i, _)| *i != usize::MAX);
        self.home = false;
        self.turn = Turn::Working { message: text.clone(), request: None, progress: Default::default(), started: std::time::Instant::now(), stopping: false };
        let out = crate::chat::Outgoing { message: text, selection: self.turn_selection(), attachments: std::mem::take(&mut self.attachments), style: Some(self.prefs.response_style.key().to_string()), viewing: self.viewing_artifacts() };
        self.attach_error = None;
        self.net.send(business, conversation, out);
        // The sent message and the bottom of the chat land at once, with no glide up.
        tx.instant();
        tx.scroll_to_bottom("transcript");
    }

    // ---- Replies --------------------------------------------------------

    /// Applies the replies that have landed; true when anything changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        if self.channel_setup.as_ref().is_some_and(|p| p.authorizing) {
            match crate::native_preview::authorization_result() {
                0 => tx.wake_after(std::time::Duration::from_millis(500)),
                result => {
                    if let Some(p) = &mut self.channel_setup {
                        p.authorizing = false; p.busy = false;
                        if result < 0 { p.error = Some("Sign-in did not finish in this window. Check the connection status before trying again.".into()); }
                    }
                    self.reload_channel();
                    self.refresh();
                    return true;
                }
            }
        }
        self.sync_draft();
        let replies = self.net.take();
        let mut changed = self.flush_chart_hover() || !replies.is_empty();
        for r in replies {
            self.apply(r, tx);
        }
        // The Realtime "Live" dot on the full Analytics page (not in the side panel).
        if self.view == View::Workspace && self.realtime_overview_visible() && !self.prefs.reduce_motion {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            const PULSE_MS: u64 = 500;
            let bucket = ms / PULSE_MS;
            let wait = PULSE_MS - ms % PULSE_MS;
            tx.wake_after(std::time::Duration::from_millis(wait.max(1)));
            if bucket != self.realtime_pulse_bucket {
                self.realtime_pulse_bucket = bucket;
                changed = true;
            }
        } else {
            self.realtime_pulse_bucket = u64::MAX;
        }
        // While a turn runs, the thinking glyph steps every 220 milliseconds and the clock ticks.
        if matches!(self.turn, Turn::Working { .. }) && !self.prefs.reduce_motion {
            tx.wake_after(std::time::Duration::from_millis(220));
            changed = true;
        }
        self.sync_open_chat(tx);
        if let Some(text) = self.notice.clone() {
            let reset = self.notice_track.as_ref().is_none_or(|(prev, _)| prev != &text);
            if reset {
                self.notice_track = Some((text, std::time::Instant::now()));
            }
            if let Some((_, since)) = self.notice_track {
                let elapsed = since.elapsed();
                if elapsed >= NOTICE_SHOW {
                    self.notice = None;
                    self.notice_track = None;
                    changed = true;
                } else {
                    tx.wake_after(NOTICE_SHOW.saturating_sub(elapsed));
                    if reset {
                        changed = true;
                    }
                }
            }
        } else {
            self.notice_track = None;
        }
        // Native panes are placed by hand each frame while the sidebar slides.
        if let Some(slide) = &self.sidebar_slide {
            if slide.started.elapsed().as_secs_f32() > SIDEBAR_SPRING.duration * 2.0 {
                self.sidebar_slide = None;
                changed = true;
            } else if slide.from.iter().any(Option::is_some) {
                tx.wake_after(std::time::Duration::ZERO);
                changed = true;
            } else {
                tx.wake_after(std::time::Duration::from_millis(100));
            }
        }
        // Pierre Words fade on a fresh reply (`@pierre/words` on web, native Markdown on desktop).
        if let Some((text, started)) = &self.reveal {
            if crate::chat::words_reveal_active(started.elapsed(), text) {
                tx.wake_after(std::time::Duration::from_millis(crate::chat::WORDS_FADE_MS));
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

    /// A reply still in its Pierre Words fade-in, or `None` once the fade finished.
    pub fn words_revealing(&self, text: &str) -> bool {
        let (t, started) = match self.reveal.as_ref() {
            Some(v) => v,
            None => return false,
        };
        t == text && crate::chat::words_reveal_active(started.elapsed(), text)
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
        self.close_channel();
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
                            self.general = false;
                            self.select_business(&first);
                        } else {
                            self.active = None;
                            self.general = true;
                        }
                        // Always open Home (agent starters), not a setup interstitial.
                        self.go_home();
                    }
                }
            }
            Reply::Notice(n) => self.notice = Some(n),
            Reply::ArchivedBusinesses(r) => {
                if let Ok(list) = self.failed(r) {
                    self.archived_businesses = list;
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
            Reply::Issues(b, r) if here(self, &b) => match self.failed(r) {
                Ok(v) => self.issues = Load::Ready(v),
                Err(e) if e.is_empty() => {}
                Err(e) if self.answer.is_none() && self.page == Page::AiAnswers && self.issues.ready().is_some() => {
                    self.notice = Some(format!("Issues could not refresh. {e}"));
                }
                Err(e) => self.issues = Load::Failed(e),
            },
            Reply::Facts(b, r) if here(self, &b) => self.find_facts = to_load(self.failed(r)),
            Reply::Facts(..) => {}
            Reply::Channels(b, r) if here(self, &b) => self.channels = to_load(self.failed(r)),
            Reply::Campaigns(b, r) if here(self, &b) => self.campaigns = to_load(self.failed(r)),
            Reply::CampaignTimeline(b, id, t) if here(self, &b) => self.campaign_timeline = Some((id, t)),
            Reply::CampaignTimeline(..) => {}
            Reply::CampaignRuns(b, id, r) if here(self, &b) && self.campaign_run_id.as_deref() == Some(id.as_str()) => self.campaign_runs = to_load(self.failed(r)),
            Reply::CampaignPublication(b, id, result) if here(self, &b) => {
                match self.failed(result) {
                    Ok(crate::net::PublicationResult::Test(url)) => self.browser_open_page(&url),
                    Ok(crate::net::PublicationResult::Inquiries(text)) => self.campaign_contacts = Some((id, text)),
                    Ok(crate::net::PublicationResult::Withdrawn) => { self.notice = Some("The campaign page is withdrawn.".into()); self.refresh(); }
                    Ok(crate::net::PublicationResult::Reported) => { self.notice = Some("Marked as sent. Its views and inquiries show by source in the campaign results.".into()); self.refresh(); }
                    Err(e) if !e.is_empty() => self.notice = Some(e),
                    Err(_) => {}
                }
            }
            Reply::CampaignSaved { business, id, result } => {
                if matches!(result, Err(ApiError::Unauthorized)) {
                    self.signed_out(Some(ApiError::Unauthorized.message()));
                } else if here(self, &business) && self.campaign_editor.as_ref().is_some_and(|e| e.id == id && e.business == business) {
                    match result {
                        Ok(saved) => {
                            if let Load::Ready(list) = &mut self.campaigns {
                                if let Some(c) = list.iter_mut().find(|c| c.id == id) { *c = saved; }
                                else { list.insert(0, saved); }
                            }
                            self.open_campaign(&id);
                            self.campaign_editor = None;
                            self.close_tab(&crate::side::SideTab::CampaignBrief);
                            self.net.campaigns(business);
                        }
                        Err(e) => if let Some(editor) = &mut self.campaign_editor {
                            editor.busy = false;
                            editor.error = Some(crate::campaign_edit::save_error(&e));
                        },
                    }
                }
            }
            Reply::BriefSuggested { business, id, result } => {
                if matches!(result, Err(ApiError::Unauthorized)) {
                    self.signed_out(Some(ApiError::Unauthorized.message()));
                } else if let Some(e) = self.campaign_editor.as_mut().filter(|e| e.id == id && e.business == business) {
                    e.suggesting = false;
                    e.suggest_note = Some(match result {
                        Ok(brief) => match e.take_suggestion(&brief) {
                            (0, 0) => "Nothing new to fill in. The lines you already wrote were kept.".into(),
                            (l, 0) => format!("Filled {l} {}. Check them, then save.", if l == 1 { "line" } else { "lines" }),
                            (0, d) => format!("Added {d} {}. Check them, then save.", if d == 1 { "deliverable" } else { "deliverables" }),
                            (l, d) => format!("Filled {l} lines and added {d} {}. Check them, then save.", if d == 1 { "deliverable" } else { "deliverables" }),
                        },
                        Err(ApiError::Status(503, _)) => "The agent couldn't be reached. Pick a model in the chat, or fill in the lines yourself.".into(),
                        Err(ApiError::Status(404, _)) => "This server can't fill in briefs yet. Fill in the lines yourself.".into(),
                        Err(_) => "The agent's answer couldn't be read. Try again, or fill in the lines yourself.".into(),
                    });
                }
            }
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
            Reply::ChannelStatus(b, r) if here(self, &b) => self.channel_status = to_load(self.failed(r)),
            Reply::ChannelStatus(..) => {}
            Reply::Portfolio(r) => self.portfolio = to_load(self.failed(r)),
            Reply::ClientRows(r) => self.client_rows = to_load(self.failed(r)),
            Reply::Conversation(b, r) if self.chat_scope().as_deref() == Some(b.as_str()) => {
                if let Ok(Some(c)) = &r {
                    self.refresh_open_artifacts(c);
                }
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
                        self.queue_artifact_diff_stats();
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
            Reply::RolledBack(b, text, r) if self.chat_scope().as_deref() == Some(b.as_str()) => {
                let busy = matches!(&r, Err(ApiError::Status(409, body)) if body.contains("\"BUSY\""));
                let stale = matches!(&r, Err(ApiError::Status(409, body)) if body.contains("\"STALE\""));
                match self.failed(r) {
                    Ok((c, rollback)) => {
                        self.undo = None;
                        // Pieces it archived close; ones it put back read again.
                        for a in &rollback.archived_artifacts {
                            self.close_tab(&crate::side::SideTab::Artifact(a.id.clone()));
                        }
                        for a in &rollback.restored_artifacts {
                            if self.artifacts.iter().any(|p| p.id == a.id) {
                                self.net.artifact(b.clone(), a.id.clone(), None);
                            }
                        }
                        if self.chat_id.as_deref() == Some(c.id.as_str()) {
                            self.turn = Turn::Idle;
                            self.conversation = Load::Ready(c);
                            // The undone message comes back to the box, to change and send again.
                            if self.composer.text.trim().is_empty() {
                                self.composer.replace_text(&text);
                            }
                            tx.settle();
                            tx.scroll_to_bottom("transcript");
                            tx.focus("composer-input", false);
                        }
                        self.notice = Some(rollback.summary());
                    }
                    Err(e) => {
                        let message = if busy {
                            "The agent is still working in this chat. Undo once it finishes.".to_string()
                        } else if stale {
                            "This chat changed since you opened it. Look at it again, then undo.".to_string()
                        } else if e.is_empty() {
                            "Couldn't undo the chat. Try again.".to_string()
                        } else {
                            e
                        };
                        if stale {
                            self.undo = None;
                            self.notice = Some(message);
                            if let Some(id) = self.chat_id.clone() {
                                self.net.conversation(b.clone(), id);
                            }
                        } else if let Some(u) = &mut self.undo {
                            u.busy = false;
                            u.error = Some(message);
                        }
                    }
                }
            }
            Reply::Branched(b, r) if self.chat_scope().as_deref() == Some(b.as_str()) => match self.failed(r) {
                Ok(c) => {
                    self.chat_id = Some(c.id.clone());
                    self.switch_side();
                    self.turn = Turn::Idle;
                    self.conversation = Load::Ready(c);
                    self.queue_artifact_diff_stats();
                    tx.settle();
                    tx.scroll_to_bottom("transcript");
                    tx.focus("composer-input", false);
                }
                Err(e) => self.notice = Some(if e.is_empty() { "Couldn't branch the chat. Try again.".into() } else { e }),
            },
            Reply::TurnQueued { business, conversation, request: id } if self.chat_scope().as_deref() == Some(business.as_str()) => {
                if self.chat_id.is_none() {
                    // The new chat's panel goes with it.
                    self.chat_id = Some(conversation);
                    self.adopt_side();
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
                        for n in &mut self.steer {
                            if n.id.as_ref().is_some_and(|i| progress.notes_read.contains(i)) {
                                n.read = true;
                            }
                        }
                    }
                }
            }
            Reply::Catalog(r) => self.catalog = to_load(self.failed(r)),
            Reply::ArchivedChats(r) => self.archived = to_load(self.failed(r)),
            Reply::Identity(r) => self.identity = to_load(self.failed(r)),
            Reply::Memory(b, r) if here(self, &b) => self.memory = to_load(self.failed(r)),
            Reply::Memory(..) => {}
            Reply::ResearchSpend(b, r) if here(self, &b) => {
                let r = to_load(self.failed(r));
                if let Load::Ready(spend) = &r {
                    self.research_limit.replace_text(&spend.budget.limit_micro.map(|m| format!("{:.2}", m as f64 / 1_000_000.0)).unwrap_or_default());
                }
                self.research_spend = r;
            }
            Reply::ResearchSpend(..) => {}
            Reply::ResearchBudgetSaved(b, r) if here(self, &b) => {
                self.research_limit_busy = false;
                match self.failed(r) {
                    Ok(budget) => {
                        if let Load::Ready(spend) = &mut self.research_spend {
                            spend.budget = budget.clone();
                        }
                        self.research_limit.replace_text(&budget.limit_micro.map(|m| format!("{:.2}", m as f64 / 1_000_000.0)).unwrap_or_default());
                        self.notice = Some(match budget.limit_micro {
                            Some(m) => format!("Monthly research limit set to {}.", crate::settings::dollars(m)),
                            None => "Monthly research limit removed.".into(),
                        });
                    }
                    Err(e) => self.research_limit_error = Some(if e.is_empty() { "Couldn't save the limit. Try again.".into() } else { e }),
                }
            }
            Reply::ResearchBudgetSaved(..) => self.research_limit_busy = false,
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
            Reply::ChannelDetail { generation, result } => {
                let result = self.failed(result);
                if let Some(p) = &mut self.channel_setup {
                    if p.generation == generation { p.loaded = to_load(result); }
                }
            },
            Reply::ChannelAction { generation, result } => {
                let safe_error = result.as_ref().err().map(crate::channel_setup::error_message);
                let result = self.failed(result);
                if self.channel_setup.as_ref().is_some_and(|p| p.generation == generation) {
                    let p = self.channel_setup.as_mut().unwrap();
                    p.busy = false;
                    p.secret.replace_text("");
                    p.confirming_disconnect = false;
                    match result {
                        Ok(Some(url)) => { p.busy = true; p.authorizing = true; crate::native_preview::authorize(&url); tx.wake_after(std::time::Duration::from_millis(500)); },
                        Ok(None) => { self.reload_channel(); self.refresh(); },
                        Err(_) => p.error = safe_error,
                    }
                }
            },
            Reply::Artifact { business, id, version, result } => {
                let result = self.failed(result);
                if let Some(p) = self.artifacts.iter_mut().find(|p| p.business == business && p.id == id && p.requested == version) {
                    p.loaded = to_load(result);
                    if p.loaded.ready().is_some_and(|a| crate::artifacts::is_page(&a.kind)) {
                        self.show_page_artifact(&id);
                    }
                }
            },
            Reply::Diff { business, id, result } => {
                if self.active.as_deref() == Some(business.as_str()) {
                    let result = self.failed(result);
                    self.diff_loaded(&id, result);
                }
            }
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
            Reply::NoteSent { local, result } => {
                let read = match &self.turn {
                    Turn::Working { progress, .. } => progress.notes_read.clone(),
                    _ => Vec::new(),
                };
                match result {
                    Ok(id) => {
                        if let Some(n) = self.steer.iter_mut().find(|n| n.local == local) {
                            n.read = read.contains(&id);
                            n.id = Some(id);
                        }
                    }
                    // Refused (the run had just finished, or took all it can): it goes next instead.
                    Err(_) => {
                        if let Some(at) = self.steer.iter().position(|n| n.local == local) {
                            let n = self.steer.remove(at);
                            if matches!(self.turn, Turn::Working { .. }) {
                                self.queued.insert(0, n.text);
                            } else {
                                self.queued.push(n.text);
                            }
                        }
                    }
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
                self.settle_steer();
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
                        let new = self.chat_id.is_none();
                        self.chat_id = Some(conversation.clone());
                        if new {
                            self.adopt_side();
                        }
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
                            // The popup is always the rating form, starting from what was saved.
                            if a.detail.ready().is_none() {
                                a.reviewing = true;
                                a.verdict = d.issue.verdict.as_deref().and_then(|v| VERDICTS.iter().find(|x| x.0 == v)).map(|x| x.0);
                                a.facts = d.issue.facts.iter().map(|f| f.id.clone()).collect();
                                if a.notes.text.is_empty() {
                                    a.notes = TextEdit::new(d.issue.notes.clone().unwrap_or_default());
                                }
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
                let mut saved = false;
                if let Some(a) = self.answer.as_mut().filter(|a| a.claim == claim) {
                    a.judging = false;
                    match r {
                        Ok(()) => {
                            saved = true;
                            a.reviewing = false;
                            a.verdict = None;
                            a.facts.clear();
                            a.notes.clear();
                            if let Some(b) = &business {
                                self.net.answer(b.clone(), claim);
                            }
                            self.notice = Some(if verdict == "SUPPORTED" {
                                "Rating saved. Answers marked correct leave the review list.".into()
                            } else {
                                "Rating saved. This answer stays in the review list until it is corrected.".into()
                            });
                        }
                        Err(e) if e.is_empty() => {}
                        Err(e) => a.error = Some(format!("Couldn't save the rating. {e}")),
                    }
                }
                // Saved: the popup closes onto the list, which reloads with the new rating.
                if saved {
                    let notice = self.notice.take();
                    self.close_answer();
                    self.notice = notice;
                    if let Some(b) = business {
                        self.net.issues(b);
                    }
                }
            }
            Reply::Rechecked { claim, result } => {
                let r = self.failed(result);
                if let Some(a) = self.answer.as_mut().filter(|a| a.claim == claim) {
                    a.rechecking = false;
                    match r {
                        Ok(()) => self.notice = Some("Re-check queued. The assistants are asked the same question again, and the new answer shows here beside the old one.".into()),
                        Err(e) if e.is_empty() => {}
                        Err(e) if e.contains("already") => self.notice = Some("A re-check is already waiting for this answer.".into()),
                        Err(e) => a.error = Some(format!("Couldn't queue the re-check. {e}")),
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
                if let Some((_, load)) = self.helpers.iter_mut().find(|(open, _)| *open == id) {
                    {
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
            Reply::BriefSchedule { business, generation, changed, result } => {
                if here(self, &business) && generation == self.brief_schedule.generation {
                    let result = self.failed(result);
                    self.brief_schedule_loaded(&business, generation, changed, result);
                }
            }
            Reply::BriefScheduleControl { business, generation, origin, result } => {
                if !here(self, &business) || generation != self.brief_schedule.generation { return; }
                match self.failed(result) {
                    Ok(control) => {
                        self.brief_schedule_loaded(&business, generation, true, Ok(Some(control.schedule)));
                        if !self.general && self.chat_id == origin && matches!(self.turn, Turn::Idle) {
                            let new = self.chat_id.is_none();
                            self.chat_id = Some(control.conversation.id.clone());
                            if new { self.adopt_side(); }
                            self.home = false;
                            self.conversation = Load::Ready(control.conversation);
                            self.queue_artifact_diff_stats();
                            self.turn = Turn::Working { message: control.message, request: Some(control.request), progress: Default::default(), started: std::time::Instant::now(), stopping: false };
                            tx.scroll_to_bottom("transcript");
                        }
                        self.net.chats();
                    }
                    Err(error) if !error.is_empty() => {
                        self.notice = Some(format!("Could not confirm the weekly brief change: {error}"));
                        self.brief_schedule_loaded(&business, generation, true, Err(error));
                    }
                    Err(_) => {}
                }
            }
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
            Reply::Insights(b, days, r) if here(self, &b) && days == self.days => {
                self.insights = to_load(self.failed(r));
                self.clear_chart_lines();
            }
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
            | Reply::CampaignPublication(..)
            | Reply::CampaignRuns(..)
            | Reply::Conversation(..)
            | Reply::Branched(..)
            | Reply::RolledBack(..)
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

#[cfg(test)]
mod model_fallback_tests {
    use super::*;

    fn with(picked: &str, catalog: serde_json::Value) -> App {
        let mut s = App::new();
        s.agent_model = Some(picked.into());
        s.catalog = Load::Ready(crate::chat::model_options(&catalog));
        s
    }

    fn instance(id: &str, driver: &str, state: &str, models: &[&str]) -> serde_json::Value {
        serde_json::json!({ "id": id, "driver": driver, "name": driver, "enabled": true, "installed": true, "auth": "authenticated", "state": state,
            "models": models.iter().map(|m| serde_json::json!({ "id": m, "name": m })).collect::<Vec<_>>() })
    }

    #[test]
    fn a_model_that_stops_working_is_stood_in_for_and_said_so() {
        // Codex hit its usage limit; Claude Code is ready.
        let s = with("cx:gpt-6.1-terra", serde_json::json!({ "instances": [instance("cx", "codex", "usage_limited", &["gpt-6.1-terra"]), instance("cl", "claude", "ready", &["default", "opus"])] }));
        assert!(!s.model_unavailable(), "a turn can still run");
        assert_eq!(s.chosen_model().map(|m| m.value.as_str()), Some("cl:default"));
        assert_eq!(s.model_stand_in().map(|m| m.value.as_str()), Some("cl:default"));
        assert_eq!(s.agent_model.as_deref(), Some("cx:gpt-6.1-terra"), "the pick is kept for when it returns");
    }

    #[test]
    fn the_same_model_through_another_connection_is_preferred() {
        let s = with("old:opus", serde_json::json!({ "instances": [instance("cl", "claude", "ready", &["default", "opus"])] }));
        assert_eq!(s.chosen_model().map(|m| m.value.as_str()), Some("cl:opus"));
    }

    #[test]
    fn a_working_pick_has_no_stand_in_and_nothing_left_blocks() {
        let s = with("cl:opus", serde_json::json!({ "instances": [instance("cl", "claude", "ready", &["default", "opus"])] }));
        assert!(s.model_stand_in().is_none());
        let none = with("cx:gpt-6.1-terra", serde_json::json!({ "instances": [] }));
        assert!(none.model_unavailable());
    }

    #[test]
    fn a_recheck_is_asked_once_and_names_the_latest_fix() {
        let mut s = App::new();
        crate::fixtures::ai_answer(&mut s);
        s.active = Some("b-northstar".into());
        s.recheck_answer();
        assert!(s.answer.as_ref().unwrap().rechecking);
        // A second press while the first is on its way does nothing.
        s.recheck_answer();
        assert!(s.answer.as_ref().unwrap().rechecking);
        let fix = s.answer.as_ref().unwrap().detail.ready().unwrap().fix.clone().unwrap();
        assert!(!fix.checking());
        assert_eq!(fix.latest_attempt().unwrap().state, "COMPLETED");
    }

    #[test]
    fn a_turn_sent_before_the_model_list_arrives_keeps_the_saved_pick() {
        let mut s = App::new();
        s.catalog = Load::Loading;
        s.agent_model = Some("i1:gpt-6.1-terra".into());
        assert_eq!(s.turn_selection(), Some(serde_json::json!({ "instanceId": "i1", "model": "gpt-6.1-terra" })));
        s.agent_model = Some("hosted".into());
        assert_eq!(s.turn_selection(), None);
    }

    #[test]
    fn send_waits_for_the_catalog_and_a_resolvable_model() {
        let mut s = App::new();
        s.agent_model = Some("cl:opus".into());
        s.catalog = Load::Loading;
        assert!(!s.can_send_turn());
        s.catalog = Load::Ready(crate::chat::model_options(&serde_json::json!({ "instances": [instance("cl", "claude", "ready", &["opus"])] })));
        assert!(s.can_send_turn());
    }
}
