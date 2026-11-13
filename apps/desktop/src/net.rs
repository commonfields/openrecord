//! Requests off the UI thread. Each request runs on its own short-lived
//! thread with a clone of the client and lands as a `Reply` that `poll`
//! applies on the UI thread. The waker brings the window back to `poll`, so
//! an idle window stays idle.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use crate::api::{
    ApiError, ApiResult, Business, Campaign, Channel, ChatSummary, Client, Conversation, Decision, Issue, Overview,
};

pub enum Reply {
    Restored(ApiResult<()>),
    SignedIn(ApiResult<()>),
    SignedOut,
    Businesses(ApiResult<Vec<Business>>),
    Chats(ApiResult<Vec<ChatSummary>>),
    Decisions(ApiResult<Vec<Decision>>),
    Overview(String, ApiResult<Overview>),
    Issues(String, ApiResult<Vec<Issue>>),
    /// A business's approved facts, for "Find…".
    Facts(String, ApiResult<Vec<crate::api::Fact>>),
    Channels(String, ApiResult<Vec<Channel>>),
    Campaigns(String, ApiResult<Vec<Campaign>>),
    Conversation(String, ApiResult<Option<Conversation>>),
    /// A turn was accepted: the conversation it belongs to (new or existing).
    TurnQueued { business: String, conversation: String, request: String },
    /// New entries in the journal of the run answering a request (empty: still running).
    Progress { request: String, events: Vec<crate::chat::RunEvent> },
    /// The models the composer offers.
    Catalog(ApiResult<Vec<crate::chat::ModelOption>>),
    ArchivedChats(ApiResult<Vec<ChatSummary>>),
    Identity(ApiResult<crate::settings::Identity>),
    Memory(String, ApiResult<Vec<crate::settings::Note>>),
    Providers(ApiResult<crate::settings::Catalog>),
    Pairing(ApiResult<crate::settings::Pairing>),
    /// A settings change failed; what to tell the person.
    SettingFailed(String),
    /// A chat was archived (`true`) or restored.
    Archived { archived: bool, result: ApiResult<()> },
    /// A turn finished (or failed) in this conversation; `request` once the API accepted it.
    TurnDone { business: String, conversation: String, request: Option<String>, result: ApiResult<()> },
    /// A turn already under way in this conversation, started elsewhere or
    /// before the app last quit; it is followed until it settles.
    TurnResumed { business: String, conversation: String, request: String, message: String },
    /// Stop was pressed but the API did not take it.
    CancelFailed,
    /// A decision was approved (`true`) or declined, or the call failed.
    Decided { key: String, approved: bool, result: ApiResult<()> },
    /// The models a re-check can run on.
    Models(ApiResult<Vec<String>>),
    /// One AI answer's claim opened for review (`true`: facts and actions loaded too).
    Answer(String, String, ApiResult<(crate::api::AnswerDetail, bool)>),
    /// A verdict was recorded on a claim (or the call failed).
    Judged { claim: String, verdict: String, result: ApiResult<()> },
    /// An action was recorded for a claim (or the call failed).
    ActionRecorded { claim: String, result: ApiResult<()> },
    /// A business's agent proposals, for the work pane.
    Proposals(String, ApiResult<Vec<crate::api::Proposal>>),
    /// A helper session opened beside the conversation.
    Helper(String, ApiResult<Option<crate::api::Conversation>>),
    /// The account's client records, for "Start a new chat".
    Clients(ApiResult<Vec<(String, String)>>),
    /// The "/" menu's playbooks for a business.
    Playbooks(Option<String>, ApiResult<Vec<crate::chat::Playbook>>),
    /// A playbook was saved (`Some(name)`) or deleted, or the call failed.
    PlaybookChanged { saved: Option<String>, result: ApiResult<()> },
    /// A chat's read-only links, and a link just made (shown once).
    Shares { conversation: String, created: Option<ApiResult<String>>, list: ApiResult<Vec<crate::api::Share>> },
    /// A business's follow-up policy (read, or as a change left it).
    Followups { business: String, changed: bool, result: ApiResult<crate::followups::Followups> },
    /// The Overview's data for a business over a number of days.
    Insights(String, u32, ApiResult<crate::insights::Insights>),
    /// The newest desktop release past this build, if any.
    UpdateChecked(Result<Option<crate::update::Release>, String>),
    /// An update was installed (the app restarts), or why it was not.
    UpdateInstalled(Result<(), String>),
    /// A business setup started (its id), or why not.
    SetupStarted(ApiResult<String>),
    /// A campaign was saved (the server's copy), or why not.
    CampaignSaved(String, ApiResult<crate::api::Campaign>),
    /// The Channels page's account statuses for a business.
    ChannelStatus(String, ApiResult<crate::channel_status::Status>),
    /// The account's usage over a number of days.
    Usage(u32, ApiResult<crate::account::Usage>),
    /// Every business with its overview and 30 days of answers.
    Portfolio(ApiResult<Vec<crate::account::Portfolio>>),
    /// The account's clients with their marketing progress.
    ClientRows(ApiResult<Vec<crate::account::ClientRow>>),
}

