//! Automatic follow-ups (`components/agent-followups.tsx`, `lib/agent-followups.ts`):
//! one server-confirmed policy per business and person, bound to one chat, that
//! lets the agent revisit saved investigations when a time or decision is ready.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiError, ApiResult, Client, enc};
use crate::chat::ModelOption;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Policy {
    Unconfigured,
    #[serde(rename_all = "camelCase")]
    Configured {
        enabled: bool,
        grant_id: String,
        conversation_id: String,
        #[serde(default)]
        selection: Option<Value>,
        provider: String,
        model: String,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub wake_ups_per24_hours: i64,
    pub model_steps: i64,
    pub tool_calls: i64,
    pub timeout_seconds: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub id: String,
    pub conversation_id: String,
    pub status: String,
    #[serde(default)]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Followups {
    pub policy: Policy,
    pub limits: Limits,
    #[serde(default)]
    pub wakes: Vec<Wake>,
}

/// Where follow-ups run, seen from one chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    Off,
    Here,
    Elsewhere,
}

impl Followups {
    pub fn location(&self, conversation: &str) -> Location {
        match &self.policy {
            Policy::Configured { enabled: true, conversation_id, .. } if conversation_id == conversation => Location::Here,
            Policy::Configured { enabled: true, .. } => Location::Elsewhere,
            _ => Location::Off,
        }
    }

    pub fn grant(&self) -> Option<&str> {
        match &self.policy {
            Policy::Configured { grant_id, .. } => Some(grant_id),
            Policy::Unconfigured => None,
        }
    }

    /// The policy already runs on this model.
    pub fn matches(&self, m: &Model) -> bool {
        match &self.policy {
            Policy::Configured { provider, model, selection, .. } => provider == &m.provider && model == &m.model && selection.as_ref().map(strip) == m.selection.as_ref().map(strip),
            Policy::Unconfigured => false,
        }
    }
}

/// A selection compared by instance, model and reasoning effort.
fn strip(v: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    (s("instanceId"), s("model"), s("reasoningEffort"))
}

/// The model follow-ups would run on: the composer's choice.
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    pub selection: Option<Value>,
    pub provider: String,
    pub model: String,
    pub label: String,
}

impl Model {
    /// A loading or missing choice never authorizes hosted usage silently.
    pub fn of(o: &ModelOption) -> Option<Model> {
        match o.value.split_once(':') {
            Some((_, model)) => Some(Model { selection: o.selection(), provider: o.provider.clone(), model: model.to_string(), label: format!("{}, {}", crate::chat::driver_name(&o.provider), o.name) }),
            None if !o.vendor.is_empty() => Some(Model { selection: None, provider: o.vendor.clone(), model: o.name.clone(), label: format!("{}, {}", o.vendor, o.name) }),
            None => None,
        }
    }
}

pub fn status_label(s: &str) -> &'static str {
    match s {
        "RUNNING" => "Reviewing",
        "COMPLETED" => "Update saved",
        "FAILED" => "Review failed",
        "CANCELLED" => "Stopped",
        _ => "Interrupted, not retried",
    }
}

pub fn error_message(e: &ApiError) -> String {
    match e {
        ApiError::Status(409, _) => "The settings or model changed. Refresh status before confirming again.".into(),
        ApiError::Status(401 | 403, _) => "You don't have permission to change these follow-ups. Sign in again or contact your workspace owner.".into(),
        ApiError::Status(404, _) => "This business or chat is no longer available.".into(),
        _ => "Follow-ups are unavailable. The change could not be confirmed. Refresh status before trying again.".into(),
    }
}

fn path(business: &str) -> String {
    format!("/api/businesses/{}/agent/follow-ups", enc(business))
}

impl Client {
    pub fn followups(&self, business: &str) -> ApiResult<Followups> {
        self.get(&path(business))
    }

    /// Turns follow-ups on in a chat on a model (`Some`), or pauses them.
    pub fn configure_followups(&self, business: &str, enable: Option<(&str, Option<&str>, &Model)>) -> ApiResult<Followups> {
        let body = match enable {
            Some((conversation, grant, m)) => json!({
                "enabled": true,
                "requestId": crate::api::uuid(),
                "expectedGrantId": grant,
                "conversationId": conversation,
                "selection": m.selection,
                "expectedProvider": m.provider,
                "expectedModel": m.model,
            }),
            None => json!({ "enabled": false }),
        };
        self.call("PUT", &path(business), Some(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_policies() {
        let off: Followups = serde_json::from_value(json!({ "policy": { "kind": "unconfigured" }, "limits": { "wakeUpsPer24Hours": 1, "modelSteps": 3, "toolCalls": 4, "timeoutSeconds": 120, "readOnly": true }, "wakes": [] })).unwrap();
        assert_eq!(off.location("c1"), Location::Off);
        let on: Followups = serde_json::from_value(json!({
            "policy": { "kind": "configured", "enabled": true, "grantId": "g", "conversationId": "c1", "selection": { "instanceId": "i1", "model": "m" }, "provider": "claude", "model": "m", "updatedAt": "x" },
            "limits": { "wakeUpsPer24Hours": 1, "modelSteps": 3, "toolCalls": 4, "timeoutSeconds": 120, "readOnly": true },
            "wakes": [{ "id": "w", "noteId": "n", "conversationId": "c1", "status": "COMPLETED", "startedAt": "2026-11-10T10:00:00Z", "finishedAt": null }]
        }))
        .unwrap();
        assert_eq!(on.location("c1"), Location::Here);
        assert_eq!(on.location("c2"), Location::Elsewhere);
        let m = Model { selection: Some(json!({ "instanceId": "i1", "model": "m" })), provider: "claude".into(), model: "m".into(), label: String::new() };
        assert!(on.matches(&m));
        assert!(!on.matches(&Model { model: "other".into(), ..m }));
    }
}
