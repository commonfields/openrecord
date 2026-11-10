//! What Settings reads and changes on the server: the signed-in identity,
//! what the agent remembers about a business (`BusinessMemory`), and the
//! agent's provider connections (`lib/harness.ts`).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiResult, Client, enc};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub user_id: String,
    pub account_id: String,
}

/// A note the agent keeps about one business across chats.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created_at: String,
}

pub const NOTE_KINDS: [(&str, &str); 5] = [("PREFERENCE", "Preference"), ("DECISION", "Decision"), ("LESSON", "Lesson"), ("AVOID", "Avoid"), ("CONTEXT", "Context")];

pub fn kind_label(kind: &str) -> &'static str {
    NOTE_KINDS.iter().find(|k| k.0 == kind).map(|k| k.1).unwrap_or("Note")
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// One provider on a connected computer.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub bridge_id: String,
    #[serde(default)]
    pub local_id: String,
    pub driver: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub auth: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub limit_resets_at: Option<String>,
    #[serde(default)]
    pub models: Vec<Model>,
    #[serde(default)]
    pub disabled_models: Vec<String>,
    #[serde(default)]
    pub models_truncated: bool,
}

impl Instance {
    pub fn model_on(&self, id: &str) -> bool {
        !self.disabled_models.iter().any(|m| m == id)
    }

    pub fn models_on(&self) -> usize {
        self.models.iter().filter(|m| self.model_on(&m.id)).count()
    }