/// A change to the agent's provider connections.
pub enum ProviderChange {
    Enable(String, bool),
    Refresh(String),
    Model(String, String, bool),
    Revoke(String),
    StartLocal,
}

pub struct Net {
    client: Option<Client>,
    tx: Sender<Reply>,
    rx: Receiver<Reply>,
    waker: Option<rune::Waker>,
}

impl Net {
    /// A worker against `base`. `None` makes a worker that never sends,
    /// for headless scenes drawn from fixture data.
    pub fn new(base: Option<String>) -> Net {
        let (tx, rx) = channel();
        Net { client: base.map(Client::new), tx, rx, waker: None }
    }

    /// Points the worker at another server. The saved session belonged to the
    /// old one and is dropped first, so its cookie is never sent to the new one.
    pub fn rebase(&mut self, base: String) {
        if self.client.is_some() {
            crate::api::forget_saved_session();
            self.client = Some(Client::new(base));
        }
    }

    /// Whether this worker sends at all (headless scenes have no client).
    pub fn live(&self) -> bool {
        self.client.is_some()
    }

    pub fn has_session(&self) -> bool {
        self.client.as_ref().is_some_and(Client::has_session)
    }

    pub fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker);
    }

    pub fn take(&self) -> Vec<Reply> {
        self.rx.try_iter().collect()
    }

    fn spawn(&self, work: impl FnOnce(&Client, &dyn Fn(Reply)) + Send + 'static) {
        let Some(client) = self.client.clone() else { return };
        let tx = self.tx.clone();
        let waker = self.waker.clone();
        std::thread::spawn(move || {
            let send = |r: Reply| {
                let _ = tx.send(r);
                if let Some(w) = &waker {
                    w();
                }
            };
            work(&client, &send);
        });
    }

    pub fn restore(&self) {
        self.spawn(|c, send| send(Reply::Restored(c.me())));
    }

    pub fn signin(&self, email: String, password: String) {
        self.spawn(move |c, send| send(Reply::SignedIn(c.signin(&email, &password))));
    }

    pub fn signout(&self) {
        self.spawn(|c, send| {
            let _ = c.signout();
            send(Reply::SignedOut);
        });
    }

    /// Everything the shell shows for the account: businesses, chats and the
    /// decisions waiting on the person.
    pub fn workspace(&self) {
        self.spawn(|c, send| {
            send(Reply::Businesses(c.businesses()));
            send(Reply::Chats(c.chats()));
            send(Reply::Decisions(c.decisions()));
        });
    }

    pub fn chats(&self) {
        self.spawn(|c, send| send(Reply::Chats(c.chats())));
    }

    pub fn decisions(&self) {
        self.spawn(|c, send| send(Reply::Decisions(c.decisions())));
    }

    pub fn decide(&self, d: Decision, approve: bool, model: Option<String>, reason: Option<String>) {
        self.spawn(move |c, send| {
            let result = c.decide(&d, approve, model.as_deref(), reason.as_deref());
            send(Reply::Decided { key: d.key.clone(), approved: approve, result });
        });
    }

    pub fn insights(&self, business: String, days: u32) {
        self.spawn(move |c, send| {
            let r = c.insights(&business, days);
            send(Reply::Insights(business, days, r));
        });
    }

    /// Looks for a newer desktop release (not in headless scenes, which have no client).
    pub fn check_update(&self) {
        self.spawn(|_c, send| send(Reply::UpdateChecked(crate::update::check())));
    }

    /// Downloads and installs `r` in place of the running app.
    pub fn install_update(&self, r: crate::update::Release) {
        self.spawn(move |_c, send| send(Reply::UpdateInstalled(crate::update::install(&r))));
    }

    pub fn models(&self) {
        self.spawn(|c, send| send(Reply::Models(c.models())));
    }

    pub fn overview(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.overview(&business);
            send(Reply::Overview(business, r));
        });
    }

    pub fn issues(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.issues(&business);
            send(Reply::Issues(business, r));
        });
    }

    pub fn facts(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.facts(&business);
            send(Reply::Facts(business, r));
        });
    }

    pub fn answer(&self, business: String, claim: String) {
        self.spawn(move |c, send| {
            let r = c.answer(&business, &claim);
            send(Reply::Answer(business, claim, r));
        });
    }

    /// Records a verdict, then reloads the claim list and the counts.
    pub fn judge(&self, business: String, claim: String, verdict: String, facts: Vec<String>, notes: Option<String>) {
        self.spawn(move |c, send| {
            let result = c.judge(&claim, &verdict, &facts, notes.as_deref());
            let ok = result.is_ok();
            send(Reply::Judged { claim: claim.clone(), verdict, result });
            if ok {
                send(Reply::Issues(business.clone(), c.issues(&business)));
                send(Reply::Overview(business.clone(), c.overview(&business)));
            }
        });
    }

    pub fn record_action(&self, business: String, claim: String, kind: String, target: String, notes: Option<String>) {
        self.spawn(move |c, send| {
            let result = c.record_action(&business, &claim, &kind, &target, notes.as_deref());
            send(Reply::ActionRecorded { claim, result });
        });
    }

    pub fn proposals(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.proposals(&business);
            send(Reply::Proposals(business, r));
        });
    }

    pub fn helper(&self, business: String, id: String) {
        self.spawn(move |c, send| {
            let r = c.conversation(&business, Some(&id));
            send(Reply::Helper(id, r));
        });
    }

    pub fn start_setup(&self, website: String, goal: String, engagement: Option<&'static str>) {
        self.spawn(move |c, send| send(Reply::SetupStarted(c.start_setup(&website, &goal, engagement))));
    }

    pub fn save_campaign(&self, business: String, c: crate::api::Campaign) {
        self.spawn(move |cl, send| {
            let r = cl.save_campaign(&business, &c);
            send(Reply::CampaignSaved(business, r));
        });
    }

    pub fn channel_status(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.channel_status(&business);
            send(Reply::ChannelStatus(business, r));
        });
    }

    pub fn usage(&self, days: u32) {
        self.spawn(move |c, send| send(Reply::Usage(days, c.usage(days))));
    }

    pub fn portfolio(&self, businesses: Vec<(String, String)>) {
        self.spawn(move |c, send| send(Reply::Portfolio(c.portfolio(&businesses))));
    }

    pub fn client_rows(&self) {
        self.spawn(|c, send| send(Reply::ClientRows(c.client_rows())));
    }

    pub fn clients(&self) {
        self.spawn(|c, send| send(Reply::Clients(c.clients())));
    }

    pub fn playbooks(&self, business: Option<String>) {
        self.spawn(move |c, send| {
            let r = c.playbooks(business.as_deref());
            send(Reply::Playbooks(business, r));
        });
    }

    /// Saves (`Some(title, prompt)`) or deletes a playbook, then reloads the list.
    pub fn change_playbook(&self, business: Option<String>, name: String, save: Option<(String, String)>) {
        self.spawn(move |c, send| {
            let result = c.change_playbook(&name, save.as_ref().map(|(t, p)| (t.as_str(), p.as_str())));
            send(Reply::PlaybookChanged { saved: save.is_some().then(|| name.clone()), result });
            send(Reply::Playbooks(business.clone(), c.playbooks(business.as_deref())));
        });
    }

    /// Reads a chat's links; `create` makes one first, `revoke` ends one first.
    pub fn shares(&self, business: String, conversation: String, create: bool, revoke: Option<String>) {
        self.spawn(move |c, send| {
            let created = create.then(|| c.create_share(&business, &conversation));
            if let Some(id) = &revoke {
                if let Err(e) = c.revoke_share(&business, &conversation, id) {
                    send(Reply::Shares { conversation: conversation.clone(), created: Some(Err(e)), list: c.shares(&business, &conversation) });
                    return;
                }
            }
            let list = c.shares(&business, &conversation);
            send(Reply::Shares { conversation, created, list });
        });
    }

    pub fn followups(&self, business: String) {
        self.spawn(move |c, send| {
            let result = c.followups(&business);
            send(Reply::Followups { business, changed: false, result });
        });
    }

    /// Turns follow-ups on in a chat (`Some(conversation, grant, model)`) or pauses them.
    pub fn configure_followups(&self, business: String, enable: Option<(String, Option<String>, crate::followups::Model)>) {
        self.spawn(move |c, send| {
            let result = c.configure_followups(&business, enable.as_ref().map(|(conv, grant, m)| (conv.as_str(), grant.as_deref(), m)));
            send(Reply::Followups { business, changed: true, result });
        });
    }

    pub fn channels(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.channels(&business);
            send(Reply::Channels(business, r));
        });
    }

    pub fn campaigns(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.campaigns(&business);
            send(Reply::Campaigns(business, r));
        });
    }

    pub fn conversation(&self, business: String, id: String) {
        self.spawn(move |c, send| {
            let r = c.conversation(&business, Some(&id));
            send(Reply::Conversation(business, r));
        });
    }

    /// Opens a conversation as the web does on load: a turn still in flight
    /// (or one that failed since the chat last changed) is attached to and
    /// followed, never sent again; then the conversation loads.
    pub fn sync(&self, business: String, id: String) {
        self.spawn(move |c, send| {
            if let Ok(Some(p)) = c.pending_request(&id) {
                let request = p.request_id;
                send(Reply::TurnResumed { business: business.clone(), conversation: id.clone(), request: request.clone(), message: p.message.unwrap_or_default() });
                let result = follow(c, &request, &send);
                send(Reply::TurnDone { business, conversation: id, request: Some(request), result });
                return;
            }
            let r = c.conversation(&business, Some(&id));
            send(Reply::Conversation(business, r));
        });
    }

    /// Asks the API to stop a turn: the request itself once it is known
    /// (`cancelRequest`), otherwise whatever runs in the conversation.
    pub fn cancel(&self, business: String, conversation: String, request: Option<String>) {
        self.spawn(move |c, send| {
            let r = match &request {
                Some(id) => c.cancel_request(id),
                None => c.cancel(&business, &conversation),
            };
            if r.is_err() {
                send(Reply::CancelFailed);
            }
        });
    }

    pub fn identity(&self) {
        self.spawn(|c, send| send(Reply::Identity(c.identity())));
    }

    pub fn memory(&self, business: String) {
        self.spawn(move |c, send| {
            let r = c.memory(&business);
            send(Reply::Memory(business, r));
        });
    }

    /// Adds (`Some(kind, text)`) or forgets (`None`, by id) a memory note, then reloads the notes.
    pub fn change_memory(&self, business: String, add: Option<(String, String)>, forget: Option<String>) {
        self.spawn(move |c, send| {
            let r = match (&add, &forget) {
                (Some((kind, text)), _) => c.remember(&business, kind, text),
                (_, Some(id)) => c.forget(&business, id),
                _ => Ok(()),
            };
            if r.is_err() {
                send(Reply::SettingFailed(if add.is_some() { "Couldn't save the note. Forget an old one if the memory is full." } else { "Couldn't forget the note. Try again." }.into()));
            }
            let list = c.memory(&business);
            send(Reply::Memory(business, list));
        });
    }

    pub fn providers(&self) {
        self.spawn(|c, send| send(Reply::Providers(c.providers())));
    }

    /// Changes a provider connection, then reloads the providers and the composer's models.
    pub fn change_provider(&self, change: ProviderChange) {
        self.spawn(move |c, send| {
            let (r, failed) = match &change {
                ProviderChange::Enable(i, on) => (c.set_provider_enabled(i, *on), "Couldn't save that. The provider state may have changed. Try again."),
                ProviderChange::Refresh(i) => (c.refresh_provider(i), "Couldn't request a refresh. Try again in a moment."),
                ProviderChange::Model(i, m, on) => (c.choose_provider_model(i, m, *on), "Couldn't change that model. Try again."),
                ProviderChange::Revoke(b) => (c.revoke_bridge(b), "Couldn't disconnect it. It may already be gone. Try again."),
                ProviderChange::StartLocal => match c.start_local_bridge() {
                    Ok(s) if s == "UNAVAILABLE" => (Ok(()), "The bridge program isn't available on this computer."),
                    Ok(s) if s == "DISABLED" => (Ok(()), "This server isn't running in local mode (OPENRECORD_LOCAL_BRIDGE)."),
                    Ok(_) => (Ok(()), ""),
                    Err(e) => (Err(e), "The bridge didn't start. Try again."),
                },
            };
            if r.is_err() || (matches!(change, ProviderChange::StartLocal) && !failed.is_empty()) {
                send(Reply::SettingFailed(failed.into()));
            }
            send(Reply::Providers(c.providers()));
            send(Reply::Catalog(c.catalog()));
        });
    }

    pub fn pair(&self, name: String) {
        self.spawn(move |c, send| send(Reply::Pairing(c.pair(&name))));
    }

    pub fn archived_chats(&self) {
        self.spawn(|c, send| send(Reply::ArchivedChats(c.archived_chats())));
    }

    pub fn archive(&self, conversation: String, archived: bool) {
        self.spawn(move |c, send| {
            let result = c.archive(&conversation, archived);
            send(Reply::Archived { archived, result });
            send(Reply::Chats(c.chats()));
            send(Reply::ArchivedChats(c.archived_chats()));
        });
    }

    pub fn catalog(&self) {
        self.spawn(|c, send| send(Reply::Catalog(c.catalog())));
    }

    /// Sends one message: makes the conversation first when there is none,
    /// queues the turn, then follows it until it settles, as the web
    /// client's `waitForAgentRequest` does.
    pub fn send(&self, business: String, conversation: Option<(String, i64)>, out: crate::chat::Outgoing) {
        self.spawn(move |c, send| {
            let (conversation, revision) = match conversation {
                Some(pair) => pair,
                None => match c.new_conversation(&business, &crate::api::uuid()) {
                    Ok(conv) => (conv.id, conv.revision),
                    Err(e) => {
                        send(Reply::TurnDone { business, conversation: String::new(), request: None, result: Err(e) });
                        return;
                    }
                },
            };
            let request = crate::api::uuid();
            if let Err(e) = c.send(&business, &conversation, revision, &request, &out) {
                send(Reply::TurnDone { business, conversation, request: None, result: Err(e) });
                return;
            }
            send(Reply::TurnQueued { business: business.clone(), conversation: conversation.clone(), request: request.clone() });
            let result = follow(c, &request, &send);
            send(Reply::TurnDone { business, conversation, request: Some(request), result });
        });
    }
}

