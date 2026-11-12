//! What the web's Channels page reads beside the inventory: the Search Console,
//! ads, Stripe and WordPress statuses, reduced to each row's state as
//! `routes/channels.tsx` derives it.

use serde_json::Value;

use crate::api::{ApiError, ApiResult, Client, enc};

/// A row's state (`State` in `routes/channels.tsx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Connected,
    Choose,
    Reconnect,
    Available,
    Unavailable,
}

/// One account row: its key (the web's row id), mark, name, purpose, what it is
/// connected to, and its state; `None` when its status could not load.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub key: &'static str,
    pub mark: &'static str,
    pub title: &'static str,
    pub purpose: &'static str,
    pub identity: Option<String>,
    pub state: Option<State>,
}

/// The three groups, each with its rows (`GROUPS`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Status {
    pub measure: Vec<Row>,
    pub ads: Vec<Row>,
    pub website: Vec<Row>,
}

impl Status {
    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.measure.iter().chain(self.ads.iter()).chain(self.website.iter())
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn list<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// "sc-domain:example.com" or "https://example.com/" as the site's name.
fn site(url: &str) -> String {
    url.trim_start_matches("sc-domain:").trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
}

/// A key-based account (Stripe, WordPress): connected, revoked, or not yet.
fn keyed(v: &Value, name: &str) -> (State, Option<String>) {
    let c = v.get("connection").filter(|c| !c.is_null());
    let status = c.map(|c| s(c, "status")).unwrap_or_default();
    let state = if !b(v, "configured") {
        State::Unavailable
    } else if status == "ACTIVE" {
        State::Connected
    } else if status == "REVOKED" {
        State::Reconnect
    } else {
        State::Available
    };
    (state, c.filter(|_| status == "ACTIVE").map(|c| s(c, name)).filter(|x| !x.is_empty()))
}

pub fn read_search_console(v: &Value) -> Row {
    let conns = list(v, "connections");
    let active = |c: &&Value| s(c, "status") == "ACTIVE";
    let readable = conns.iter().filter(active).filter(|c| b(c, "searchConsole")).count();
    let upgradable = conns.iter().find(|c| active(c) && !b(c, "searchConsole")).or_else(|| conns.iter().find(|c| s(c, "status") == "REAUTHORIZATION_REQUIRED"));
    let binding = v.get("binding").filter(|x| !x.is_null());
    let state = if !b(v, "configured") {
        State::Unavailable
    } else if binding.is_some() {
        State::Connected
    } else if readable > 0 {
        State::Choose
    } else if upgradable.is_some() {
        State::Reconnect
    } else {
        State::Available
    };
    Row {
        key: "google",
        mark: "search-console",
        title: "Google Search Console",
        purpose: "See which Google searches bring people to your site.",
        identity: binding.map(|x| site(&s(x, "siteUrl"))).or_else(|| upgradable.map(|c| s(c, "googleEmail"))),
        state: Some(state),
    }
}

pub fn read_ads(v: &Value) -> Vec<Row> {
    [
        ("google_business", "Google Business Profile", "Calls, directions, searches and reviews from your Google listing."),
        ("google_ads", "Google Ads", "What your Search, YouTube and Display ads cost and bring in."),
        ("meta", "Meta Ads", "What your Facebook and Instagram ads cost and bring in."),
    ]
    .into_iter()
    .map(|(provider, title, purpose)| {
        let configured = v.get("providers").and_then(|p| p.get(provider)).map(|p| b(p, "configured")).unwrap_or(false);
        let bound: Vec<String> = list(v, "bindings").iter().filter(|x| s(x, "provider") == provider).map(|x| s(x, "name")).collect();
        let sign_ins: Vec<&Value> = list(v, "connections").iter().filter(|c| s(c, "provider") == provider).collect();
        let state = if !configured {
            State::Unavailable
        } else if !bound.is_empty() {
            State::Connected
        } else if sign_ins.iter().any(|c| s(c, "status") == "ACTIVE") {
            State::Choose
        } else if sign_ins.iter().any(|c| s(c, "status") == "REAUTHORIZATION_REQUIRED") {
            State::Reconnect
        } else {
            State::Available
        };
        Row { key: provider, mark: provider, title, purpose, identity: (!bound.is_empty()).then(|| bound.join(", ")), state: Some(state) }
    })
    .collect()
}

impl Client {
    /// The four statuses; one that fails leaves its rows unknown, not the page.
    pub fn channel_status(&self, business: &str) -> ApiResult<Status> {
        let id = enc(business);
        let quiet = |r: ApiResult<Value>| match r {
            Err(ApiError::Unauthorized) => Err(ApiError::Unauthorized),
            other => Ok(other.ok()),
        };
        let unknown = |key: &'static str, mark: &'static str, title: &'static str, purpose: &'static str| Row { key, mark, title, purpose, identity: None, state: None };
        let sc = quiet(self.get(&format!("/api/growth/clients/{id}/search-console")))?;
        let ads = quiet(self.get(&format!("/api/ads/clients/{id}")))?;
        let revenue = quiet(self.get(&format!("/api/revenue/clients/{id}")))?;
        let wp = quiet(self.get(&format!("/api/businesses/{id}/wordpress")))?;
        let mut st = Status::default();
        st.measure.push(sc.as_ref().map(read_search_console).unwrap_or_else(|| unknown("google", "search-console", "Google Search Console", "See which Google searches bring people to your site.")));
        st.ads = ads.as_ref().map(read_ads).unwrap_or_else(|| vec![unknown("ads", "google_ads", "Ads and Google listing", "Ads and Google listing status could not load.")]);
        st.measure.push(match &revenue {
            Some(v) => {
                let (state, identity) = keyed(v, "displayName");
                Row { key: "revenue", mark: "stripe", title: "Stripe", purpose: "Revenue and new customers, so results are counted in money.", identity, state: Some(state) }
            }
            None => unknown("revenue", "stripe", "Stripe", "Revenue and new customers, so results are counted in money."),
        });
        st.website.push(match &wp {
            Some(v) => {
                let (state, identity) = keyed(v, "siteName");
                let identity = identity.or_else(|| v.get("connection").map(|c| site(&s(c, "siteUrl"))).filter(|x| !x.is_empty() && state == State::Connected));
                Row { key: "wordpress", mark: "wordpress", title: "WordPress", purpose: "Improve pages and publish posts, with your approval for each change.", identity, state: Some(state) }
            }
            None => unknown("wordpress", "wordpress", "WordPress", "Improve pages and publish posts, with your approval for each change."),
        });
        Ok(st)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derives_row_states_as_the_web_does() {
        let sc = read_search_console(&json!({ "configured": true, "binding": null, "connections": [{ "id": "c", "googleEmail": "a@b.c", "status": "ACTIVE", "searchConsole": true }] }));
        assert_eq!(sc.state, Some(State::Choose));
        let bound = read_search_console(&json!({ "configured": true, "binding": { "siteUrl": "sc-domain:x.com" }, "connections": [] }));
        assert_eq!((bound.state, bound.identity.as_deref()), (Some(State::Connected), Some("x.com")));
        let ads = read_ads(&json!({ "providers": { "google_business": { "configured": false }, "google_ads": { "configured": true }, "meta": { "configured": true } },
            "connections": [{ "provider": "meta", "status": "REAUTHORIZATION_REQUIRED" }], "bindings": [{ "provider": "google_ads", "name": "Acme" }] }));
        assert_eq!(ads.iter().map(|r| r.state).collect::<Vec<_>>(), vec![Some(State::Unavailable), Some(State::Connected), Some(State::Reconnect)]);
        assert_eq!(keyed(&json!({ "configured": true, "connection": { "status": "REVOKED" } }), "displayName").0, State::Reconnect);
    }
}
