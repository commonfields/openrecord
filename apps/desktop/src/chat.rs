//! The agent chat's data beyond plain text, as the web reads it
//! (`AgentMessage`, `AgentRunProgress` and the harness catalog in
//! `apps/web/app/lib/api.ts` and `lib/harness.ts`): what a run did, the
//! sources it used, the decisions and helpers it started, which model
//! answered, the live journal of a running turn, and the models to pick from.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiResult, Client, enc};

/// One step of a run: the model's reasoning, or a tool it ran.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Activity {
    Thought {
        #[serde(default)]
        text: String,
        #[serde(default)]
        ms: i64,
    },
    Tool {
        #[serde(default)]
        tool: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        failed: bool,
    },
}

/// A source the answer used: a web page or a record in the workspace.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Citation {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
}

impl Citation {
    /// The page's address when the source is on the web.
    pub fn url(&self) -> Option<&str> {
        let s = if self.id.starts_with("http") { self.id.as_str() } else { self.text.as_str() };
        (s.starts_with("https://") || s.starts_with("http://")).then_some(s)
    }
}

/// A proposal a reply saved, shown as an approval card under it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DecisionRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

impl DecisionRef {
    /// The inbox key of the same decision (`TYPE:id`).
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

/// A helper session a reply started or reports on.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TaskRef {
    pub id: String,
    #[serde(default, rename = "sessionId")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub model: Option<String>,
}

pub fn role_label(role: &str) -> &'static str {
    match role {
        "researcher" => "Research",
        "seo" => "Search",
        "aeo" => "AI answers",
        "content" => "Content",
        "analyst" => "Measurement",
        "reviewer" => "Review",
        "verifier" => "Fact-check",
        _ => "Helper",
    }
}

pub fn task_status(status: &str) -> &'static str {
    match status {
        "RUNNING" => "Working",
        "COMPLETED" => "Done",
        "FAILED" => "Stopped",
        "CANCELLED" => "Cancelled",
        _ => "Interrupted",
    }
}

/// How the run behind a reply ended, and the checks it could not make.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RunRef {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub gaps: Vec<String>,
}

/// Which provider and model answered.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Inference {
    #[serde(default)]
    pub provider: String,
    #[serde(default, rename = "requestedModel")]
    pub model: Option<String>,
}

/// Where a message came from when another session sent it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Origin {
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
}

impl Origin {
    pub fn text(&self) -> String {
        match self.kind.as_str() {
            "result" => format!("Result from \u{201c}{}\u{201d}", self.title.as_deref().unwrap_or("a helper")),
            "message" => "Follow-up from another session".into(),
            _ => "Task from the session that started this one".into(),
        }
    }
}

/// A text file sent with a message.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Attachment {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
}

impl Attachment {
    pub fn lines(&self) -> usize {
        self.text.split('\n').count()
    }
}

/// At most three files, 80,000 characters together (`AgentMessageRequest`).
pub const MAX_FILES: usize = 3;
pub const MAX_ATTACHMENT_CHARS: usize = 80_000;

/// Reads a file to attach: text only, within what is left of the limit.
pub fn read_attachment(path: &std::path::Path, used: usize) -> Result<Attachment, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let bytes = std::fs::read(path).map_err(|e| format!("{name} could not be read: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{name} isn't a text file. Attach text, Markdown, CSV or JSON."))?;
    if used + text.chars().count() > MAX_ATTACHMENT_CHARS {
        return Err(format!("{name} is too long. Files can be 80,000 characters together."));
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        _ => "text/plain",
    };
    Ok(Attachment { name, kind: kind.into(), text })
}

/// What one turn sends: the message, the model and any files.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Outgoing {
    pub message: String,
    pub selection: Option<Value>,
    pub attachments: Vec<Attachment>,
    /// How the person wants answers written (friendly when absent).
    pub style: Option<String>,
}