fn follow(c: &Client, request: &str, send: &dyn Fn(Reply)) -> ApiResult<()> {
    let started = Instant::now();
    let mut offline_since: Option<Instant> = None;
    let mut seq = 0;
    loop {
        // The run's journal first, so the live trace moves while the turn runs;
        // an empty batch still wakes the window for its clock.
        if let Ok(events) = c.progress(request, seq) {
            seq = events.iter().map(|e| e.seq).max().unwrap_or(seq);
            send(Reply::Progress { request: request.to_string(), events });
        }
        match c.job(request) {
            Ok(job) => {
                offline_since = None;
                match job.status.as_str() {
                    "COMPLETED" => return Ok(()),
                    "QUEUED" | "RUNNING" => {}
                    other => {
                        let reason = job.failure_reason.unwrap_or_else(|| other.to_string());
                        return Err(ApiError::Status(503, reason));
                    }
                }
            }
            Err(e @ ApiError::Unauthorized) => return Err(e),
            Err(ApiError::Status(code, body)) if code < 500 => return Err(ApiError::Status(code, body)),
            Err(e) => {
                let since = *offline_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(30) {
                    return Err(e);
                }
            }
        }
        if started.elapsed() > Duration::from_secs(20 * 60) {
            return Err(ApiError::Status(504, "the turn took longer than twenty minutes".into()));
        }
        std::thread::sleep(Duration::from_millis(900));
    }
}
