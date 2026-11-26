//! Decisions waiting on a person, read from `/api/decisions` and put in the
//! web inbox's words (`apps/web/app/lib/decisions.ts` and the cards in
//! `agent-chat.tsx`, `setup-flow.tsx`, `wordpress.tsx`, `account-action.tsx`).
//! Each one knows the call that approves or declines it.

use serde_json::{Value, json};

/// What approving or declining a decision calls.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    Publication { version: i64, digest: String, destination: String, tested: bool, stale: bool, blocking: u64 },
    /// A proposed campaign review: approving records the verdict and the next experiment.
    Review,
    /// A proposed marketing strategy version: approving makes it the one every campaign follows.
    Strategy,
    /// A proposed initiative (`/api/growth/clients/:id/opportunities/:id/approve|cancel`).
    Growth { status: String, revision: i64 },
    /// A prepared WordPress change: approving publishes it.
    WordPress,
    /// A Google Business Profile or Google Ads change: approving carries it out.
    Account,
    /// A private draft the agent saved: accepting keeps it, nothing is sent.
    Draft,
    /// A measurement batch with a cost bound; approval is blocked without one.
    Acquisition { cost: Option<f64>, blocked: bool },
    /// One re-check, run on a measurement model the person picks.
    Check,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub label: String,
    /// What it is now, struck through, when the decision changes something.
    pub before: Option<String>,
    pub text: String,
}

/// The agent message that put a decision in the inbox (`agent` on `/api/decisions`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sender {
    pub provider: Option<String>,
    pub model: Option<String>,
    /// The chat's title.
    pub session: Option<String>,
    /// The reply as Markdown, with any ```chart, ```ui or ```mermaid blocks.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    /// `TYPE:id`, unique across kinds.
    pub key: String,
    pub id: String,
    pub kind: String,
    pub business_id: String,
    pub business_name: String,
    pub conversation_id: Option<String>,
    pub created_at: Option<String>,
    /// "Proposed work", "Website change", …
    pub label: String,
    pub title: String,
    pub summary: String,
    pub sections: Vec<Section>,
    /// A long draft or plan, shown in a scrolling block.
    pub body: Option<String>,
    pub artifact: Option<String>,
    /// What approving does, in a sentence.
    pub note: Option<String>,
    pub act: Act,
    pub approve: String,
    pub decline: String,
    /// The title the decision-feedback record keeps.
    pub feedback_title: String,
    pub feedback_kind: &'static str,
    pub agent: Option<Sender>,
}