/// How much of the chat's memory the model was sent on a turn.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUse {
    #[serde(default)]
    pub history_chars: i64,
    #[serde(default)]
    pub budget_chars: i64,
    #[serde(default)]
    pub verbatim: i64,
    #[serde(default)]
    pub compacted: i64,
    #[serde(default)]
    pub omitted: i64,
}

impl ContextUse {
    pub fn percent(&self) -> i64 {
        if self.budget_chars <= 0 { 0 } else { (self.history_chars * 100 / self.budget_chars).min(100) }
    }
    pub fn note(&self) -> String {
        let p = self.percent();
        let older = self.compacted + self.omitted;
        let mut s = format!("Chat memory {p}% full. {} recent message{} go to the model in full", self.verbatim, if self.verbatim == 1 { "" } else { "s" });
        if older > 0 {
            s.push_str(&format!("; {older} older {} summarized to make room", if older == 1 { "one is" } else { "ones are" }));
        }
        s.push('.');
        if p >= 90 {
            s.push_str(" Start a new chat for a fresh topic.");
        }
        s
    }
}

/// A helper session's link to the session that started it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

// ---- Commands ---------------------------------------------------------------

/// The slash commands the composer offers (`COMMANDS` in `agent-commands.tsx`); each sends `/name`.
pub const COMMANDS: [(&str, &str); 9] = [
    ("marketing", "Find the marketing blocker and work on the next step"),
    ("setup", "Understand and configure this business"),
    ("status", "Current work, channels and blockers"),
    ("plan", "What to do next, most important first"),
    ("report", "What was done, verified and measured"),
    ("campaign", "Prepare and save a campaign from your goal"),
    ("campaign-status", "Campaign priorities, blockers and reviews due"),
    ("campaign-run", "Prepare campaign work; external actions need approval"),
    ("campaign-review", "Review available results and the next experiment"),
];

/// Commands matching what has been typed after "/".
pub fn command_matches(text: &str) -> Vec<(&'static str, &'static str)> {
    let t = text.trim();
    let Some(rest) = t.strip_prefix('/') else { return Vec::new() };
    if !rest.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Vec::new();
    }
    let rest = rest.to_lowercase();
    COMMANDS.iter().filter(|(k, _)| k.starts_with(&rest)).copied().collect()
}

/// The tool icon the web draws for a tool (`toolIcon` in `agent-trace.tsx`).
pub fn tool_icon(tool: &str) -> &'static rune::Icon {
    use crate::icons as i;
    let has = |k: &str| tool.contains(k);
    if tool == "search_web" {
        &i::SEARCH
    } else if tool == "audit_website" {
        &i::GAUGE
    } else if tool == "read_web_page" || tool == "read_web_pages" {
        &i::GLOBE
    } else if tool == "map_website" {
        &i::NETWORK
    } else if tool == "read_proposals" {
        &i::FILE_TEXT
    } else if ["session", "task", "delegate", "list_models"].iter().any(|k| has(k)) {
        &i::USERS
    } else if tool.starts_with("propose_") || tool.starts_with("draft_") || tool.starts_with("prepare_") {
        &i::PEN_LINE
    } else if has("question") {
        &i::MESSAGE_CIRCLE_QUESTION
    } else if ["acquisition", "referral", "search_performance", "competitor", "observation", "outcomes"].iter().any(|k| has(k)) {
        &i::CHART_LINE
    } else if ["goal", "opportunit", "diagnose"].iter().any(|k| has(k)) {
        &i::TARGET
    } else if has("issue") {
        &i::LIST_CHECKS
    } else if ["truth", "representation", "scope", "record"].iter().any(|k| has(k)) {
        &i::FILE_TEXT
    } else {
        &i::WRENCH
    }
}

/// "12s", "1m 05s".
pub fn elapsed(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    let m = s / 60;
    if m == 0 { format!("{s}s") } else { format!("{m}m {:02}s", s % 60) }
}

// ---- A running turn ---------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Thinking,
    Working,
    Checking,
}

