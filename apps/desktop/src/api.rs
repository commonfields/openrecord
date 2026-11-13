//! The OpenRecord API, as the web client calls it (`apps/web/app/lib/api.ts`).
//!
//! Blocking calls, run only on the network worker (`net.rs`), never on the UI
//! thread. The session is the API's `or_session` cookie, which the client keeps
//! and saves so a relaunch stays signed in.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const SESSION_COOKIE: &str = "or_session";

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// The session is missing or has ended.
    Unauthorized,
    /// The server answered with an error status.
    Status(u16, String),
    /// The server could not be reached.
    Offline(String),
    /// The answer did not have the expected shape.
    Decode(String),
}

impl ApiError {
    /// A sentence for the person, in the web app's wording (`errorMessage`).
    pub fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "Your session has ended. Sign in again to continue.".into(),
            ApiError::Status(404, _) => "That item no longer exists or belongs to another account.".into(),
            ApiError::Status(422, _) => "Some fields are missing or invalid. Check them and try again.".into(),
            ApiError::Status(429, _) => "The provider is rate limiting requests. Try again in a minute.".into(),
            ApiError::Status(s, _) if *s >= 500 => "The server could not complete the request. Try again shortly.".into(),
            ApiError::Offline(_) => "OpenRecord's server can't be reached. Check that it is running and try again.".into(),
            _ => "Something went wrong. Check your connection and try again.".into(),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Business {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub business_id: Option<String>,
    pub business_name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub working: bool,
    #[serde(default)]
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub activity: Vec<crate::chat::Activity>,
    #[serde(default)]
    pub citations: Vec<crate::chat::Citation>,
    #[serde(default)]
    pub decisions: Vec<crate::chat::DecisionRef>,
    #[serde(default)]
    pub tasks: Vec<crate::chat::TaskRef>,
    #[serde(default)]
    pub run: Option<crate::chat::RunRef>,
    #[serde(default, rename = "durationMs")]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub inference: Option<crate::chat::Inference>,
    #[serde(default)]
    pub origin: Option<crate::chat::Origin>,
    #[serde(default)]
    pub attachments: Vec<crate::chat::Attachment>,
    #[serde(default)]
    pub context: Option<crate::chat::ContextUse>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Message {
        Message {
            role: "user".into(),
            text: text.into(),
            tool_calls: Vec::new(),
            activity: Vec::new(),
            citations: Vec::new(),
            decisions: Vec::new(),
            tasks: Vec::new(),
            run: None,
            duration_ms: None,
            inference: None,
            origin: None,
            attachments: Vec::new(),
            context: None,
        }
    }

    /// The work log: the recorded steps, or for older replies the tools it ran.
    pub fn work_log(&self) -> Vec<crate::chat::Activity> {
        if !self.activity.is_empty() {
            return self.activity.clone();
        }
        self.tool_calls.iter().map(|c| crate::chat::Activity::Tool { tool: c.tool.clone(), text: c.summary.clone(), failed: false }).collect()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ToolCall {
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Conversation {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// Set on a helper session: the session that started it.
    #[serde(default)]
    pub session: Option<crate::chat::SessionInfo>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct Overview {
    #[serde(default, deserialize_with = "num")]
    pub completed: i64,
    #[serde(default)]
    pub last_checked: Option<String>,
    #[serde(default, deserialize_with = "num")]
    pub unreviewed: i64,
    #[serde(default, deserialize_with = "num")]
    pub needs_attention: i64,
}

/// Counts arrive as strings from Postgres `count(*)`; accept either.
fn num<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Issue {
    pub claim_id: String,
    pub claim_text: String,
    #[serde(default)]
    pub answer_text: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub observed_model: Option<String>,
    #[serde(default)]
    pub question_prompt: Option<String>,
    #[serde(default)]
    pub collected_at: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub observation_id: String,
    /// The reviewer's verdict, when the claim has one.
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// The approved facts the verdict was linked to.
    #[serde(default)]
    pub facts: Vec<IssueFact>,
    /// The sources the answer cited.
    #[serde(default)]
    pub citation_evidence: Vec<CitationEvidence>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct IssueFact {
    pub id: String,
    #[serde(default)]
    pub predicate: String,
    #[serde(default, rename = "valueText")]
    pub value_text: String,
    #[serde(default)]
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CitationEvidence {
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub attributed: bool,
}

/// An approved fact a verdict can link to.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub predicate: String,
    #[serde(default)]
    pub value_text: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub version: i64,
}

/// An action recorded against an issue: a hand-kept log that changes no verdict.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Intervention {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub performed_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub supersedes_id: Option<String>,
}

/// A proposal the agent saved (`/agent/proposals`): the work pane lists the
/// ones a chat's replies made, and shows accepted drafts with their text.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Proposal {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub payload: Option<ProposalPayload>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalPayload {
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub references: Vec<crate::chat::Citation>,
}

impl Proposal {
    /// A draft the person keeps once accepted (`conversationProposals` on the web).
    pub fn is_draft(&self) -> bool {
        matches!(self.kind.as_str(), "DRAFT_SOURCE_ACTION" | "PREPARE_CLIENT_REPORT" | "PROPOSE_QUESTION_SET")
    }

    pub fn draft_name(&self) -> &'static str {
        match self.kind.as_str() {
            "PREPARE_CLIENT_REPORT" => "Private client report",
            "PROPOSE_QUESTION_SET" => "Buyer-question proposal",
            _ => "Source action hypothesis",
        }
    }
}

/// A read-only link to a chat.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub last_viewed_at: Option<String>,
    #[serde(default)]
    pub active: bool,
}

/// One AI answer's claim with what reviewing it needs.
#[derive(Debug, Clone, PartialEq)]
pub struct AnswerDetail {
    pub issue: Issue,
    /// The business's active approved facts.
    pub facts: Vec<Fact>,
    pub actions: Vec<Intervention>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Channel {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub identity: Option<String>,
    pub state: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub active: Vec<String>,
}

/// A campaign as the list returns it: its saved brief (`CampaignBrief` in
/// `packages/contracts/src/campaigns.ts`), read field by field so a missing
/// one is empty rather than a failed list.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Campaign {
    pub id: String,
    pub revision: i64,
    pub title: String,
    /// DRAFT, ACTIVE, REVIEW or CLOSED.
    pub status: String,
    pub goal: String,
    pub audience: String,
    pub offer: String,
    pub message: String,
    pub hypothesis: String,
    pub metric: String,
    pub baseline: String,
    pub target: String,
    pub owner: String,
    pub launch_date: String,
    pub review_date: String,
    pub tasks: Vec<CampaignTask>,
    pub result: String,
    /// UNDECIDED, KEEP, CHANGE, STOP or INCONCLUSIVE.
    pub decision: String,
    pub learning: String,
    pub next_move: String,
    pub channel: String,
    pub rationale: String,
    pub destination: String,
    /// OWNED, EARNED, PAID, PRODUCT_LED, HYBRID or UNSPECIFIED.
    pub motion: String,
    /// AWARENESS through REFERRAL, or UNSPECIFIED.
    pub funnel_stage: String,
    pub budget: String,
    pub cadence: String,
    pub conversion_event: String,
    pub tracking_plan: String,
    pub updated_at: Option<String>,
    /// Who drafted it: OPERATOR or ASSISTANT.
    pub created_by: String,
}

/// One deliverable of a campaign.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CampaignTask {
    pub id: String,
    pub title: String,
    pub owner: String,
    pub due: String,
    /// WEBSITE, EMAIL, PAID, SOCIAL or OTHER.
    pub channel: String,
    /// TODO, IN_PROGRESS, BLOCKED or DONE.
    pub status: String,
    /// A blocker, handoff or link.
    pub note: String,
}

impl Campaign {
    /// What still stands between the brief and a launch (`campaignBlockers`).
    pub fn blockers(&self) -> Vec<String> {
        let fields = [
            (&self.goal, "Define a goal"),
            (&self.audience, "Choose an audience"),
            (&self.offer, "Define the offer"),
            (&self.message, "Agree the message"),
            (&self.hypothesis, "Write a hypothesis"),
            (&self.metric, "Define the success metric and data source"),
            (&self.baseline, "Record a baseline or explain why unavailable"),
            (&self.target, "Set a target"),
            (&self.owner, "Assign a campaign owner"),
            (&self.launch_date, "Set a launch date"),
            (&self.review_date, "Schedule a review"),
        ];
        let mut out: Vec<String> = fields.iter().filter(|(v, _)| v.trim().is_empty()).map(|(_, l)| l.to_string()).collect();
        if self.tasks.is_empty() {
            out.push("Add launch deliverables".into());
        }
        out.extend(self.tasks.iter().filter(|t| t.owner.trim().is_empty() || t.due.is_empty()).map(|t| format!("{}: assign an owner and due date", t.title)));
        out.extend(self.tasks.iter().filter(|t| t.status != "DONE").map(|t| format!("{}: {}", t.title, if t.status == "BLOCKED" { "blocked" } else { "not complete" })));
        out
    }