impl Decision {
    /// Why approving is not possible here, if it isn't.
    pub fn blocked(&self, model: Option<&str>) -> Option<&'static str> {
        match &self.act {
            Act::Publication { stale: true, .. } => Some("The campaign or artifact changed. Ask the agent to prepare the current revision."),
            Act::Publication { blocking, .. } if *blocking > 0 => Some("The pre-launch checks found problems that must be fixed first. Ask the agent to fix them in a new version."),
            Act::Publication { tested: false, .. } => Some("Open the prelaunch test and submit a test inquiry, then refresh this decision."),
            Act::Acquisition { cost: None, .. } => Some("Approval is blocked until a measurement cost bound is configured and a new proposal is prepared."),
            Act::Acquisition { blocked: true, .. } => Some("The measurement plan is missing something it needs, so it can't run yet."),
            Act::Check if model.is_none() => Some("Choose the measurement model the re-check runs on."),
            _ => None,
        }
    }

    /// Whether one key may approve it: nothing goes live and nothing is paid for.
    pub fn quick_yes(&self) -> bool {
        matches!(self.act, Act::Growth { .. } | Act::Review | Act::Strategy | Act::Draft)
    }

    /// The approve call: method path and body.
    pub fn approve_call(&self, model: Option<&str>) -> (String, Value) {
        let b = crate::api::enc(&self.business_id);
        let id = crate::api::enc(&self.id);
        match &self.act {
            Act::Publication { version, digest, destination, .. } => (format!("/api/businesses/{b}/campaign-publications/{id}/approve"), json!({ "artifactVersion": version, "contentDigest": digest, "destination": destination })),
            Act::Review => (format!("/api/businesses/{b}/campaign-reviews/{id}/approve"), json!({})),
            Act::Strategy => (format!("/api/businesses/{b}/marketing-strategy/{id}/approve"), json!({})),
            Act::Growth { status, revision } => (
                format!("/api/growth/clients/{b}/opportunities/{id}/approve"),
                json!({ "expectedStatus": status, "expectedRevision": revision, "idempotencyKey": crate::api::uuid(), "reason": "Approved in OpenRecord" }),
            ),
            Act::WordPress => (format!("/api/businesses/{b}/wordpress/changes/{id}/approve"), json!({})),
            Act::Account => (format!("/api/businesses/{b}/account-actions/{id}/approve"), json!({})),
            Act::Draft => (format!("/api/businesses/{b}/agent/proposals/{id}/approve"), json!({ "draftOnly": true })),
            Act::Acquisition { cost, .. } => (
                format!("/api/businesses/{b}/agent/proposals/{id}/approve"),
                json!({ "approveAcquisition": true, "maxCostUsd": cost.unwrap_or(0.0) }),
            ),
            Act::Check => (
                format!("/api/businesses/{b}/agent/proposals/{id}/approve"),
                json!({ "provider": "9router", "requestedModel": model.unwrap_or_default() }),
            ),
        }
    }

    /// The decline call. A declined initiative keeps the reason on its record.
    pub fn decline_call(&self, reason: Option<&str>) -> (String, Value) {
        let b = crate::api::enc(&self.business_id);
        let id = crate::api::enc(&self.id);
        match &self.act {
            Act::Publication { .. } => (format!("/api/businesses/{b}/campaign-publications/{id}/reject"), json!({})),
            Act::Review => (format!("/api/businesses/{b}/campaign-reviews/{id}/reject"), json!({})),
            Act::Strategy => (format!("/api/businesses/{b}/marketing-strategy/{id}/reject"), json!({})),
            Act::Growth { status, revision } => {
                let why = match reason {
                    Some(r) => format!("Declined: {r}").chars().take(500).collect(),
                    None => "Declined in OpenRecord".to_string(),
                };
                (
                    format!("/api/growth/clients/{b}/opportunities/{id}/cancel"),
                    json!({ "expectedStatus": status, "expectedRevision": revision, "idempotencyKey": crate::api::uuid(), "reason": why }),
                )
            }
            Act::WordPress => (format!("/api/businesses/{b}/wordpress/changes/{id}/reject"), json!({})),
            Act::Account => (format!("/api/businesses/{b}/account-actions/{id}/reject"), json!({})),
            Act::Draft | Act::Acquisition { .. } | Act::Check => (format!("/api/businesses/{b}/agent/proposals/{id}/reject"), json!({})),
        }
    }

    /// What the person did, saved for the agent (`decision-reason.tsx`).
    pub fn feedback(&self, approved: bool, reason: Option<&str>) -> (String, Value) {
        let title: String = self.feedback_title.chars().take(300).collect();
        let mut body = json!({
            "kind": self.feedback_kind,
            "itemId": self.id,
            "verdict": if approved { "APPROVED" } else { "REJECTED" },
            "title": if title.is_empty() { "Untitled".to_string() } else { title },
        });
        if let Some(r) = reason.map(str::trim).filter(|r| !r.is_empty()) {
            body["reason"] = json!(r.chars().take(500).collect::<String>());
        }
        (format!("/api/businesses/{}/decision-feedback", crate::api::enc(&self.business_id)), body)
    }

    /// What the agent is asked to do once proposed work is approved: make the
    /// finished thing, not a plan, and hand it over in a form that can be applied.
    pub fn work_request(&self) -> Option<String> {
        if !matches!(self.act, Act::Growth { .. }) {
            return None;
        }
        let change = self.sections.iter().find(|x| x.label == "The change").map(|x| x.text.trim()).filter(|t| !t.is_empty());
        let mut r = format!("I approved \"{}\". Do it now.", self.title.trim());
        if let Some(c) = change {
            r.push_str(&format!(" The change: {c}"));
        }
        r.push_str(" Make the finished work in this turn with create_artifact: the actual page, copy or file, not a plan. If our site is connected, prepare the exact change for my approval. If it isn't, end with a handoff I can apply myself: where it goes and the exact text. Then say what to measure, and when to check it.");
        Some(r)
    }

    /// The sentence shown after a successful decision.
    pub fn done(&self, approved: bool) -> &'static str {
        match (&self.act, approved) {
            (Act::Publication { .. }, true) => "Published the approved campaign page.",
            (Act::Review, true) => "Recorded the campaign review.",
            (Act::Strategy, true) => "This is now the strategy every campaign follows.",
            (Act::WordPress, true) => "Published to WordPress.",
            (Act::Account, true) if self.approve.contains("post") => "Reply posted.",
            (Act::Account, true) => "Change made in Google Ads.",
            (Act::Draft, true) => "Draft accepted.",
            (Act::Acquisition { .. } | Act::Check, true) => "Approved and queued.",
            (Act::Growth { .. }, true) => "Approved. The agent is making it now.",
            (_, true) => "Approved.",
            (Act::Growth { .. }, false) => "Declined.",
            (_, false) => "Rejected.",
        }
    }
}

