//! Made-up workspace data for headless scenes (`--scene NAME`), so every
//! screen can be rendered and checked without a server.

use serde_json::json;

use crate::api::{Business, Campaign, Channel, ChatSummary, Conversation, Decision, Issue, Message, Overview, ToolCall};
use crate::state::{App, Load, Menu, Page, Screen, View};

fn business(id: &str, name: &str) -> Business {
    Business { id: id.into(), name: name.into() }
}

fn ago(minutes: i64) -> Option<String> {
    let t = crate::format::now() - minutes * 60;
    let days = t.div_euclid(86400);
    let secs = t.rem_euclid(86400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    Some(format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", secs / 3600, secs % 3600 / 60, secs % 60))
}

fn chat(id: &str, b: &Business, title: &str, minutes: i64, working: bool) -> ChatSummary {
    ChatSummary {
        id: id.into(),
        business_id: Some(b.id.clone()),
        business_name: b.name.clone(),
        title: Some(title.into()),
        updated_at: ago(minutes),
        parent_session_id: None,
        working,
        providers: vec!["claude".into()],
    }
}

fn workspace(s: &mut App) {
    let a = business("b-northstar", "Northstar Analytics");
    let b = business("b-acme", "Acme Outdoors");
    let c = business("b-brightline", "Brightline Legal");
    s.screen = Screen::Workspace;
    s.account_email = Some("demo@northstar.test".into());
    s.chats = vec![
        chat("c1", &a, "Next step for the pricing page", 12, false),
        chat("c2", &b, "Weekly brief", 60 * 26, false),
        chat("c3", &a, "Why ChatGPT gets our integrations wrong", 60 * 50, false),
        chat("c4", &c, "Draft the FAQ for new clients", 60 * 24 * 4, false),
    ];
    s.businesses = vec![a, b, c];
    s.active = Some("b-northstar".into());
    s.overview = Load::Ready(Overview { completed: 6, last_checked: ago(60 * 3), unreviewed: 1, needs_attention: 4 });
    s.decisions = decisions();
}

fn decisions() -> Vec<Decision> {
    let northstar = json!({ "id": "b-northstar", "name": "Northstar Analytics" });
    let items = [
        json!({ "type": "GROWTH_OPPORTUNITY", "business": northstar, "createdAt": ago(90), "conversationId": "c1", "opportunity": {
            "id": "o1", "title": "Publish a transparent pricing and onboarding guide", "status": "PROPOSED", "revision": 2,
            "problemStatement": "Three of five checked answers guess at pricing. One page with verified prices and setup steps gives assistants something true to quote.",
            "proposedChange": "One public page with each plan's price, what it includes, and the setup steps, built only from approved facts.",
            "expectedMechanism": "Assistants quote pages that state prices plainly, so answers stop guessing and buyers arrive with the right expectations.",
            "uncertainty": "How quickly assistants pick up a new page varies from days to weeks.",
            "source": "Brief", "evidence": [{ "type": "MODEL_SUGGESTION" }] } }),
        json!({ "type": "WORDPRESS_CHANGE", "business": northstar, "createdAt": ago(60 * 5), "change": {
            "id": "w1", "kind": "SET_SEO", "postType": "pages", "targetTitle": "Pricing", "targetLink": "https://northstar.test/pricing", "status": "PROPOSED",
            "rationale": "The search title doesn't say what Northstar does, so the pricing page rarely shows for plan questions.",
            "before": { "meta": { "_yoast_wpseo_title": "Pricing - Northstar", "_yoast_wpseo_metadesc": "" } },
            "after": { "meta": { "_yoast_wpseo_title": "Northstar Analytics pricing: plans from $49 a month", "_yoast_wpseo_metadesc": "Compare Northstar's three plans, what each includes, and how setup works." } } } }),
        json!({ "type": "AGENT_PROPOSAL", "business": northstar, "createdAt": ago(60 * 26), "proposal": {
            "id": "p1", "kind": "REQUEST_CHECK", "status": "PROPOSED", "questionId": "q1", "message": "Re-check \"Does Northstar integrate with Snowflake?\" now that the integrations page lists it." } }),
    ];
    items.iter().filter_map(crate::decisions::parse).collect()
}

pub fn signin(s: &mut App) {
    s.screen = Screen::SignIn;
}

pub fn agent(s: &mut App) {
    workspace(s);
    s.view = View::Agent;
    s.chat_id = Some("c1".into());
    s.conversation = Load::Ready(Conversation {
        id: "c1".into(),
        title: Some("Next step for the pricing page".into()),
        revision: 2,
        messages: vec![
            Message {
                role: "user".into(),
                text: "What should we work on next? Check our results and channels and propose the most useful next step for me to approve.".into(),
                tool_calls: vec![],
            },
            Message {
                role: "agent".into(),
                text: "The most useful next step is **a public pricing and onboarding guide**, built only from your approved facts.\n\n- AI assistants guessed at pricing in 3 of the 5 answers checked this week.\n- Your website has no page that states plans or setup time.\n- Search Console is not connected, so I can't yet see which queries reach you.\n\nI saved it to your inbox as an idea to approve. Once you approve, I'll draft the page and set a baseline to measure against.".into(),
                tool_calls: vec![
                    ToolCall { tool: "read_results".into(), summary: "2 approved ideas, 2 not done yet".into() },
                    ToolCall { tool: "read_business_truth".into(), summary: "8 approved facts read".into() },
                    ToolCall { tool: "read_search_performance".into(), summary: "Search Console is not connected".into() },
                ],
            },
        ],
    });
}

pub fn agent_empty(s: &mut App) {
    workspace(s);
    s.view = View::Agent;
}

fn page(s: &mut App, page: Page) {
    workspace(s);
    s.view = View::Workspace;
    s.page = page;
}

pub fn inbox(s: &mut App) {
    page(s, Page::Inbox);
}

pub fn inbox_wordpress(s: &mut App) {
    page(s, Page::Inbox);
    s.decision = Some("WORDPRESS_CHANGE:w1".into());
}

pub fn inbox_check(s: &mut App) {
    page(s, Page::Inbox);
    s.decision = Some("AGENT_PROPOSAL:p1".into());
    s.models = Load::Ready(vec!["openai/gpt-5".into(), "anthropic/claude-sonnet-5-5".into(), "google/gemini-3-pro".into()]);
    s.model = Some("openai/gpt-5".into());
}

pub fn inbox_decline(s: &mut App) {
    page(s, Page::Inbox);
    s.declining = true;
    s.decline_reason.replace_text("We're changing prices next month");
}

pub fn overview(s: &mut App) {
    page(s, Page::Overview);
}

pub fn campaigns(s: &mut App) {
    page(s, Page::Campaigns);
    s.campaigns = Load::Ready(vec![Campaign {
        id: "cp1".into(),
        title: "Pricing guide launch".into(),
        stage: "PLANNED".into(),
        goal: "More trial sign-ups from people who asked an assistant about pricing.".into(),
        updated_at: ago(60 * 5),
    }]);
}

pub fn ai_answers(s: &mut App) {
    page(s, Page::AiAnswers);
    let issue = |id: &str, state: &str, claim: &str, q: &str, a: &str| Issue {
        claim_id: id.into(),
        claim_text: claim.into(),
        answer_text: a.into(),
        provider: "openai".into(),
        observed_model: Some("gpt-5".into()),
        question_prompt: Some(q.into()),
        collected_at: ago(60 * 4),
        state: state.into(),
    };
    s.issues = Load::Ready(vec![
        issue("i1", "WRONG", "Northstar does not integrate with Salesforce.", "Does Northstar integrate with Salesforce?", "Northstar does not integrate with Salesforce. Teams usually export CSV files instead."),
        issue("i2", "PARTIAL", "Plans start at $49 a month.", "How much does Northstar cost?", "Northstar's plans start at $49 a month, with a free trial."),
        issue("i3", "UNKNOWN", "Setup takes about two weeks.", "How long does Northstar take to set up?", "Most teams report that setup takes about two weeks."),
        issue("i4", "NEEDS_REVIEW", "Northstar is SOC 2 certified.", "Is Northstar secure?", "Yes. Northstar is SOC 2 certified and encrypts data at rest."),
    ]);
}

pub fn channels(s: &mut App) {
    page(s, Page::Channels);
    let ch = |key: &str, label: &str, identity: Option<&str>, state: &str, note: &str| Channel {
        key: key.into(),
        label: label.into(),
        identity: identity.map(Into::into),
        state: state.into(),
        note: note.into(),
        active: vec![],
    };
    s.channels = Load::Ready(vec![
        ch("website", "Website", Some("northstar.test"), "DISCOVERED", "Read from the public web. Inspections find indexing problems, propose fixes and re-check the live page."),
        ch("ga4", "Google Analytics 4", None, "UNSUPPORTED", "Not configured on this server. Import daily numbers by hand instead."),
        ch("search-console", "Google Search Console", None, "UNSUPPORTED", "Google sign-in is not configured on this server, so search clicks and queries cannot be read."),
    ]);
}

pub fn collapsed(s: &mut App) {
    agent(s);
    s.sidebar_open = false;
}

pub fn business_menu(s: &mut App) {
    inbox(s);
    s.menu = Some(Menu::Businesses);
}