    /// Deliverables done, of all of them.
    pub fn done(&self) -> (usize, usize) {
        (self.tasks.iter().filter(|t| t.status == "DONE").count(), self.tasks.len())
    }

    /// A live campaign whose review date has come.
    #[allow(dead_code)]
    pub fn review_due(&self, today: &str) -> bool {
        matches!(self.status.as_str(), "ACTIVE" | "REVIEW") && (self.review_date.is_empty() || self.review_date.as_str() <= today)
    }
}

pub use crate::decisions::Decision;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AgentJob {
    pub status: String,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

#[derive(Clone)]
pub struct Client {
    base: String,
    agent: ureq::Agent,
    session: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl Client {
    pub fn new(base: impl Into<String>) -> Client {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            .redirects(0)
            .build();
        let session = std::sync::Arc::new(std::sync::Mutex::new(load_session()));
        Client { base: base.into().trim_end_matches('/').to_string(), agent, session }
    }

    pub fn has_session(&self) -> bool {
        self.session().is_some()
    }

    fn session(&self) -> Option<String> {
        self.session.lock().ok().and_then(|s| s.clone())
    }

    fn set_session(&self, value: Option<String>) {
        save_session(value.as_deref());
        if let Ok(mut s) = self.session.lock() {
            *s = value;
        }
    }

    pub(crate) fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Option<Value>) -> ApiResult<T> {
        let mut req = self.agent.request(method, &format!("{}{}", self.base, path)).set("Accept", "application/json");
        if let Some(s) = self.session() {
            req = req.set("Cookie", &format!("{SESSION_COOKIE}={s}"));
        }
        let res = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        let res = match res {
            Ok(r) => r,
            Err(ureq::Error::Status(401, _)) => {
                self.forget_session();
                return Err(ApiError::Unauthorized);
            }
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                return Err(ApiError::Status(code, body));
            }
            Err(ureq::Error::Transport(t)) => return Err(ApiError::Offline(t.to_string())),
        };
        for header in res.all("set-cookie") {
            if let Some(v) = cookie_value(header, SESSION_COOKIE) {
                if v.is_empty() {
                    self.forget_session();
                } else {
                    self.set_session(Some(v.to_string()));
                }
            }
        }
        res.into_json::<T>().map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// Opens a response that is read as it arrives (server-sent events): no
    /// limit on how long it runs, only on how long it may stay silent. The
    /// server sends a keep-alive line every ten seconds.
    pub(crate) fn open_stream(&self, path: &str) -> ApiResult<Box<dyn std::io::Read + Send + Sync + 'static>> {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(30)).redirects(0).build();
        let mut req = agent.get(&format!("{}{}", self.base, path)).set("Accept", "text/event-stream");
        if let Some(s) = self.session() {
            req = req.set("Cookie", &format!("{SESSION_COOKIE}={s}"));
        }
        match req.call() {
            Ok(r) if r.content_type() == "text/event-stream" => Ok(r.into_reader()),
            // Something answered that is not a stream, such as an older server's page.
            Ok(_) => Err(ApiError::Status(404, "not a stream".into())),
            Err(ureq::Error::Status(401, _)) => {
                self.forget_session();
                Err(ApiError::Unauthorized)
            }
            Err(ureq::Error::Status(code, r)) => Err(ApiError::Status(code, r.into_string().unwrap_or_default())),
            Err(e) => Err(ApiError::Offline(e.to_string())),
        }
    }

    pub(crate) fn get<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.call("GET", path, None)
    }