/// The web's explanation for a refusal reason the API names, if it is one it knows.
pub fn refusal(body: &str) -> Option<&'static str> {
    let v: Value = serde_json::from_str(body).ok()?;
    let reason = v.get("reason").and_then(Value::as_str)?;
    Some(match reason {
        "StaleBinding" => "The campaign or artifact changed. Prepare the current revision before publishing.",
        "TrackingNotTested" => "Submit a prelaunch test inquiry before publishing.",
        "ChecksBlocking" => "The pre-launch checks found problems that must be fixed in a new version first.",
        "ChecksMissing" => "This page wasn't checked before launch. Ask the agent to prepare it again.",
        "NotAWebsiteDeliverable" => "Only a website deliverable can become a campaign page. Send or post this one yourself.",
        "PublishingNotConfigured" => "Campaign publishing needs a public server address and encrypted inquiry storage. Ask the workspace administrator to enable it.",
        "ChangedSincePrepared" => "This changed after it was prepared, so it wasn't overwritten. Ask the agent to prepare it again.",
        "NotStoredAsApproved" => "The change wasn't stored exactly as approved, so it isn't counted as done.",
        "SeoNotWritable" => "The site's SEO plugin didn't accept the new title or description through WordPress's API. Set it in WordPress, or allow API writes in the plugin.",
        "WordPressCredentialRefused" => "WordPress no longer accepts the connected application password. Reconnect it on the Channels page.",
        "WordPressNotConnected" => "No WordPress site is connected. Connect it on the Channels page.",
        "ChangeNotPending" | "ActionNotPending" => "This was already decided.",
        "SiteUNAVAILABLE" => "The WordPress site didn't answer. Try again in a moment.",
        "SiteRATE_LIMITED" => "The WordPress site is limiting requests. Try again in a few minutes.",
        "SiteFORBIDDEN" => "WordPress refused: the connected user can't make this change.",
        "SiteNOT_FOUND" => "That page or post no longer exists in WordPress.",
        "AdsReauthorizationRequired" => "The Google connection needs a new sign-in. Reconnect it on the Channels page.",
        "ProviderUnavailable" => "Google didn't answer. Inspect the account before making another change; the outcome may be unknown.",
        "ProviderQuota" => "Google is limiting requests. Try again in a few minutes.",
        "AdAccountNotAccessible" => "The connected Google sign-in can't change this account.",
        "ProviderRejected" => "Google refused this change.",
        "CampaignNotFound" => "That campaign no longer exists.",
        _ => return None,
    })
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn opt(v: &Value, k: &str) -> Option<String> {
    let x = s(v, k);
    (!x.is_empty()).then_some(x)
}

/// HTML as the words a person reads, as the web's `plain` does.
pub fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        out.push(' ');
        let tail = &rest[i..];
        let end = if tail.starts_with("<!--") {
            tail.find("-->").map(|e| e + 3)
        } else if tail.to_ascii_lowercase().starts_with("<script") {
            out.push_str("[structured data] ");
            tail.to_ascii_lowercase().find("</script>").map(|e| e + 9)
        } else {
            tail.find('>').map(|e| e + 1)
        };
        rest = match end {
            Some(e) => &tail[e..],
            None => "",
        };
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: String, n: usize) -> String {
    if s.chars().count() <= n { s } else { s.chars().take(n).collect::<String>() + "…" }
}

fn money(v: &Value, currency: &str) -> String {
    match v.as_f64() {
        Some(n) => format!("{} {n:.2}", if currency.is_empty() { "USD" } else { currency }),
        None => String::new(),
    }
}