    /// The web's `harnessStatusLabel`.
    pub fn status(&self) -> &'static str {
        if self.state == "offline" {
            "Bridge offline"
        } else if !self.installed {
            if self.driver == "cliproxy" { "Not running" } else { "Not installed" }
        } else if self.auth == "unauthenticated" {
            "Authentication failed"
        } else if self.state == "error" || self.state == "unavailable" {
            "Connection failed"
        } else if self.state == "usage_limited" {
            "Usage limit reached"
        } else if self.auth == "unknown" {
            "Authentication status unavailable"
        } else {
            "Connected"
        }
    }

    pub fn model_count(&self) -> String {
        let (on, all) = (self.models_on(), self.models.len());
        if on == all { format!("{all} model{}", if all == 1 { "" } else { "s" }) } else { format!("{on} of {all} models on") }
    }

    /// The command that signs this provider in on its computer.
    pub fn login_command(&self, managed: bool) -> String {
        if managed {
            match self.driver.as_str() {
                "codex" => "codex login",
                "claude" => "claude auth login",
                "opencode" => "opencode auth login",
                "cursor" => "cursor-agent login",
                _ => "cli-proxy-api -claude-login",
            }
            .into()
        } else if self.local_id.is_empty() {
            format!("node openrecord-bridge.mjs login --driver {}", self.driver)
        } else {
            format!("node openrecord-bridge.mjs login --instance {}", self.local_id)
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Bridge {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub managed: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Hosted {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct Catalog {
    #[serde(default)]
    pub bridges: Vec<Bridge>,
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub hosted: Option<Hosted>,
    #[serde(default)]
    pub local: bool,
}

impl Catalog {
    /// This computer first, then online computers, then the rest by name.
    pub fn machines(&self) -> Vec<&Bridge> {
        let mut b: Vec<&Bridge> = self.bridges.iter().collect();
        b.sort_by_key(|x| (!x.managed, !x.online, x.name.clone()));
        b
    }

    /// The providers shown under a computer, in the fixed driver order.
    pub fn found(&self, bridge: &str) -> Vec<&Instance> {
        let mut v: Vec<&Instance> =
            self.instances.iter().filter(|i| i.bridge_id == bridge && i.installed && (i.driver != "cliproxy" || i.state != "unavailable")).collect();
        v.sort_by_key(|i| crate::chat::DRIVERS.iter().position(|d| *d == i.driver).unwrap_or(9));
        v
    }

    pub fn missing(&self, bridge: &str) -> Vec<&Instance> {
        self.instances.iter().filter(|i| i.bridge_id == bridge && !i.installed && i.driver != "cliproxy").collect()
    }
}

/// A prompt for a coding agent on another computer to install and pair the bridge (`agentSetupPrompt`).
pub fn setup_prompt(code: &str, expires: &str, origin: &str) -> String {
    format!(
        "Set up the OpenRecord bridge on this computer so OpenRecord can use the AI subscriptions signed in here. Work step by step and tell me what you did.

1. Check that Node.js 24 or later is installed (node --version). If not, install it the usual way for this system (Homebrew, nvm, winget or the package manager).
2. Download the bridge:
   mkdir -p ~/.openrecord/bin && curl -fsSL {origin}/openrecord-bridge.mjs -o ~/.openrecord/bin/openrecord-bridge.mjs
3. Pair it. The code works once and expires at {expires}:
   node ~/.openrecord/bin/openrecord-bridge.mjs pair --server {origin} --code {code}
   It keeps running after it prints \"bridge running\". Stop it with Ctrl-C once you see that line.
4. Keep the bridge running in the background and after restarts, using the absolute path to node:
   - macOS: a LaunchAgent at ~/Library/LaunchAgents/io.openrecord.bridge.plist running \"node ~/.openrecord/bin/openrecord-bridge.mjs run\" with RunAtLoad and KeepAlive, loaded with launchctl.
   - Linux: a systemd user service with Restart=always, enabled and started.
   - Windows: a Task Scheduler task that runs at logon and restarts on failure.
   Then check it is running: node ~/.openrecord/bin/openrecord-bridge.mjs probe
5. Report which of these are installed and signed in: codex, claude, opencode, cursor-agent. Do not sign in for me or change their settings; tell me the sign-in command for any that are signed out.
6. If CLIProxyAPI is installed, check its config.yaml lists a key under access api-keys. The bridge starts it in the background and reads that key itself.

Never print, log or share the pairing code or ~/.openrecord/bridge.json. Do not set ANTHROPIC_API_KEY or OPENAI_API_KEY for the bridge: they would bill an API key instead of my subscriptions."
    )
}

/// A pairing code and when it stops working.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub code: String,
    pub expires_at: String,
}

impl Client {
    pub fn identity(&self) -> ApiResult<Identity> {
        self.get("/api/auth/me")
    }

    pub fn memory(&self, business: &str) -> ApiResult<Vec<Note>> {
        #[derive(Deserialize)]
        struct R {
            memories: Vec<Note>,
        }
        Ok(self.get::<R>(&format!("/api/businesses/{}/memory", enc(business)))?.memories)
    }

    pub fn remember(&self, business: &str, kind: &str, text: &str) -> ApiResult<()> {
        self.post::<Value>(&format!("/api/businesses/{}/memory", enc(business)), json!({ "kind": kind, "text": text })).map(|_| ())
    }

    pub fn forget(&self, business: &str, note: &str) -> ApiResult<()> {
        self.post::<Value>(&format!("/api/businesses/{}/memory/{}/forget", enc(business), enc(note)), json!({})).map(|_| ())
    }

    pub fn providers(&self) -> ApiResult<Catalog> {
        self.get("/api/agent/providers")
    }

    pub fn set_provider_enabled(&self, instance: &str, enabled: bool) -> ApiResult<()> {
        self.call::<Value>("PATCH", &format!("/api/agent/providers/{}", enc(instance)), Some(json!({ "enabled": enabled }))).map(|_| ())
    }

    pub fn refresh_provider(&self, instance: &str) -> ApiResult<()> {
        self.post::<Value>(&format!("/api/agent/providers/{}/refresh", enc(instance)), json!({})).map(|_| ())
    }

    pub fn choose_provider_model(&self, instance: &str, model: &str, enabled: bool) -> ApiResult<()> {
        self.call::<Value>("PATCH", &format!("/api/agent/providers/{}/models", enc(instance)), Some(json!({ "model": model, "enabled": enabled }))).map(|_| ())
    }

    pub fn revoke_bridge(&self, bridge: &str) -> ApiResult<()> {
        self.call::<Value>("DELETE", &format!("/api/agent/bridges/{}", enc(bridge)), None).map(|_| ())
    }

    pub fn pair(&self, name: &str) -> ApiResult<Pairing> {
        self.post("/api/agent/bridges/pairs", json!({ "name": name }))
    }

    /// Starts the bridge the server runs on its own computer; the status it reports.
    pub fn start_local_bridge(&self) -> ApiResult<String> {
        let v: Value = self.post("/api/agent/bridges/local", json!({ "enabled": true }))?;
        Ok(v.get("status").and_then(Value::as_str).unwrap_or("").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_catalog() {
        let c: Catalog = serde_json::from_value(json!({
            "bridges": [{ "id": "b2", "name": "Studio", "online": false }, { "id": "b1", "name": "This Mac", "online": true, "managed": true }],
            "instances": [
                { "id": "i1", "bridgeId": "b1", "localId": "l1", "driver": "claude", "name": "Claude Code", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
                  "models": [{ "id": "sonnet", "name": "Sonnet" }, { "id": "opus", "name": "Opus" }], "disabledModels": ["opus"], "checkedAt": "x" },
                { "id": "i2", "bridgeId": "b1", "driver": "cursor", "name": "Cursor", "installed": false, "models": [], "checkedAt": "x" }
            ],
            "hosted": { "provider": "gemini", "model": "gemini-3-flash" },
            "local": true
        }))
        .unwrap();
        assert_eq!(c.machines()[0].id, "b1");
        assert_eq!(c.found("b1").len(), 1);
        assert_eq!(c.missing("b1")[0].name, "Cursor");
        let i = &c.instances[0];
        assert_eq!((i.status(), i.model_count()), ("Connected", "1 of 2 models on".to_string()));
        assert_eq!(i.login_command(false), "node openrecord-bridge.mjs login --instance l1");
    }
}
