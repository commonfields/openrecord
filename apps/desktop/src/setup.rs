//! Adding a business, as the web's `SetupStartForm` does it: the website and
//! the goal in one line ("acme.com, we want more booked appointments"), sent
//! to `/api/setup`.

use serde_json::Value;

use crate::api::{ApiError, ApiResult, Client};

/// "acme.com" as "https://acme.com/", or None when it is not a website.
pub fn normalize_website(raw: &str) -> Option<String> {
    let v = raw.trim().trim_end_matches([',', '.', ';', ':']);
    if v.is_empty() {
        return None;
    }
    let lower = v.to_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).unwrap_or(&lower);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let tld = host.rsplit('.').next().unwrap_or("");
    if !host.contains('.') || host.contains('@') || tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return None;
    }
    let scheme = if lower.starts_with("http://") { "http://" } else { "https://" };
    let path = &rest[host.len()..];
    Some(format!("{scheme}{host}{}", if path.is_empty() { "/" } else { path }))
}

/// The website and the goal from one line (`parseStart`).
pub fn parse_start(text: &str) -> (Option<String>, String) {
    let found = text.split(|c: char| c.is_whitespace() || c == ',').find_map(|w| normalize_website(w).map(|u| (w.to_string(), u)));
    let Some((raw, website)) = found else { return (None, text.split_whitespace().collect::<Vec<_>>().join(" ")) };
    let rest = text.replacen(&raw, " ", 1);
    let mut goal = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    loop {
        let before = goal.clone();
        goal = goal.trim_start_matches([',', '.', ';', ':', '-', '–']).trim().to_string();
        for lead in ["we want to ", "i want to ", "and ", "to "] {
            if goal.to_lowercase().starts_with(lead) {
                goal = goal[lead.len()..].trim().to_string();
            }
        }
        if goal == before {
            break;
        }
    }
    (Some(website), goal)
}

/// What a refused setup says (`setupError`).
pub fn setup_error(e: &ApiError) -> String {
    if let ApiError::Status(code, body) = e {
        let reason = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        return match reason.as_str() {
            "WebsiteInUse" => "Another business in this workspace already uses that website.".into(),
            "DiscoveryPending" => "Still reading the website. Try again in a moment.".into(),
            "SetupComplete" => "Setup is finished. Change the goal from the growth workspace.".into(),
            _ if *code == 422 => "Check the website address and try again.".into(),
            _ => "Something went wrong. Try again.".into(),
        };
    }
    "Something went wrong. Try again.".into()
}

impl Client {
    /// Starts setting up a business; its id comes back.
    pub fn start_setup(&self, website: &str, goal: &str, engagement: Option<&str>) -> ApiResult<String> {
        let mut body = serde_json::json!({ "websiteUrl": website, "goalStatement": if goal.is_empty() { Value::Null } else { Value::from(goal) }, "businessId": Value::Null });
        if let Some(e) = engagement {
            body["engagement"] = Value::from(e);
        }
        let v: Value = self.post("/api/setup", body)?;
        v.get("setup").and_then(|s| s.get("businessId")).and_then(Value::as_str).map(str::to_string).ok_or_else(|| ApiError::Decode("setup without a business".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_website_and_the_goal() {
        assert_eq!(parse_start("acme.com, we want more booked appointments"), (Some("https://acme.com/".into()), "we want more booked appointments".into()));
        assert_eq!(parse_start("We want to grow trials at https://northstar.test/pricing").0.as_deref(), Some("https://northstar.test/pricing"));
        assert_eq!(parse_start("more customers").0, None);
        assert_eq!(normalize_website("not a site"), None);
    }
}