    pub(crate) fn post<T: DeserializeOwned>(&self, path: &str, body: Value) -> ApiResult<T> {
        self.call("POST", path, Some(body))
    }

    fn forget_session(&self) {
        self.set_session(None);
    }

    pub fn signin(&self, email: &str, password: &str) -> ApiResult<()> {
        self.post::<Value>("/api/auth/signin", json!({ "email": email, "password": password }))?;
        if self.session().is_none() {
            return Err(ApiError::Decode("the server did not start a session".into()));
        }
        Ok(())
    }

    pub fn signout(&self) -> ApiResult<()> {
        let result = self.post::<Value>("/api/auth/signout", json!({}));
        self.forget_session();
        result.map(|_| ())
    }

    pub fn me(&self) -> ApiResult<()> {
        self.get::<Value>("/api/auth/me").map(|_| ())
    }

    pub fn businesses(&self) -> ApiResult<Vec<Business>> {
        #[derive(Deserialize)]
        struct R {
            businesses: Vec<Business>,
        }
        Ok(self.get::<R>("/api/businesses")?.businesses)
    }

    pub fn chats(&self) -> ApiResult<Vec<ChatSummary>> {
        #[derive(Deserialize)]
        struct R {
            conversations: Vec<ChatSummary>,
        }
        let all = self.get::<R>("/api/agent/conversations")?.conversations;
        // Helper sessions open from the chat that started them, so the history
        // lists only the person's own chats, as the web sidebar does.
        Ok(all.into_iter().filter(|c| c.parent_session_id.is_none()).collect())
    }

    pub fn conversation(&self, business: &str, id: Option<&str>) -> ApiResult<Option<Conversation>> {
        #[derive(Deserialize)]
        struct R {
            conversation: Option<Conversation>,
        }
        let path = match id {
            Some(id) => format!("{}/conversation?conversationId={}", agent_base(business), enc(id)),
            None => format!("{}/conversation", agent_base(business)),
        };
        Ok(self.get::<R>(&path)?.conversation)
    }

