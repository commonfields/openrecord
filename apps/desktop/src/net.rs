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
    /// A chat was archived (`true`) or restored.
    Archived { archived: bool, result: ApiResult<()> },
    /// A turn finished (or failed) in this conversation.
    TurnDone { business: String, conversation: String, result: ApiResult<()> },
    /// A decision was approved (`true`) or declined, or the call failed.
    Decided { key: String, approved: bool, result: ApiResult<()> },
    /// The models a re-check can run on.
    Models(ApiResult<Vec<String>>),
    /// The Overview's data for a business over a number of days.
    Insights(String, u32, ApiResult<crate::insights::Insights>),
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

    /// Sends one message: makes the conversation first when there is none,
    /// queues the turn, then follows it until it settles, as the web
    /// client's `waitForAgentRequest` does.
    /// Asks the API to stop the turn running in a conversation.
    pub fn cancel(&self, business: String, conversation: String) {
        self.spawn(move |c, _send| {
            let _ = c.cancel(&business, &conversation);
        });
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

    pub fn send(&self, business: String, conversation: Option<(String, i64)>, out: crate::chat::Outgoing) {
        self.spawn(move |c, send| {
            let (conversation, revision) = match conversation {
                Some(pair) => pair,
                None => match c.new_conversation(&business, &crate::api::uuid()) {
                    Ok(conv) => (conv.id, conv.revision),
                    Err(e) => {
                        send(Reply::TurnDone { business, conversation: String::new(), result: Err(e) });
                        return;
                    }
                },
            };
            let request = crate::api::uuid();
            if let Err(e) = c.send(&business, &conversation, revision, &request, &out) {
                send(Reply::TurnDone { business, conversation, result: Err(e) });
                return;
            }
            send(Reply::TurnQueued { business: business.clone(), conversation: conversation.clone(), request: request.clone() });
            let result = follow(c, &request, &send);
            send(Reply::TurnDone { business, conversation, result });
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
