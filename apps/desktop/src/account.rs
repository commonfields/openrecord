//! The account menu's pages, read from the endpoints the web pages use:
//! Usage (`routes/usage.tsx`), Businesses (`routes/home.tsx`) and Clients and
//! products (`routes/clients.tsx`).

use serde_json::Value;

use crate::api::{ApiError, ApiResult, Client, Overview, enc};
use crate::insights::Verdicts;

/// Token and cost totals for one model.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ModelUse {
    pub provider: String,
    pub model: String,
    pub turns: f64,
    pub tokens_in: Option<f64>,
    pub tokens_out: Option<f64>,
    pub usd: Option<f64>,
    pub priced: bool,
}

/// What the account used over a period (`/api/usage`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Usage {
    pub days: u32,
    pub turns: f64,
    pub tool_calls: f64,
    pub model_steps: f64,
    pub tokens: Option<f64>,
    pub tokens_in: Option<f64>,
    pub tokens_out: Option<f64>,
    pub without_counts: f64,
    pub usd: Option<f64>,
    pub unpriced: f64,
    pub by_model: Vec<ModelUse>,
    /// (business, turns, tokens, tool calls)
    pub by_business: Vec<(String, f64, Option<f64>, f64)>,
    /// (date, turns)
    pub daily: Vec<(String, f64)>,
    pub research_calls: f64,
    pub research_usd: f64,
    /// (provider, calls, failed, paid calls, charged)
    pub research: Vec<(String, f64, f64, f64, f64)>,
    pub answers: f64,
    /// (provider, answers)
    pub checks: Vec<(String, f64)>,
    pub note: String,
}

fn f(v: &Value, k: &str) -> Option<f64> {
    match v.get(k)? {
        Value::Number(x) => x.as_f64(),
        Value::String(x) => x.parse().ok(),
        _ => None,
    }
}