    /// Starts a new, empty conversation for a business.
    pub fn new_conversation(&self, business: &str, id: &str) -> ApiResult<Conversation> {
        #[derive(Deserialize)]
        struct R {
            conversation: Conversation,
        }
        let path = format!("{}/conversation", agent_base(business));
        Ok(self.post::<R>(&path, json!({ "conversationId": id }))?.conversation)
    }

    /// Queues a turn and returns once the API has accepted it.
    pub fn send(&self, business: &str, conversation: &str, revision: i64, request_id: &str, out: &crate::chat::Outgoing) -> ApiResult<()> {
        let path = format!("{}/requests", agent_base(business));
        let mut body = json!({ "message": out.message, "requestId": request_id, "revision": revision, "conversationId": conversation });
        if let Some(sel) = &out.selection {
            body["selection"] = sel.clone();
        }
        if let Some(style) = &out.style {
            body["style"] = json!(style);
        }
        // This app draws generated views, so the agent may answer with ```ui blocks.
        body["surfaces"] = json!(["ui"]);
        if !out.attachments.is_empty() {
            body["attachments"] = json!(out.attachments.iter().map(|a| json!({ "name": a.name, "type": a.kind, "text": a.text })).collect::<Vec<_>>());
        }
        self.post::<Value>(&path, body).map(|_| ())
    }

    pub fn job(&self, request_id: &str) -> ApiResult<AgentJob> {
        self.get(&format!("/api/agent/requests/{}", enc(request_id)))
    }

    pub fn overview(&self, business: &str) -> ApiResult<Overview> {
        #[derive(Deserialize)]
        struct R {
            overview: Overview,
        }
        Ok(self.get::<R>(&format!("/api/businesses/{}/overview", enc(business)))?.overview)
    }

    /// A business's approved facts (the active versions).
    pub fn facts(&self, business: &str) -> ApiResult<Vec<Fact>> {
        #[derive(Deserialize)]
        struct F {
            facts: Vec<Fact>,
        }
        Ok(self.get::<F>(&format!("/api/businesses/{}/facts", enc(business)))?.facts.into_iter().filter(|f| f.status == "ACTIVE").collect())
    }

    pub fn issues(&self, business: &str) -> ApiResult<Vec<Issue>> {
        #[derive(Deserialize)]
        struct R {
            issues: Vec<Issue>,
        }
        Ok(self.get::<R>(&format!("/api/businesses/{}/issues", enc(business)))?.issues)
    }

    /// One claim, the facts a verdict can link, and the actions recorded for it.
    /// The facts and actions are best effort: the claim shows without them.
    pub fn answer(&self, business: &str, claim: &str) -> ApiResult<(AnswerDetail, bool)> {
        let issue: Issue = self.get(&format!("/api/businesses/{}/issues/{}", enc(business), enc(claim)))?;
        #[derive(Deserialize)]
        struct F {
            facts: Vec<Fact>,
        }
        #[derive(Deserialize)]
        struct A {
            interventions: Vec<Intervention>,
        }
        let facts = self.get::<F>(&format!("/api/businesses/{}/facts", enc(business)));
        let actions = self.get::<A>(&format!("/api/businesses/{}/issues/{}/interventions", enc(business), enc(claim)));
        let complete = facts.is_ok() && actions.is_ok();
        let facts = facts.map(|f| f.facts.into_iter().filter(|f| f.status == "ACTIVE").collect()).unwrap_or_default();
        let actions = actions.map(|a| a.interventions).unwrap_or_default();
        Ok((AnswerDetail { issue, facts, actions }, complete))
    }

    /// The playbooks the "/" menu offers: built-in ones and the account's own.
    /// The proposals the agent saved for a business.
    pub fn proposals(&self, business: &str) -> ApiResult<Vec<Proposal>> {
        #[derive(Deserialize)]
        struct R {
            proposals: Vec<Proposal>,
        }
        Ok(self.get::<R>(&format!("/api/businesses/{}/agent/proposals", enc(business)))?.proposals)
    }