/// What a running turn is doing, folded from the run journal (`progressOf`).
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    /// The tool running now, as a present-tense label, and its name.
    pub current: Option<String>,
    pub current_tool: Option<String>,
    /// The model's reasoning in the step under way.
    pub thought: String,
    /// Finished steps, oldest first.
    pub trace: Vec<Activity>,
    /// The last journal sequence read.
    pub seq: i64,
}

impl Default for Progress {
    fn default() -> Self {
        Progress { phase: Phase::Thinking, current: None, current_tool: None, thought: String::new(), trace: Vec::new(), seq: 0 }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RunEvent {
    pub seq: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

impl Progress {
    pub fn apply(&mut self, events: &[RunEvent]) {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        for e in events {
            self.seq = self.seq.max(e.seq);
            let p = &e.payload;
            match e.kind.as_str() {
                "MODEL_REQUESTED" => {
                    self.phase = Phase::Thinking;
                    self.current = None;
                    self.current_tool = None;
                    self.thought.clear();
                }
                "MODEL_THINKING" => self.thought = s(p, "text"),
                "MODEL_STEP" => {
                    let thought = Some(s(p, "thought")).filter(|t| !t.is_empty()).unwrap_or_else(|| std::mem::take(&mut self.thought));
                    self.thought.clear();
                    if p.get("toolCalls").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                        self.phase = Phase::Working;
                    }
                    if !thought.is_empty() {
                        self.trace.push(Activity::Thought { text: thought, ms: p.get("elapsedMs").and_then(Value::as_i64).unwrap_or(0) });
                    }
                }
                "TOOL_STARTED" => {
                    self.phase = Phase::Working;
                    self.current = Some(Some(s(p, "label")).filter(|l| !l.is_empty()).unwrap_or_else(|| "Working".into()));
                    self.current_tool = Some(s(p, "tool")).filter(|t| !t.is_empty());
                }
                "TOOL_COMPLETED" | "TOOL_FAILED" => {
                    self.current = None;
                    self.current_tool = None;
                    self.trace.push(Activity::Tool { tool: s(p, "tool"), text: s(p, "summary"), failed: e.kind == "TOOL_FAILED" });
                }
                "VERIFICATION" if p.get("action").and_then(Value::as_str) == Some("REMINDED") => {
                    self.phase = Phase::Checking;
                    self.current = None;
                    self.current_tool = None;
                }
                _ => {}
            }
        }
    }

    /// The line under way: the tool running, the check, or the last line of reasoning.
    pub fn live(&self) -> String {
        match self.phase {
            Phase::Working => self.current.clone().unwrap_or_else(|| "Working".into()),
            Phase::Checking => "Checking the answer is complete".into(),
            Phase::Thinking => self.thought.trim().lines().filter(|l| !l.trim().is_empty()).last().map(|l| l.trim().to_string()).unwrap_or_else(|| "Thinking".into()),
        }
    }

    pub fn working(&self) -> bool {
        self.phase != Phase::Thinking || self.trace.iter().any(|a| matches!(a, Activity::Tool { .. }))
    }
}

// ---- Models -----------------------------------------------------------------

/// A model the composer offers: the hosted default, or one on a connected provider.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelOption {
    /// "hosted", or "instanceId:modelId".
    pub value: String,
    pub name: String,
    /// The provider it runs on ("hosted" or the harness driver), for the filter.
    pub provider: String,
    /// The connection's name, under the model.
    pub instance: Option<String>,
    /// The brand whose logo it shows.
    pub brand: String,
}

impl ModelOption {
    /// The request's `selection`, or `None` for the hosted default.
    pub fn selection(&self) -> Option<Value> {
        let (instance, model) = self.value.split_once(':')?;
        Some(json!({ "instanceId": instance, "model": model }))
    }
}

pub const DRIVERS: [&str; 5] = ["codex", "claude", "opencode", "cursor", "cliproxy"];

pub fn driver_name(d: &str) -> &'static str {
    match d {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "opencode" => "OpenCode",
        "cursor" => "Cursor",
        "cliproxy" => "CLIProxyAPI",
        _ => "OpenRecord hosted",
    }
}