fn z(v: &Value, k: &str) -> f64 {
    f(v, k).unwrap_or(0.0)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn list<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

impl Usage {
    pub fn read(v: &Value) -> Usage {
        let a = v.get("agent").cloned().unwrap_or(Value::Null);
        let r = v.get("research").cloned().unwrap_or(Value::Null);
        let c = v.get("checks").cloned().unwrap_or(Value::Null);
        Usage {
            days: f(v, "days").unwrap_or(30.0) as u32,
            turns: z(&a, "turns"),
            tool_calls: z(&a, "toolCalls"),
            model_steps: z(&a, "modelSteps"),
            tokens: f(&a, "totalTokens"),
            tokens_in: f(&a, "promptTokens"),
            tokens_out: f(&a, "outputTokens"),
            without_counts: z(&a, "turnsWithoutTokenCounts"),
            usd: f(&a, "estimatedUsd"),
            unpriced: z(&a, "unpricedTurns"),
            by_model: list(v, "byModel")
                .iter()
                .map(|m| ModelUse {
                    provider: s(m, "provider"),
                    model: s(m, "model"),
                    turns: z(m, "turns"),
                    tokens_in: f(m, "promptTokens"),
                    // Output and thinking together, as the web's "Tokens out".
                    tokens_out: match (f(m, "outputTokens"), f(m, "thoughtTokens")) {
                        (None, None) => None,
                        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
                    },
                    usd: f(m, "estimatedUsd"),
                    priced: m.get("priced").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect(),
            by_business: list(v, "byBusiness").iter().map(|b| (s(b, "name"), z(b, "turns"), f(b, "totalTokens"), z(b, "toolCalls"))).collect(),
            daily: list(v, "daily").iter().map(|d| (s(d, "date"), z(d, "turns"))).collect(),
            research_calls: z(&r, "calls"),
            research_usd: z(&r, "chargedUsd"),
            research: list(&r, "byProvider").iter().map(|p| (s(p, "provider"), z(p, "calls"), z(p, "failed"), z(p, "paidCalls"), z(p, "chargedUsd"))).collect(),
            answers: z(&c, "answers"),
            checks: list(&c, "byProvider").iter().map(|p| (s(p, "provider"), z(p, "answers"))).collect(),
            note: s(v, "note"),
        }
    }
}

/// One business on the Businesses page: its overview and 30 days of answers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Portfolio {
    pub id: String,
    pub name: String,
    pub overview: Option<Overview>,
    pub verdicts: Option<Verdicts>,
    /// Answers collected per day over the 30 days.
    pub per_day: Vec<f64>,
}

/// One client on the Clients page, with its marketing progress.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ClientRow {
    pub id: String,
    pub name: String,
    pub website: String,
    pub shared: bool,
    /// Whether the growth reads came back; a failed read stays unknown.
    pub known: bool,
    pub goal: Option<String>,
    pub metric: Option<String>,
    pub ideas: usize,
    pub approved: usize,
    pub verified: usize,
}

impl ClientRow {
    /// One line on where the client's marketing stands (`clientGrowthLine`).
    pub fn progress(&self) -> String {
        if !self.known {
            return "Progress could not load".into();
        }
        match (&self.goal, self.ideas) {
            (None, _) => "No marketing goal yet".into(),
            (Some(g), 0) => format!("Goal: {g}. No initiatives yet"),
            (Some(_), n) => format!(
                "{} of {n} initiatives approved{}",
                self.approved,
                if self.verified > 0 { format!(", {} verified changes", self.verified) } else { String::new() }
            ),
        }
    }
}

impl Client {
    pub fn usage(&self, days: u32) -> ApiResult<Usage> {
        Ok(Usage::read(&self.get::<Value>(&format!("/api/usage?days={days}"))?))
    }

    /// Each business's overview and 30 days of answer analytics, as the
    /// Businesses page reads them. One failed read leaves that business unknown.
    pub fn portfolio(&self, businesses: &[(String, String)]) -> ApiResult<Vec<Portfolio>> {
        let mut out = Vec::new();
        for (id, name) in businesses {
            let overview = match self.overview(id) {
                Err(ApiError::Unauthorized) => return Err(ApiError::Unauthorized),
                r => r.ok(),
            };
            let analytics = self.get::<Value>(&format!("/api/businesses/{}/analytics?days=30", enc(id))).ok();
            let a = analytics.as_ref().and_then(|v| v.get("analytics")).cloned().unwrap_or(Value::Null);
            let verdicts = a.get("current").map(|c| Verdicts { supported: z(c, "supported") as i64, wrong: z(c, "wrong") as i64, partial: z(c, "partial") as i64, unknown: z(c, "unknown") as i64, unreviewed: z(c, "unreviewed") as i64 });
            let per_day = list(&a, "daily").iter().map(|d| ["supported", "wrong", "partial", "unknown", "unreviewed"].iter().map(|k| z(d, k)).sum()).collect();
            out.push(Portfolio { id: id.clone(), name: name.clone(), overview, verdicts, per_day });
        }
        Ok(out)
    }

    /// The account's clients with their goal and initiatives (`useClientGrowth`).
    pub fn client_rows(&self) -> ApiResult<Vec<ClientRow>> {
        let v: Value = self.get("/api/record/clients")?;
        let mut out = Vec::new();
        for c in list(&v, "clients") {
            let id = s(c, "businessId");
            let b = enc(&id);
            let profile = self.get::<Value>(&format!("/api/growth/clients/{b}"));
            let ideas = self.get::<Value>(&format!("/api/growth/clients/{b}/opportunities"));
            let goal_of = |p: &Value| p.get("profile").and_then(|p| p.get("primaryGoal")).cloned();
            let (known, goal) = match &profile {
                Ok(p) => (true, goal_of(p)),
                Err(ApiError::Status(404, _)) => (true, None),
                Err(_) => (false, None),
            };
            let opps: Vec<Value> = ideas.as_ref().ok().map(|o| list(o, "opportunities").to_vec()).unwrap_or_default();
            out.push(ClientRow {
                id,
                name: s(c, "name"),
                website: s(c, "websiteUrl"),
                shared: c.get("hasActiveShare").and_then(Value::as_bool).unwrap_or(false),
                known: known && ideas.is_ok(),
                goal: goal.as_ref().map(|g| s(g, "statement")).filter(|x| !x.is_empty()),
                metric: goal.as_ref().and_then(|g| g.get("metricDefinition")).map(|m| s(m, "label")).filter(|x| !x.is_empty()),
                ideas: opps.len(),
                approved: opps.iter().filter(|o| matches!(o.get("status").and_then(Value::as_str), Some("APPROVED" | "REVIEWED"))).count(),
                verified: opps
                    .iter()
                    .flat_map(|o| list(o, "executions").to_vec())
                    .filter(|e| e.get("assurance").and_then(Value::as_str) == Some("SYSTEM_VERIFIED"))
                    .count(),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_usage() {
        let u = Usage::read(&json!({
            "days": 7,
            "agent": { "turns": 12, "promptTokens": 1000, "outputTokens": 200, "thoughtTokens": null, "totalTokens": 1200, "toolCalls": 30, "modelSteps": 40, "turnsWithoutTokenCounts": 1, "estimatedUsd": 0.42, "unpricedTurns": 0 },
            "byModel": [{ "provider": "anthropic", "model": "m", "turns": 12, "promptTokens": 1000, "outputTokens": 200, "thoughtTokens": 50, "totalTokens": 1250, "toolCalls": 3, "estimatedUsd": 0.42, "priced": true }],
            "byBusiness": [{ "businessId": null, "name": "General", "turns": 2, "totalTokens": null, "toolCalls": 0 }],
            "daily": [{ "date": "2026-11-10", "turns": 4, "totalTokens": 10 }],
            "research": { "calls": 3, "chargedUsd": 0.1, "byProvider": [{ "provider": "web", "calls": 3, "failed": 1, "paidCalls": 1, "chargedUsd": 0.1 }] },
            "checks": { "answers": 9, "byProvider": [{ "provider": "openai", "answers": 9 }] },
            "note": "Estimates."
        }));
        assert_eq!((u.days, u.turns, u.tokens, u.usd), (7, 12.0, Some(1200.0), Some(0.42)));
        assert_eq!(u.by_model[0].tokens_out, Some(250.0));
        assert_eq!(u.by_business[0].2, None);
        assert_eq!((u.research[0].2, u.checks[0].1), (1.0, 9.0));
    }

    #[test]
    fn words_a_clients_progress() {
        let mut c = ClientRow { known: true, ..Default::default() };
        assert_eq!(c.progress(), "No marketing goal yet");
        c.goal = Some("More trials".into());
        assert_eq!(c.progress(), "Goal: More trials. No initiatives yet");
        c.ideas = 4;
        c.approved = 2;
        c.verified = 1;
        assert_eq!(c.progress(), "2 of 4 initiatives approved, 1 verified changes");
    }
}