    /// The account's client records: businesses seen from the agency side, by their own names.
    pub fn clients(&self) -> ApiResult<Vec<(String, String)>> {
        let v: Value = self.get("/api/record/clients")?;
        Ok(v.get("clients")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|c| Some((c.get("businessId")?.as_str()?.to_string(), c.get("name")?.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn playbooks(&self, business: Option<&str>) -> ApiResult<Vec<crate::chat::Playbook>> {
        #[derive(Deserialize)]
        struct R {
            playbooks: Vec<crate::chat::Playbook>,
        }
        let path = match business {
            Some(b) => format!("/api/playbooks?businessId={}", enc(b)),
            None => "/api/playbooks".into(),
        };
        Ok(self.get::<R>(&path)?.playbooks)
    }

    /// Saves (or replaces) one of the account's playbooks; `None` deletes it.
    pub fn change_playbook(&self, name: &str, save: Option<(&str, &str)>) -> ApiResult<()> {
        let path = format!("/api/playbooks/{}", enc(name));
        match save {
            Some((title, prompt)) => self.call::<Value>("PUT", &path, Some(json!({ "title": title, "prompt": prompt }))),
            None => self.call::<Value>("DELETE", &path, None),
        }
        .map(|_| ())
    }

    fn shares_path(business: &str, conversation: &str) -> String {
        format!("/api/businesses/{}/agent/conversations/{}/shares", enc(business), enc(conversation))
    }

    /// The read-only links made for a chat.
    pub fn shares(&self, business: &str, conversation: &str) -> ApiResult<Vec<Share>> {
        #[derive(Deserialize)]
        struct R {
            shares: Vec<Share>,
        }
        Ok(self.get::<R>(&Self::shares_path(business, conversation))?.shares)
    }

    /// Makes a read-only link that lasts fourteen days; returns its path on the web app.
    pub fn create_share(&self, business: &str, conversation: &str) -> ApiResult<String> {
        #[derive(Deserialize)]
        struct R {
            path: String,
        }
        Ok(self.post::<R>(&Self::shares_path(business, conversation), json!({ "days": 14 }))?.path)
    }

    pub fn revoke_share(&self, business: &str, conversation: &str, id: &str) -> ApiResult<()> {
        self.call::<Value>("DELETE", &format!("{}/{}", Self::shares_path(business, conversation), enc(id)), None).map(|_| ())
    }

    /// Records a reviewer's verdict on a claim, linked to the facts it touches.
    pub fn judge(&self, claim: &str, verdict: &str, facts: &[String], notes: Option<&str>) -> ApiResult<()> {
        self.post::<Value>("/api/judgments", json!({ "claimId": claim, "verdict": verdict, "factIds": facts, "notes": notes })).map(|_| ())
    }

    /// Logs an action taken for an issue.
    pub fn record_action(&self, business: &str, claim: &str, kind: &str, target: &str, notes: Option<&str>) -> ApiResult<()> {
        let path = format!("/api/businesses/{}/issues/{}/interventions", enc(business), enc(claim));
        self.post::<Value>(&path, json!({ "type": kind, "target": target, "notes": notes })).map(|_| ())
    }

    pub fn channels(&self, business: &str) -> ApiResult<Vec<Channel>> {
        #[derive(Deserialize)]
        struct Inventory {
            channels: Vec<Channel>,
        }
        #[derive(Deserialize)]
        struct R {
            inventory: Inventory,
        }
        Ok(self.get::<R>(&format!("/api/businesses/{}/channels", enc(business)))?.inventory.channels)
    }

    pub fn campaigns(&self, business: &str) -> ApiResult<Vec<Campaign>> {
        let v: Value = self.get(&format!("/api/businesses/{}/campaigns", enc(business)))?;
        let list = v.get("campaigns").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(list.iter().map(campaign).collect())
    }

    pub fn decisions(&self) -> ApiResult<Vec<Decision>> {
        let v: Value = self.get("/api/decisions")?;
        let list = v.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(list.iter().filter_map(crate::decisions::parse).collect())
    }

    /// Approves or declines one decision, then records the verdict for the
    /// agent, as the web cards do. The record is best effort.
    pub fn decide(&self, d: &Decision, approve: bool, model: Option<&str>, reason: Option<&str>) -> ApiResult<()> {
        let (path, body) = if approve { d.approve_call(model) } else { d.decline_call(reason) };
        self.post::<Value>(&path, body)?;
        let (path, body) = d.feedback(approve, reason);
        let _ = self.post::<Value>(&path, body);
        Ok(())
    }

    /// The measurement models a re-check can run on: 9Router's, when it is enabled.
    pub fn models(&self) -> ApiResult<Vec<String>> {
        let v: Value = self.get("/api/providers")?;
        let list = v.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(list
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some("9router") && p.get("enabled").and_then(Value::as_bool) == Some(true))
            .and_then(|p| p.get("models"))
            .and_then(Value::as_array)
            .map(|m| m.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default())
    }
}

fn s(v: &Value, path: &[&str]) -> Option<String> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_str().map(str::to_string)
}

fn first(v: &Value, paths: &[&[&str]]) -> String {
    paths.iter().find_map(|p| s(v, p)).unwrap_or_default()
}

fn campaign(v: &Value) -> Campaign {
    // The list nests the brief; older payloads kept its fields at the top.
    let b = v.get("brief").filter(|b| b.is_object()).unwrap_or(v);
    let t = |k: &str| s(b, &[k]).unwrap_or_default();
    let d = |k: &str| s(b, &["distribution", k]).unwrap_or_default();
    let tasks = b
        .get("tasks")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| CampaignTask {
                    id: first(x, &[&["id"]]),
                    note: first(x, &[&["note"]]),
                    title: first(x, &[&["title"]]),
                    owner: first(x, &[&["owner"]]),
                    due: first(x, &[&["due"]]),
                    channel: first(x, &[&["channel"]]),
                    status: first(x, &[&["status"]]),
                })
                .collect()
        })
        .unwrap_or_default();
    Campaign {
        id: first(v, &[&["id"]]),
        revision: v.get("revision").and_then(Value::as_i64).unwrap_or(0),
        title: first(b, &[&["title"], &["name"], &["plan", "title"]]),
        status: first(b, &[&["status"], &["stage"]]),
        goal: first(b, &[&["goal"], &["objective"], &["plan", "goal"]]),
        audience: t("audience"),
        offer: t("offer"),
        message: t("message"),
        hypothesis: t("hypothesis"),
        metric: t("metric"),
        baseline: t("baseline"),
        target: t("target"),
        owner: t("owner"),
        launch_date: t("launchDate"),
        review_date: t("reviewDate"),
        tasks,
        result: t("result"),
        decision: t("decision"),
        learning: t("learning"),
        next_move: t("nextMove"),
        channel: d("primaryChannel"),
        rationale: d("rationale"),
        destination: d("destination"),
        motion: d("motion"),
        funnel_stage: d("funnelStage"),
        budget: d("budget"),
        cadence: d("cadence"),
        conversion_event: d("conversionEvent"),
        tracking_plan: d("trackingPlan"),
        updated_at: s(v, &["updated_at"]).or_else(|| s(v, &["updatedAt"])).or_else(|| s(v, &["createdAt"])),
        created_by: first(v, &[&["created_by_actor"]]),
    }
}