/// Hosted first, then each ready provider's enabled models in the fixed driver order (`modelOptions`).
pub fn model_options(catalog: &Value) -> Vec<ModelOption> {
    let mut out = Vec::new();
    if let Some(h) = catalog.get("hosted").filter(|h| !h.is_null()) {
        let (provider, model) = (h.get("provider").and_then(Value::as_str).unwrap_or(""), h.get("model").and_then(Value::as_str).unwrap_or(""));
        out.push(ModelOption { value: "hosted".into(), name: model.into(), provider: "hosted".into(), instance: None, brand: crate::brands::model_brand(model, provider) });
    }
    let instances = catalog.get("instances").and_then(Value::as_array).cloned().unwrap_or_default();
    for driver in DRIVERS {
        for i in instances.iter().filter(|i| i.get("driver").and_then(Value::as_str) == Some(driver)) {
            let b = |k: &str| i.get(k).and_then(Value::as_bool).unwrap_or(false);
            let st = |k: &str| i.get(k).and_then(Value::as_str).unwrap_or("");
            if !(b("enabled") && b("installed") && st("auth") != "unauthenticated" && st("state") == "ready") {
                continue;
            }
            let off: Vec<&str> = i.get("disabledModels").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            for m in i.get("models").and_then(Value::as_array).into_iter().flatten() {
                let id = m.get("id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() || off.contains(&id) {
                    continue;
                }
                out.push(ModelOption {
                    value: format!("{}:{id}", st("id")),
                    name: m.get("name").and_then(Value::as_str).unwrap_or(id).into(),
                    provider: driver.into(),
                    instance: Some(st("name").into()),
                    brand: crate::brands::model_brand(id, driver),
                });
            }
        }
    }
    out
}

/// The model chosen last, kept between launches as the web keeps it in the browser.
pub fn stored_model() -> Option<String> {
    if rune::tooling::headless_run().is_some() {
        return None;
    }
    std::fs::read_to_string(model_path()?).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn store_model(value: &str) {
    if let Some(p) = model_path() {
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
        let _ = std::fs::write(p, value);
    }
}

fn model_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Application Support/OpenRecord/agent-model"))
}

// ---- Calls ------------------------------------------------------------------

impl Client {
    /// The live journal of the run answering a request, after `after`.
    pub fn progress(&self, request: &str, after: i64) -> ApiResult<Vec<RunEvent>> {
        #[derive(Deserialize)]
        struct R {
            #[serde(default)]
            events: Vec<RunEvent>,
        }
        Ok(self.get::<R>(&format!("/api/agent/runs/progress?requestId={}&after={after}", enc(request)))?.events)
    }

    /// Stops the turn in flight; the request settles on its own after this.
    pub fn cancel(&self, business: &str, conversation: &str) -> ApiResult<()> {
        self.post::<Value>(&format!("/api/businesses/{}/agent/cancel", enc(business)), json!({ "conversationId": conversation })).map(|_| ())
    }

    /// Archives a chat the person is done with, or brings it back.
    pub fn archive(&self, conversation: &str, archived: bool) -> ApiResult<()> {
        self.post::<Value>(&format!("/api/agent/conversations/{}/archive", enc(conversation)), json!({ "archived": archived })).map(|_| ())
    }

    pub fn archived_chats(&self) -> ApiResult<Vec<crate::api::ChatSummary>> {
        #[derive(Deserialize)]
        struct R {
            conversations: Vec<crate::api::ChatSummary>,
        }
        Ok(self.get::<R>("/api/agent/conversations?archived=1")?.conversations.into_iter().filter(|c| c.parent_session_id.is_none()).collect())
    }