pub fn parse(v: &Value) -> Option<Decision> {
    let kind = s(v, "type");
    let business = v.get("business").cloned().unwrap_or(Value::Null);
    let mut d = Decision {
        key: String::new(),
        id: String::new(),
        kind: kind.clone(),
        business_id: s(&business, "id"),
        business_name: s(&business, "name"),
        conversation_id: opt(v, "conversationId"),
        created_at: opt(v, "createdAt"),
        label: String::new(),
        title: String::new(),
        summary: String::new(),
        sections: Vec::new(),
        body: None,
        artifact: None,
        note: None,
        act: Act::Draft,
        approve: "Approve".into(),
        decline: "Reject".into(),
        feedback_title: String::new(),
        feedback_kind: "AGENT_PROPOSAL",
        agent: v.get("agent").filter(|a| a.is_object()).map(|a| Sender { provider: opt(a, "provider"), model: opt(a, "model"), session: opt(a, "session"), text: s(a, "text") }),
    };
    let sec = |label: &str, text: String| Section { label: label.into(), before: None, text };
    match kind.as_str() {
        "MARKETING_STRATEGY" => {
            let r = v.get("strategy")?;
            d.id = s(r, "id");
            d.label = "Marketing strategy".into();
            d.title = format!("Strategy version {}", r["version"].as_i64().unwrap_or(0));
            d.summary = s(r, "rationale");
            let list = |key: &str| r[key].as_array().map(|xs| xs.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            let before = |key: &str| r["replaces"].get(key).and_then(Value::as_str).map(str::to_string);
            let mut sections = Vec::new();
            for (label, key) in [("Audience", "audience"), ("Positioning", "positioning"), ("Offer", "offer"), ("Voice", "voice"), ("Budget limit", "budgetLimit")] {
                let text = s(r, key);
                if !text.is_empty() { sections.push(Section { label: label.into(), before: before(key).filter(|b| b != &text), text }); }
            }
            let bets = list("priorityBets");
            if !bets.is_empty() { sections.push(sec("Priority bets", bets)); }
            let avoid = list("avoidPhrases");
            if !avoid.is_empty() { sections.push(sec("Phrases to avoid", avoid)); }
            d.sections = sections;
            d.note = Some("Approving makes this the strategy every campaign and draft follows. The budget limit is for planning and never approves spending.".into());
            d.approve = "Approve strategy".into();
            d.act = Act::Strategy;
            d.feedback_kind = "MARKETING_STRATEGY";
            d.feedback_title = d.title.clone();
        }
        "CAMPAIGN_REVIEW" => {
            let r = v.get("review")?;
            d.id = s(r, "id");
            d.label = "Campaign review".into();
            d.title = s(r, "campaignTitle");
            let verdict = match s(r, "verdict").as_str() { "KEEP" => "Keep it running", "CHANGE" => "Change it", "STOP" => "Stop it", _ => "Too early to judge" };
            d.summary = format!("Proposed verdict: {verdict}.");
            let e = &r["evidence"];
            let totals = &e["totals"];
            let mut evidence = format!("{} views and {} recorded inquiries on the live pages.", totals["views"].as_u64().unwrap_or(0), totals["inquiries"].as_u64().unwrap_or(0));
            if let Some(reasons) = e["sufficiency"]["reasons"].as_array() {
                for reason in reasons.iter().filter_map(Value::as_str) { evidence.push_str(&format!("\n{reason}")); }
            }
            d.sections = vec![sec("What the agent found", s(r, "summary")), sec("Recorded evidence", evidence)];
            let hypothesis = s(r, "nextHypothesis");
            let change = s(r, "nextChange");
            if !hypothesis.is_empty() || !change.is_empty() { d.sections.push(sec("Next experiment", [hypothesis, change].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n"))); }
            d.note = Some("Approving records this verdict and the next experiment. Nothing is published, changed or spent. Inquiries are recorded submissions, not qualified leads.".into());
            d.approve = "Record review".into();
            d.act = Act::Review;
            d.feedback_kind = "CAMPAIGN_REVIEW";
            d.feedback_title = d.title.clone();
        }
        "CAMPAIGN_PUBLICATION" => {
            let p = v.get("publication")?;
            d.id = s(p, "id");
            d.label = "Campaign publication".into();
            d.title = s(p, "title");
            d.summary = "Publish this exact saved artifact as an OpenRecord-hosted campaign page with an inquiry form.".into();
            d.artifact = opt(p, "artifactId");
            let version = p["artifactVersion"].as_i64().unwrap_or_default();
            d.sections = vec![sec("Destination", s(p, "destination")), sec("Artifact revision", format!("Version {version}")), sec("Inquiry button", s(p, "ctaLabel")), sec("Privacy notice", s(p, "privacyNotice"))];
            let findings = p["checks"].as_array().cloned().unwrap_or_default();
            let lines = |severity: &str| findings.iter().filter(|f| f["severity"].as_str() == Some(severity)).filter_map(|f| f["message"].as_str().map(|m| format!("- {m}"))).collect::<Vec<_>>().join("\n");
            let blocking = lines("BLOCKING");
            if !blocking.is_empty() { d.sections.push(sec("Must fix before publishing", blocking)); }
            let warnings = lines("WARNING");
            if !warnings.is_empty() { d.sections.push(sec("Check before approving", warnings)); }
            if findings.is_empty() && p["checked"].as_bool() == Some(true) { d.sections.push(sec("Pre-launch checks", "Links, placeholders, headings and claims checked. Nothing found.".into())); }
            d.note = Some("Approval makes this exact revision public. Inquiries appear in this campaign; no email notification is sent. Test inquiries do not count as results.".into());
            d.approve = "Approve and publish".into();
            d.act = Act::Publication { version, digest: s(p, "contentDigest"), destination: s(p, "destination"), tested: p["trackingTested"].as_bool().unwrap_or(false), stale: p["stale"].as_bool().unwrap_or(true), blocking: p["blocking"].as_u64().unwrap_or(0) };
            d.feedback_kind = "CAMPAIGN_PUBLICATION";
            d.feedback_title = d.title.clone();
        }

        "GROWTH_OPPORTUNITY" => {
            let o = v.get("opportunity")?;
            d.id = s(o, "id");
            d.label = "Proposed work".into();
            d.title = s(o, "title");
            d.summary = s(o, "problemStatement");
            let suggested = o.get("evidence").and_then(Value::as_array).is_some_and(|e| e.iter().any(|x| s(x, "type") == "MODEL_SUGGESTION"));
            d.sections = vec![
                sec("The change", s(o, "proposedChange")),
                sec("Why it could help", s(o, "expectedMechanism")),
                sec("What we don't know", s(o, "uncertainty")),
                sec(
                    "Where this came from",
                    if suggested { "Suggested by OpenRecord from your brief and homepage. An idea to try, not a measured result.".into() } else { s(o, "source") },
                ),
            ];
            d.note = Some("Approving starts the work: the agent makes the finished change in a chat. Nothing goes live on your site until you approve that too.".into());
            d.approve = "Approve and start".into();
            d.act = Act::Growth { status: s(o, "status"), revision: o.get("revision").and_then(Value::as_i64).unwrap_or(1) };
            d.decline = "Not now".into();
            d.feedback_title = d.title.clone();
            d.feedback_kind = "GROWTH_OPPORTUNITY";
            if s(o, "status") != "PROPOSED" {
                return None;
            }
        }
        "WORDPRESS_CHANGE" => {
            let c = v.get("change")?;
            d.id = s(c, "id");
            let ck = s(c, "kind");
            let target = s(c, "targetTitle");
            let what = match ck.as_str() {
                "UPDATE_COPY" => format!("Update the copy of \"{target}\""),
                "SET_SEO" => format!("New search title and description for \"{target}\""),
                "ADD_FAQ" => format!("Add an FAQ to \"{target}\""),
                _ => format!("Publish a new {}", if s(c, "postType") == "pages" { "page" } else { "post" }),
            };
            d.label = "Website change".into();
            d.title = format!("Website change: {target}");
            d.summary = s(c, "rationale");
            let empty = Value::Null;
            let after = c.get("after").unwrap_or(&empty);
            let before = c.get("before").unwrap_or(&empty);
            if ck == "ADD_FAQ" {
                let b = s(before, "content");
                let a = s(after, "content");
                let added = a.get(b.trim_end().len().min(a.len())..).unwrap_or(&a);
                d.sections.push(sec("Added at the end of the page", clip(plain(added), 1200)));
            } else {
                if let Some(t) = opt(after, "title") {
                    d.sections.push(Section { label: "Title".into(), before: (ck != "CREATE_POST").then(|| s(before, "title")), text: t });
                }
                if let Some(Value::Object(meta)) = after.get("meta") {
                    // The search title before its description, as the web lists them.
                    let mut fields: Vec<_> = meta.iter().collect();
                    fields.sort_by_key(|(k, _)| !k.contains("title"));
                    for (k, val) in fields {
                        let old = before.get("meta").map(|m| s(m, k));
                        let name = if k.contains("title") { "Search title" } else { "Search description" };
                        d.sections.push(Section { label: name.into(), before: old, text: val.as_str().unwrap_or_default().to_string() });
                    }
                }
                if let Some(body) = opt(after, "content") {
                    d.body = Some(clip(plain(&body), 3000));
                }
            }
            if let Some(link) = opt(c, "targetLink") {
                d.sections.push(sec("Page", link));
            }
            d.note = Some("Approving publishes this to your WordPress site. You can undo it afterwards on the web.".into());
            d.act = Act::WordPress;
            d.approve = "Approve and publish".into();
            d.feedback_title = what;
            d.feedback_kind = "WORDPRESS_CHANGE";
            if s(c, "status") != "PROPOSED" {
                return None;
            }
        }
        "ACCOUNT_ACTION" => {
            let a = v.get("action")?;
            d.id = s(a, "id");
            let empty = Value::Null;
            let target = a.get("target").unwrap_or(&empty);
            let after = a.get("after").unwrap_or(&empty);
            let before = a.get("before").unwrap_or(&empty);
            let campaign = format!("\"{}\"", s(target, "campaignName"));
            let currency = s(target, "currency");
            let ak = s(a, "kind");
            d.title = match ak.as_str() {
                "REPLY_TO_REVIEW" => {
                    let rating = s(target, "rating");
                    format!("Reply to {}'s {}review", s(target, "reviewer"), if rating.is_empty() { String::new() } else { format!("{rating}-star ") })
                }
                "PAUSE_CAMPAIGN" => format!("Pause the campaign {campaign}"),
                "ENABLE_CAMPAIGN" => format!("Turn on the campaign {campaign}"),
                "SET_DAILY_BUDGET" => format!(
                    "Daily budget of {campaign}: {} to {}",
                    money(before.get("daily").unwrap_or(&empty), &currency),
                    money(after.get("daily").unwrap_or(&empty), &currency)
                ),
                "CREATE_SEARCH_AD" => format!("New search ad in \"{}\" ({campaign})", s(target, "adGroupName")),
                other => other.replace('_', " ").to_lowercase(),
            };
            d.label = "Account change".into();
            d.summary = s(a, "rationale");
            let list = |v: Option<&Value>| -> Vec<String> { v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default() };
            match ak.as_str() {
                "REPLY_TO_REVIEW" => {
                    let comment = s(target, "comment");
                    d.sections.push(sec("The review", if comment.is_empty() { "(no text)".into() } else { comment }));
                    d.sections.push(Section { label: "Your reply".into(), before: opt(before, "reply"), text: s(after, "reply") });
                    d.note = Some("The reply is public on Google, under the review.".into());
                    d.approve = "Approve and post".into();
                }
                "CREATE_SEARCH_AD" => {
                    d.sections.push(sec("Headlines", list(after.get("headlines")).join(" | ")));
                    d.sections.push(sec("Descriptions", list(after.get("descriptions")).join(" ")));
                    d.sections.push(sec("Goes to", s(after, "finalUrl")));
                    d.note = Some("Created paused: it doesn't run or spend until someone turns it on.".into());
                    d.approve = "Approve and apply".into();
                }
                "SET_DAILY_BUDGET" => {
                    d.note = Some("Google can spend up to twice the daily budget on a single day; the monthly total stays within about 30 times it.".into());
                    d.approve = "Approve and apply".into();
                }
                "ENABLE_CAMPAIGN" => {
                    let daily = after.get("budgetDailyMicros").and_then(Value::as_f64).map(|m| json!(m / 1_000_000.0)).unwrap_or(Value::Null);
                    d.note = Some(format!(
                        "Enabling can spend from the existing {}daily budget of {}. Google may spend more than the daily amount on an individual day.",
                        if after.get("budgetShared").and_then(Value::as_bool).unwrap_or(false) { "shared " } else { "" },
                        money(&daily, &currency)
                    ));
                    d.approve = "Approve and apply".into();
                }
                _ => d.approve = "Approve and apply".into(),
            }
            d.act = Act::Account;
            d.feedback_title = d.title.clone();
            d.feedback_kind = "ACCOUNT_ACTION";
            if s(a, "status") != "PROPOSED" {
                return None;
            }
        }
        "AGENT_PROPOSAL" => {
            let p = v.get("proposal")?;
            d.id = s(p, "id");
            d.title = s(p, "message");
            let payload = p.get("payload").filter(|x| !x.is_null());
            let text = payload.map(|x| s(x, "text")).filter(|t| !t.is_empty());
            match s(p, "kind").as_str() {
                "REQUEST_CHECK" => {
                    d.label = "Re-check".into();
                    d.summary = "Proposed re-check".into();
                    d.note = Some("Approval queues one external measurement call using 9Router and the model you choose. Estimated cost is unavailable; provider charges may apply. No fact or judgment is approved.".into());
                    d.act = Act::Check;
                    d.approve = "Approve and queue check".into();
                    d.feedback_title = format!("Re-check: {}", d.title);
                }
                "REQUEST_ACQUISITION_BATCH" => {
                    let plan = payload.and_then(|x| x.get("measurementPlan")).filter(|x| !x.is_null());
                    let cost = plan.and_then(|x| x.get("estimatedMaxCostUsd")).and_then(Value::as_f64);
                    let blocked = plan.is_none() || plan.and_then(|x| x.get("missingRequirements")).and_then(Value::as_array).is_some_and(|m| !m.is_empty());
                    d.label = "Measurement".into();
                    d.summary = "Proposed acquisition measurement".into();
                    d.body = Some(text.clone().unwrap_or_else(|| "Measurement plan unavailable".into()));
                    d.approve = match cost {
                        Some(c) => format!("Approve estimated USD {c:.2} and queue"),
                        None => "Approve and queue".into(),
                    };
                    d.act = Act::Acquisition { cost, blocked };
                    d.feedback_title = "Acquisition measurement".into();
                }
                k => {
                    d.label = match k {
                        "PREPARE_CLIENT_REPORT" => "Client report",
                        "PROPOSE_QUESTION_SET" => "Buyer questions",
                        _ => "Draft",
                    }
                    .into();
                    d.summary = match k {
                        "PREPARE_CLIENT_REPORT" => "Private client report, awaiting review",
                        "PROPOSE_QUESTION_SET" => "Buyer-question proposal, awaiting review",
                        _ => "Suggested fix, waiting for you",
                    }
                    .into();
                    d.body = Some(text.clone().unwrap_or_else(|| "Sources not available".into()));
                    d.note = Some("Accepting saves the draft. Nothing is published or sent.".into());
                    d.approve = "Accept draft".into();
                    d.act = Act::Draft;
                    d.feedback_title = d.title.clone();
                    d.feedback_kind = "AGENT_DRAFT";
                }
            }
            if s(p, "status") != "PROPOSED" {
                return None;
            }
        }
        _ => return None,
    }
    if d.id.is_empty() {
        return None;
    }
    if d.title.is_empty() {
        d.title = "A decision is waiting".into();
    }
    d.sections.retain(|x| !x.text.trim().is_empty());
    d.key = format!("{kind}:{}", d.id);
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, field: &str, body: Value) -> Value {
        json!({ "type": kind, "business": { "id": "b1", "name": "Cueup" }, "createdAt": "2026-11-10T00:00:00Z", field: body })
    }

    #[test]
    fn reads_an_initiative_and_its_decision_calls() {
        let d = parse(&item(
            "GROWTH_OPPORTUNITY",
            "opportunity",
            json!({ "id": "o1", "title": "Pricing guide", "problemStatement": "Answers guess at price", "proposedChange": "Publish a guide",
                    "expectedMechanism": "Assistants quote it", "uncertainty": "Uptake", "source": "Brief", "status": "PROPOSED", "revision": 3, "evidence": [] }),
        ))
        .unwrap();
        assert_eq!((d.key.as_str(), d.title.as_str(), d.decline.as_str()), ("GROWTH_OPPORTUNITY:o1", "Pricing guide", "Not now"));
        assert_eq!(d.sections.len(), 4);
        let (path, body) = d.approve_call(None);
        assert_eq!(path, "/api/growth/clients/b1/opportunities/o1/approve");
        assert_eq!((body["expectedStatus"].as_str(), body["expectedRevision"].as_i64()), (Some("PROPOSED"), Some(3)));
        let (path, body) = d.decline_call(Some("too early"));
        assert!(path.ends_with("/cancel"));
        assert_eq!(body["reason"], "Declined: too early");
        let (_, fb) = d.feedback(false, Some(" too early "));
        assert_eq!((fb["verdict"].as_str(), fb["reason"].as_str()), (Some("REJECTED"), Some("too early")));
    }

    #[test]
    fn skips_what_is_already_decided() {
        assert!(parse(&item("WORDPRESS_CHANGE", "change", json!({ "id": "w1", "status": "PUBLISHED" }))).is_none());
    }

    #[test]
    fn wordpress_changes_show_before_and_after() {
        let d = parse(&item(
            "WORDPRESS_CHANGE",
            "change",
            json!({ "id": "w1", "kind": "SET_SEO", "postType": "pages", "targetTitle": "Pricing", "rationale": "Clearer",
                    "before": { "meta": { "_yoast_wpseo_title": "Old" } }, "after": { "meta": { "_yoast_wpseo_title": "New" } }, "status": "PROPOSED" }),
        ))
        .unwrap();
        assert_eq!(d.sections[0], Section { label: "Search title".into(), before: Some("Old".into()), text: "New".into() });
        assert_eq!(d.feedback_title, "New search title and description for \"Pricing\"");
        assert_eq!(d.approve_call(None).0, "/api/businesses/b1/wordpress/changes/w1/approve");
    }

    #[test]
    fn proposals_pick_their_call() {
        let check = parse(&item("AGENT_PROPOSAL", "proposal", json!({ "id": "p1", "kind": "REQUEST_CHECK", "status": "PROPOSED", "message": "Re-run pricing" }))).unwrap();
        assert!(check.blocked(None).is_some());
        assert!(check.blocked(Some("gpt-5")).is_none());
        assert_eq!(check.approve_call(Some("gpt-5")).1["requestedModel"], "gpt-5");
        let acq = parse(&item("AGENT_PROPOSAL", "proposal", json!({ "id": "p2", "kind": "REQUEST_ACQUISITION_BATCH", "status": "PROPOSED", "message": "m",
            "payload": { "text": "plan", "measurementPlan": { "estimatedMaxCostUsd": 1.5, "missingRequirements": [] } } }))).unwrap();
        assert_eq!(acq.approve, "Approve estimated USD 1.50 and queue");
        assert!(acq.blocked(None).is_none());
        let draft = parse(&item("AGENT_PROPOSAL", "proposal", json!({ "id": "p3", "kind": "DRAFT_SOURCE_ACTION", "status": "PROPOSED", "message": "m", "payload": { "text": "t" } }))).unwrap();
        assert_eq!((draft.feedback_kind, draft.approve_call(None).1["draftOnly"].as_bool()), ("AGENT_DRAFT", Some(true)));
    }

    #[test]
    fn plain_strips_markup() {
        assert_eq!(plain("<p>Hello <b>there</b></p><!-- x --><script>{}</script>end"), "Hello there [structured data] end");
    }

    #[test]
    fn names_refusals() {
        assert_eq!(refusal(r#"{"reason":"ChangeNotPending"}"#), Some("This was already decided."));
        assert_eq!(refusal("nope"), None);
    }
}

#[cfg(test)]
mod work_request_tests {
    use super::*;

    #[test]
    fn approved_proposed_work_asks_the_agent_for_the_finished_change() {
        let d = parse(&serde_json::json!({ "type": "GROWTH_OPPORTUNITY", "business": { "id": "b1", "name": "B" }, "opportunity": {
            "id": "o1", "title": "Add an FAQ to pricing", "status": "PROPOSED", "revision": 1,
            "proposedChange": "Answer the five trial questions on the pricing page." } })).unwrap();
        let r = d.work_request().unwrap();
        assert!(r.starts_with("I approved \"Add an FAQ to pricing\". Do it now. The change: Answer the five trial questions"));
        assert!(r.contains("create_artifact"));
        assert_eq!(d.approve, "Approve and start");
        let mut other = d.clone();
        other.act = Act::WordPress;
        assert!(other.work_request().is_none());
    }
}