impl Campaign {
    /// The brief as `CampaignBrief` takes it, for a save.
    pub fn brief_json(&self) -> Value {
        let or = |s: &str, d: &str| if s.is_empty() { d.to_string() } else { s.to_string() };
        serde_json::json!({
            "title": self.title, "goal": self.goal, "audience": self.audience, "offer": self.offer, "message": self.message,
            "hypothesis": self.hypothesis, "metric": self.metric, "baseline": self.baseline, "target": self.target, "owner": self.owner,
            "launchDate": self.launch_date, "reviewDate": self.review_date, "status": or(&self.status, "DRAFT"),
            "tasks": self.tasks.iter().map(|t| serde_json::json!({ "id": t.id, "title": t.title, "owner": t.owner, "due": t.due,
                "channel": or(&t.channel, "WEBSITE"), "status": or(&t.status, "TODO"), "note": t.note })).collect::<Vec<_>>(),
            "result": self.result, "decision": or(&self.decision, "UNDECIDED"), "learning": self.learning, "nextMove": self.next_move,
            "distribution": { "primaryChannel": self.channel, "rationale": self.rationale, "motion": or(&self.motion, "UNSPECIFIED"),
                "funnelStage": or(&self.funnel_stage, "UNSPECIFIED"), "destination": self.destination, "cadence": self.cadence,
                "budget": self.budget, "trackingPlan": self.tracking_plan, "conversionEvent": self.conversion_event },
        })
    }
}

impl Client {
    /// Saves a campaign's brief at the revision it was read at; a newer one on
    /// the server is refused (409), as is a brief not ready for its stage (422).
    pub fn save_campaign(&self, business: &str, c: &Campaign) -> ApiResult<Campaign> {
        let v: Value = self.post(&format!("/api/businesses/{}/campaigns", enc(business)), serde_json::json!({ "id": c.id, "revision": c.revision, "brief": c.brief_json() }))?;
        Ok(campaign(v.get("campaign").unwrap_or(&Value::Null)))
    }
}

/// Where a chat's agent routes live: a business's, or `/api/agent` for a
/// general chat (an empty business id).
pub fn agent_base(business: &str) -> String {
    if business.is_empty() { "/api/agent".into() } else { format!("/api/businesses/{}/agent", enc(business)) }
}

/// Percent-encodes a path or query component.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    let pair = header.split(';').next()?.trim();
    let (k, v) = pair.split_once('=')?;
    (k.trim() == name).then(|| v.trim())
}

fn session_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/OpenRecord/session"))
}

/// A server address as typed, made into the base URL the client calls: HTTPS,
/// or plain HTTP only for a server on this Mac. A bare host gets the scheme
/// that fits it. Credentials, paths, queries and fragments are refused, so the
/// session cookie only ever goes to the host the person named.
pub fn server_url(typed: &str) -> Result<String, String> {
    let t = typed.trim().trim_end_matches('/');
    if t.is_empty() {
        return Err("Enter the server's address, such as app.example.com.".into());
    }
    let local = |host: &str| matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    let (scheme, rest) = match t.split_once("://") {
        Some((s, r)) => (s.to_lowercase(), r),
        None => (if local(t.split(':').next().unwrap_or(t)) { "http".into() } else { "https".to_string() }, t),
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ', '\\']) {
        return Err("Use only the server's address, such as app.example.com.".into());
    }
    let host = match rest.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        Some(_) if !rest.starts_with('[') => return Err("That port is not a number.".into()),
        _ => rest,
    };
    match scheme.as_str() {
        "https" => Ok(format!("https://{rest}")),
        "http" if local(host) => Ok(format!("http://{rest}")),
        "http" => Err("A server that is not on this Mac must use https.".into()),
        _ => Err("The address must start with https://.".into()),
    }
}