    pub fn catalog(&self) -> ApiResult<Vec<ModelOption>> {
        Ok(model_options(&self.get::<Value>("/api/agent/providers")?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_match_what_is_typed() {
        assert_eq!(command_matches("/camp").len(), 4);
        assert_eq!(command_matches("/").len(), 9);
        assert!(command_matches("/plan this").is_empty());
        assert!(command_matches("plan").is_empty());
    }

    #[test]
    fn memory_note() {
        let c = ContextUse { history_chars: 95, budget_chars: 100, verbatim: 1, compacted: 3, omitted: 0 };
        assert_eq!(c.note(), "Chat memory 95% full. 1 recent message go to the model in full; 3 older ones are summarized to make room. Start a new chat for a fresh topic.");
    }

    #[test]
    fn progress_folds_the_journal() {
        let ev = |seq, kind: &str, payload: Value| RunEvent { seq, kind: kind.into(), payload };
        let mut p = Progress::default();
        p.apply(&[
            ev(1, "MODEL_REQUESTED", json!({})),
            ev(2, "MODEL_THINKING", json!({ "text": "Look at the goal\nthen the answers" })),
        ]);
        assert_eq!(p.live(), "then the answers");
        p.apply(&[ev(3, "MODEL_STEP", json!({ "toolCalls": [{}], "elapsedMs": 900 })), ev(4, "TOOL_STARTED", json!({ "tool": "search_web", "label": "Searching the web" }))]);
        assert_eq!((p.phase, p.live(), p.trace.len()), (Phase::Working, "Searching the web".to_string(), 1));
        p.apply(&[ev(5, "TOOL_FAILED", json!({ "tool": "search_web", "summary": "Search failed" }))]);
        assert_eq!(p.trace[1], Activity::Tool { tool: "search_web".into(), text: "Search failed".into(), failed: true });
        assert_eq!(p.seq, 5);
    }

    #[test]
    fn options_list_ready_models() {
        let catalog = json!({
            "hosted": { "provider": "gemini", "model": "gemini-3-flash" },
            "instances": [
                { "id": "i1", "driver": "claude", "name": "This Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
                  "models": [{ "id": "claude-sonnet-5-5", "name": "Sonnet 5.5" }, { "id": "claude-haiku-5-5", "name": "Haiku 5.5" }], "disabledModels": ["claude-haiku-5-5"] },
                { "id": "i2", "driver": "codex", "name": "Off", "enabled": false, "installed": true, "auth": "authenticated", "state": "ready", "models": [{ "id": "gpt-5", "name": "GPT-5" }] }
            ]
        });
        let o = model_options(&catalog);
        assert_eq!(o.iter().map(|x| x.value.as_str()).collect::<Vec<_>>(), ["hosted", "i1:claude-sonnet-5-5"]);
        assert_eq!(o[1].brand, "claude");
        assert_eq!(o[1].selection(), Some(json!({ "instanceId": "i1", "model": "claude-sonnet-5-5" })));
        assert_eq!(o[0].selection(), None);
    }

    #[test]
    fn reads_message_parts() {
        let m: crate::api::Message = serde_json::from_value(json!({
            "role": "agent", "text": "Done",
            "activity": [{ "kind": "thought", "text": "hm", "ms": 3 }, { "kind": "tool", "tool": "search_web", "text": "Searched" }],
            "citations": [{ "kind": "web", "id": "https://example.com/a", "text": "Example" }],
            "decisions": [{ "type": "GROWTH_OPPORTUNITY", "id": "g1" }],
            "run": { "id": "r", "status": "COMPLETED", "gaps": ["pricing"] },
            "inference": { "provider": "claude", "requestedModel": "claude-sonnet-5-5" },
            "durationMs": 12000
        }))
        .unwrap();
        assert_eq!(m.activity.len(), 2);
        assert_eq!(m.citations[0].url(), Some("https://example.com/a"));
        assert_eq!(m.decisions[0].key(), "GROWTH_OPPORTUNITY:g1");
        assert_eq!(m.run.as_ref().unwrap().gaps, ["pricing"]);
        assert_eq!(elapsed(m.duration_ms.unwrap()), "12s");
        assert_eq!(elapsed(65_000), "1m 05s");
    }
}
