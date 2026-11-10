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

/// A campaign as the list returns it. Kept loose: the desktop list shows its
/// name, stage and goal and leaves the rest to the web view.
#[derive(Debug, Clone, PartialEq)]
pub struct Campaign {
    pub id: String,
    pub title: String,
    pub stage: String,
    pub goal: String,
    pub updated_at: Option<String>,
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
            Some(id) => format!("/api/businesses/{}/agent/conversation?conversationId={}", enc(business), enc(id)),
            None => format!("/api/businesses/{}/agent/conversation", enc(business)),
        };
        Ok(self.get::<R>(&path)?.conversation)
    }

    /// Starts a new, empty conversation for a business.
    pub fn new_conversation(&self, business: &str, id: &str) -> ApiResult<Conversation> {
        #[derive(Deserialize)]
        struct R {
            conversation: Conversation,
        }
        let path = format!("/api/businesses/{}/agent/conversation", enc(business));
        Ok(self.post::<R>(&path, json!({ "conversationId": id }))?.conversation)
    }

    /// Queues a turn and returns once the API has accepted it.
    pub fn send(&self, business: &str, conversation: &str, revision: i64, request_id: &str, out: &crate::chat::Outgoing) -> ApiResult<()> {
        let path = format!("/api/businesses/{}/agent/requests", enc(business));
        let mut body = json!({ "message": out.message, "requestId": request_id, "revision": revision, "conversationId": conversation });
        if let Some(sel) = &out.selection {
            body["selection"] = sel.clone();
        }
        if let Some(style) = &out.style {
            body["style"] = json!(style);
        }
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
    Campaign {
        id: first(v, &[&["id"]]),
        title: first(v, &[&["title"], &["name"], &["plan", "title"]]),
        stage: first(v, &[&["stage"], &["status"]]),
        goal: first(v, &[&["goal"], &["objective"], &["plan", "goal"]]),
        updated_at: s(v, &["updatedAt"]).or_else(|| s(v, &["createdAt"])),
    }
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
}