/// Forgets the saved session, as when the app is pointed at another server.
pub fn forget_saved_session() {
    save_session(None);
}

fn load_session() -> Option<String> {
    if std::env::var_os("OPENRECORD_NO_SESSION").is_some() {
        return None;
    }
    let s = std::fs::read_to_string(session_path()?).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn save_session(value: Option<&str>) {
    if std::env::var_os("OPENRECORD_NO_SESSION").is_some() {
        return;
    }
    let Some(path) = session_path() else { return };
    match value {
        Some(v) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if std::fs::write(&path, v).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A random v4 UUID for request and conversation ids, from the OS's entropy.
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).is_ok();
    if !ok {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b = (t ^ (std::process::id() as u128) << 64).to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_campaign_brief_as_the_list_nests_it() {
        let c = campaign(&serde_json::json!({
            "id": "c1", "revision": 3, "updated_at": "2026-11-10T08:00:00Z", "created_by_actor": "ASSISTANT",
            "brief": { "title": "Pricing guide", "status": "ACTIVE", "goal": "More trials", "audience": "", "owner": "Maya",
                "launchDate": "2026-11-01", "reviewDate": "2026-11-20", "decision": "UNDECIDED",
                "tasks": [{ "id": "t1", "title": "Publish", "owner": "Maya", "due": "2026-11-02", "channel": "WEBSITE", "status": "DONE" },
                          { "id": "t2", "title": "Email", "owner": "", "due": "", "channel": "EMAIL", "status": "BLOCKED" }],
                "distribution": { "primaryChannel": "Website", "funnelStage": "CONVERSION", "motion": "OWNED", "budget": "$500" } }
        }));
        assert_eq!((c.title.as_str(), c.status.as_str(), c.revision, c.updated_at.as_deref()), ("Pricing guide", "ACTIVE", 3, Some("2026-11-10T08:00:00Z")));
        assert_eq!((c.funnel_stage.as_str(), c.budget.as_str(), c.done()), ("CONVERSION", "$500", (1, 2)));
        let b = c.blockers();
        assert!(b.contains(&"Choose an audience".to_string()));
        assert!(b.contains(&"Email: assign an owner and due date".to_string()));
        assert!(b.contains(&"Email: blocked".to_string()));
        assert!(c.review_due("2026-11-20") && !c.review_due("2026-11-19"));
    }

    #[test]
    fn reads_the_session_cookie() {
        assert_eq!(cookie_value("or_session=abc; Path=/; HttpOnly", "or_session"), Some("abc"));
        assert_eq!(cookie_value("other=1; Path=/", "or_session"), None);
    }

    #[test]
    fn counts_accept_strings_and_numbers() {
        let o: Overview = serde_json::from_value(json!({ "completed": "6", "unreviewed": 0, "needs_attention": "4" })).unwrap();
        assert_eq!((o.completed, o.unreviewed, o.needs_attention), (6, 0, 4));
    }

    #[test]
    fn uuids_are_v4() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
    }

}

/// Against a running dev API with the demo seed:
/// `OPENRECORD_NO_SESSION=1 cargo test -- --ignored live_api`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_api_reads_everything_the_app_shows() {
        let base = std::env::var("OPENRECORD_API_URL").unwrap_or_else(|_| "http://localhost:3001".into());
        let c = Client::new(base);
        c.signin("demo@northstar.test", "password123").expect("signin");
        c.me().expect("me");
        let businesses = c.businesses().expect("businesses");
        assert!(!businesses.is_empty());
        let b = &businesses[0].id;
        let overview = c.overview(b).expect("overview");
        let issues = c.issues(b).expect("issues");
        let channels = c.channels(b).expect("channels");
        let campaigns = c.campaigns(b).expect("campaigns");
        for i in issues.iter().take(5) {
            let (d, complete) = c.answer(b, &i.claim_id).expect("answer detail");
            assert!(complete, "facts and actions for {}", i.claim_id);
            eprintln!("answer {}: state {}, verdict {:?}, {} linked facts, {} sources, {} active facts, {} actions", i.claim_id, d.issue.state, d.issue.verdict, d.issue.facts.len(), d.issue.citation_evidence.len(), d.facts.len(), d.actions.len());
        }
        let books = c.playbooks(Some(b)).expect("playbooks");
        assert!(books.iter().any(|p| p.built_in), "built-in playbooks");
        eprintln!("playbooks: {:?}", books.iter().map(|p| p.name.as_str()).collect::<Vec<_>>());
        let f = c.followups(b).expect("follow-ups");
        eprintln!("follow-ups: {:?}, {} reviews", f.policy, f.wakes.len());
        let decisions = c.decisions().expect("decisions");
        let chats = c.chats().expect("chats");
        for days in crate::insights::PERIODS {
            let i = c.insights(b, days).expect("insights");
            assert!(i.analytics.is_ok(), "analytics for {days} days: {:?}", i.analytics);
            if days == 30 {
                eprintln!("insights: analytics {:?}, goal {:?}, {} initiatives, health {:?}, search {:?}", i.analytics.as_ref().map(|a| (a.checks, a.daily.len())), i.goal.as_ref().map(Option::is_some), i.initiatives.len(), i.health, i.search);
            }
        }
        eprintln!(
            "{} businesses, overview {overview:?}, {} issues, {} channels, {} campaigns, {} decisions, {} chats",
            businesses.len(), issues.len(), channels.len(), campaigns.len(), decisions.len(), chats.len()
        );
        if let Some(chat) = chats.iter().find(|ch| ch.business_id.is_some()) {
            let conv = c.conversation(chat.business_id.as_deref().unwrap(), Some(&chat.id)).expect("conversation").expect("exists");
            eprintln!("chat {:?}: {} messages, revision {}", conv.title, conv.messages.len(), conv.revision);
        }
        // Every chat's messages decode with their steps, sources and decisions.
        let mut parts = (0, 0, 0, 0);
        for chat in chats.iter().filter(|ch| ch.business_id.is_some()).take(10) {
            let conv = c.conversation(chat.business_id.as_deref().unwrap(), Some(&chat.id)).expect("conversation");
            for m in conv.iter().flat_map(|cv| cv.messages.iter()) {
                parts = (parts.0 + m.activity.len(), parts.1 + m.citations.len(), parts.2 + m.decisions.len(), parts.3 + usize::from(m.inference.is_some()));
            }
        }
        eprintln!("messages: {} steps, {} sources, {} decisions, {} with a model", parts.0, parts.1, parts.2, parts.3);
        if let Some(chat) = chats.iter().find(|ch| ch.business_id.is_some()) {
            let shares = c.shares(chat.business_id.as_deref().unwrap(), &chat.id).expect("shares");
            eprintln!("shares for {}: {}", chat.id, shares.len());
        }
        eprintln!("archived chats: {}", c.archived_chats().expect("archived chats").len());
        let me = c.identity().expect("identity");
        assert!(!me.account_id.is_empty());
        let notes = c.memory(b).expect("memory");
        let cat = c.providers().expect("providers");
        eprintln!(
            "settings: {} memory notes, {} computers, providers {:?}",
            notes.len(),
            cat.bridges.len(),
            cat.instances.iter().map(|i| (i.name.as_str(), i.status(), i.model_count())).collect::<Vec<_>>()
        );
        let models = c.catalog().expect("catalog");
        eprintln!("models: {:?}", models.iter().map(|m| (&m.value, &m.name, &m.brand)).collect::<Vec<_>>());
        // An unknown request has an empty journal, not an error.
        let events = c.progress(&uuid(), 0);
        eprintln!("progress for an unknown request: {:?}", events.as_ref().map(Vec::len));
        c.signout().expect("signout");
        assert_eq!(c.me(), Err(ApiError::Unauthorized));
    }

    #[test]
    #[ignore]
    fn live_api_reattaches_and_stops_requests() {
        let base = std::env::var("OPENRECORD_API_URL").unwrap_or_else(|_| "http://localhost:3001".into());
        let c = Client::new(base);
        c.signin("demo@northstar.test", "password123").expect("signin");
        // A reopened chat asks for a turn still in flight; most have none.
        for chat in c.chats().expect("chats").iter().take(20) {
            if let Some(p) = c.pending_request(&chat.id).expect("pending request") {
                eprintln!("chat {} has request {} in flight or failed", chat.id, p.request_id);
            }
        }
        // Stopping a request that is not this person's is refused, never applied elsewhere.
        let r = c.cancel_request(&uuid());
        assert!(matches!(r, Err(ApiError::Status(404, _))), "cancel of an unknown request: {r:?}");
        c.signout().expect("signout");
    }
}

#[cfg(test)]
mod server_tests {
    use super::server_url;

    #[test]
    fn a_server_address_is_https_unless_it_is_this_mac() {
        assert_eq!(server_url("app.example.com"), Ok("https://app.example.com".into()));
        assert_eq!(server_url(" https://app.example.com/ "), Ok("https://app.example.com".into()));
        assert_eq!(server_url("localhost:3001"), Ok("http://localhost:3001".into()));
        assert_eq!(server_url("http://127.0.0.1:3001"), Ok("http://127.0.0.1:3001".into()));
        assert!(server_url("http://app.example.com").is_err());
        assert!(server_url("ftp://app.example.com").is_err());
        assert!(server_url("https://user:pass@app.example.com").is_err());
        assert!(server_url("https://app.example.com/path").is_err());
        assert!(server_url("app.example.com:port").is_err());
        assert!(server_url("").is_err());
    }
}
