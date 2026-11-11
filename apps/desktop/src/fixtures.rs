//! Made-up workspace data for headless scenes (`--scene NAME`), so every
//! screen can be rendered and checked without a server.

use serde_json::json;

use crate::api::{Business, Campaign, Channel, ChatSummary, Conversation, Decision, Issue, Message, Overview};
use crate::insights::{self, Analytics, Insights, Report, Section, Source, Verdicts};
use crate::state::{App, Load, Menu, Page, Screen, Turn, View};

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
        ChatSummary { providers: vec!["gemini".into(), "claude".into()], ..chat("c1", &a, "Next step for the pricing page", 12, false) },
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

fn chat_messages() -> Vec<Message> {
    let m = |v: serde_json::Value| serde_json::from_value::<Message>(v).expect("fixture message");
    vec![
        m(json!({ "role": "user", "text": "What should we work on next? Check our results and channels and propose the most useful next step for me to approve." })),
        m(json!({
            "role": "agent",
            "text": "The most useful next step is **a public pricing and onboarding guide**, built only from your approved facts.\n\n- AI assistants guessed at pricing in 3 of the 5 answers checked this week.\n- Your website has no page that states plans or setup time.\n- Search Console is not connected, so I can't yet see which queries reach you.\n\nI saved it to your inbox as an idea to approve. Once you approve, I'll draft the page and set a baseline to measure against.",
            "activity": [
                { "kind": "thought", "text": "Start from what was approved and what the latest AI answers got wrong.", "ms": 2100 },
                { "kind": "tool", "tool": "read_results", "text": "2 approved ideas, 2 not done yet" },
                { "kind": "tool", "tool": "read_business_truth", "text": "8 approved facts read" },
                { "kind": "tool", "tool": "read_search_performance", "text": "Search Console is not connected", "failed": true },
                { "kind": "tool", "tool": "propose_growth_opportunity", "text": "Saved an idea to approve" }
            ],
            "durationMs": 23000,
            "citations": [
                { "kind": "web", "id": "https://northstar.example/pricing", "text": "Northstar pricing" },
                { "kind": "truth", "id": "f1", "text": "Monthly price: from 49 USD" }
            ],
            "decisions": [{ "type": "GROWTH_OPPORTUNITY", "id": "o1" }],
            "inference": { "provider": "hosted", "requestedModel": "gemini-3-flash" },
            "run": { "id": "r1", "status": "COMPLETED", "gaps": ["Search Console data"] }
        })),
        m(json!({ "role": "user", "text": "Ask a helper to research how competitors explain their onboarding." })),
        m(json!({
            "role": "agent",
            "text": "I started a research helper. It reads public onboarding pages and reports back here.",
            "activity": [{ "kind": "tool", "tool": "start_session", "text": "Started a research helper" }],
            "durationMs": 6000,
            "tasks": [{ "id": "t1", "sessionId": "s2", "title": "How others explain onboarding", "role": "researcher", "status": "RUNNING", "model": "claude-sonnet-5-5" }],
            "inference": { "provider": "claude", "requestedModel": "claude-sonnet-5-5" }
        })),
    ]
}

pub fn agent(s: &mut App) {
    workspace(s);
    s.view = View::Agent;
    s.chat_id = Some("c1".into());
    s.catalog = Load::Ready(models());
    s.agent_model = Some("i1:claude-sonnet-5-5".into());
    s.conversation = Load::Ready(Conversation { id: "c1".into(), title: Some("Next step for the pricing page".into()), revision: 2, messages: chat_messages(), session: None });
}

/// The models the composer offers in scenes.
fn models() -> Vec<crate::chat::ModelOption> {
    crate::chat::model_options(&json!({
        "hosted": { "provider": "gemini", "model": "gemini-3-flash" },
        "instances": [
            { "id": "i1", "driver": "claude", "name": "This Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
              "models": [{ "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5", "reasoningEfforts": ["low", "medium", "high", "xhigh"] }, { "id": "claude-opus-5-5", "name": "Claude Opus 5.5", "reasoningEfforts": ["low", "medium", "high", "xhigh"] }] },
            { "id": "i2", "driver": "codex", "name": "This Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
              "models": [{ "id": "gpt-5", "name": "GPT-5" }] }
        ]
    }))
}

/// The reasoning effort picker open, "High" picked.
pub fn agent_reasoning(s: &mut App) {
    agent(s);
    s.reasoning = Some(("i1:claude-sonnet-5-5".into(), "high".into()));
    s.menu = Some(Menu::Reasoning);
}

fn msg(v: serde_json::Value) -> Message {
    serde_json::from_value(v).expect("fixture message")
}

/// A reply that answers with charts: bars, a line, a donut and stat tiles.
pub fn agent_chart(s: &mut App) {
    agent(s);
    let text = [
        "Trial sign-ups rose after the pricing page changed.",
        "```chart",
        r#"{"type":"stats","title":"Last 30 days","stats":[{"label":"Trial sign-ups","value":184,"hint":"Up 22% on the month before"},{"label":"Conversion","value":"3.1%"},{"label":"From AI answers","value":"41","hint":"Visits that named an assistant"}]}"#,
        "```",
        "```chart",
        r#"{"type":"bar","title":"Sign-ups by week","labels":["W1","W2","W3","W4","W5","W6"],"series":[{"name":"Sign-ups","values":[28,31,26,39,44,47]}]}"#,
        "```",
        "```chart",
        r#"{"type":"line","title":"Visits from search and AI answers","labels":["Oct 6","Oct 13","Oct 20","Oct 27","Nov 3","Nov 10"],"series":[{"name":"Search","values":[410,436,402,470,512,540]},{"name":"AI answers","values":[22,25,null,38,52,61]}],"note":"No AI answer data for Oct 20."}"#,
        "```",
        "```chart",
        r#"{"type":"donut","title":"Where trials came from","unit":"%","labels":["Search","AI answers","Direct","Referral","Ads"],"series":[{"name":"Share","values":[46,22,17,9,6]}]}"#,
        "```",
        "The largest gain came from people who asked an assistant about pricing.",
    ]
    .join("\n");
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.push(msg(json!({ "role": "user", "text": "How did trials change after the pricing update? Show me." })));
        c.messages.push(msg(json!({ "role": "agent", "text": text, "durationMs": 9000 })));
    }
}

/// Only the charts reply, so a snapshot shows its top.
pub fn agent_chart_top(s: &mut App) {
    agent_chart(s);
    if let Load::Ready(c) = &mut s.conversation {
        let n = c.messages.len();
        c.messages.drain(..n - 1);
        // Stop after the bar chart (the fourth fence), so the stats and bars show.
        let text = &c.messages[0].text;
        let cut = text.match_indices("```").nth(3).map_or(text.len(), |(i, _)| i + 3);
        c.messages[0].text = text[..cut].to_string();
    }
}

/// The same reply with the line chart shown as a table.
pub fn agent_chart_table(s: &mut App) {
    agent_chart(s);
    let n = match &s.conversation {
        Load::Ready(c) => c.messages.len() - 1,
        _ => 0,
    };
    s.visual_tables.insert(format!("visual-{n}-3"));
}

pub fn agent_open_log(s: &mut App) {
    agent(s);
    s.open_logs.insert((1, 0));
    s.open_logs.insert((1, 1));
    s.open_logs.insert((3, 0));
    s.open_sources.insert(1);
}

pub fn agent_working(s: &mut App) {
    agent(s);
    let mut progress = crate::chat::Progress::default();
    let ev = |seq, kind: &str, payload: serde_json::Value| crate::chat::RunEvent { seq, kind: kind.into(), payload };
    progress.apply(&[
        ev(1, "MODEL_STEP", json!({ "thought": "The helper should look at public pages only.", "toolCalls": [{}] })),
        ev(2, "TOOL_STARTED", json!({ "tool": "read_web_pages", "label": "Reading 4 pages" })),
        ev(3, "TOOL_COMPLETED", json!({ "tool": "read_web_pages", "summary": "Read 4 onboarding pages" })),
        ev(4, "TOOL_STARTED", json!({ "tool": "search_web", "label": "Searching the web for setup guides" })),
    ]);
    s.turn = Turn::Working {
        message: "And what does setup take for a team of five?".into(),
        request: Some("q1".into()),
        progress,
        started: std::time::Instant::now() - std::time::Duration::from_secs(14),
        stopping: false,
    };
}

/// Typing a command while a turn runs, with two messages queued, a file attached and memory nearly full.
pub fn agent_compose(s: &mut App) {
    agent_working(s);
    if let Load::Ready(c) = &mut s.conversation {
        if let Some(m) = c.messages.last_mut() {
            m.context = Some(crate::chat::ContextUse { history_chars: 92_000, budget_chars: 100_000, verbatim: 6, compacted: 4, omitted: 0 });
        }
    }
    s.queued = vec!["Then draft the FAQ from the approved facts.".into(), "And send me the weekly brief.".into()];
    s.attachments = vec![crate::chat::Attachment { name: "pricing-notes.md".into(), kind: "text/markdown".into(), text: "# Pricing\n\nStarter 49\nTeam 149\n".into() }];
    s.composer = rune::TextEdit::new("/camp");
}

pub fn agent_archived(s: &mut App) {
    agent(s);
    s.show_archived = true;
    s.archived = Load::Ready(vec![chat("c9", &business("b-acme", "Acme Outdoors"), "Old launch checklist", 60 * 24 * 12, false)]);
}

fn settings(s: &mut App, page: crate::state::SettingsPage) {
    agent(s);
    s.settings = Some(page);
}

pub fn settings_general(s: &mut App) {
    settings(s, crate::state::SettingsPage::General);
}

pub fn settings_agent(s: &mut App) {
    settings(s, crate::state::SettingsPage::Agent);
    s.memory = Load::Ready(
        serde_json::from_value(json!([
            { "id": "n1", "kind": "PREFERENCE", "text": "Write in plain English, no jargon.", "source": "OPERATOR", "createdAt": "2026-11-02T10:00:00Z" },
            { "id": "n2", "kind": "DECISION", "text": "Pricing page comes before the comparison pages.", "source": "ASSISTANT", "createdAt": "2026-11-08T15:30:00Z" }
        ]))
        .unwrap(),
    );
    s.providers = Load::Ready(
        serde_json::from_value(json!({
            "bridges": [{ "id": "b1", "name": "This Mac", "online": true, "managed": true }, { "id": "b2", "name": "Studio iMac", "online": false }],
            "instances": [
                { "id": "i1", "bridgeId": "b1", "localId": "l1", "driver": "claude", "name": "Claude Code", "enabled": true, "installed": true, "version": "2.4.1", "auth": "authenticated", "state": "ready",
                  "models": [{ "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5" }, { "id": "claude-opus-5-5", "name": "Claude Opus 5.5" }, { "id": "claude-haiku-5-5", "name": "Claude Haiku 5.5" }], "disabledModels": ["claude-haiku-5-5"] },
                { "id": "i2", "bridgeId": "b1", "localId": "l2", "driver": "codex", "name": "Codex", "enabled": true, "installed": true, "version": "1.9.0", "auth": "unauthenticated", "state": "ready", "models": [{ "id": "gpt-5", "name": "GPT-5" }] },
                { "id": "i3", "bridgeId": "b1", "driver": "opencode", "name": "OpenCode", "enabled": false, "installed": true, "auth": "authenticated", "state": "ready", "models": [{ "id": "a", "name": "A" }, { "id": "b", "name": "B" }] },
                { "id": "i4", "bridgeId": "b1", "driver": "cursor", "name": "Cursor", "installed": false, "models": [] }
            ],
            "hosted": { "provider": "gemini", "model": "gemini-3-flash" },
            "local": true
        }))
        .unwrap(),
    );
    s.open_models.insert("i1".into());
}

pub fn settings_account(s: &mut App) {
    settings(s, crate::state::SettingsPage::Account);
    s.identity = Load::Ready(crate::settings::Identity { user_id: "8f1c2d0e-user".into(), account_id: "41a7b9c3-account".into() });
}

pub fn agent_models(s: &mut App) {
    agent(s);
    s.menu = Some(Menu::Model);
}

/// A catalog as long as a real one: the list scrolls past eight models.
pub fn agent_models_many(s: &mut App) {
    agent(s);
    s.catalog = Load::Ready(crate::chat::model_options(&json!({
        "hosted": { "provider": "gemini", "model": "gemini-3-flash" },
        "instances": [
            { "id": "i1", "driver": "claude", "name": "This Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
              "models": [{ "id": "claude-fable-5-1", "name": "Claude Fable 5.1" }, { "id": "claude-opus-5-5", "name": "Claude Opus 5.5" }, { "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5" }, { "id": "claude-haiku-5-5", "name": "Claude Haiku 5.5" }] },
            { "id": "i2", "driver": "codex", "name": "This Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
              "models": [{ "id": "gpt-5", "name": "GPT-5" }, { "id": "gpt-5-mini", "name": "GPT-5 mini" }, { "id": "gpt-5-codex", "name": "GPT-5 Codex" }] },
            { "id": "i3", "driver": "claude", "name": "Studio Mac", "enabled": true, "installed": true, "auth": "authenticated", "state": "ready",
              "models": [{ "id": "claude-opus-5-5", "name": "Claude Opus 5.5" }, { "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5" }] }
        ]
    })));
    s.menu = Some(Menu::Model);
    // The pointer over GPT-5, Claude Sonnet chosen: hover and selection side by side.
    s.row_hover = Some("model:i2:gpt-5".into());
}

fn playbooks() -> Vec<crate::chat::Playbook> {
    let p = |n: &str, t: &str, area: &str, built_in: bool| crate::chat::Playbook { name: n.into(), title: t.into(), prompt: format!("{t} for {{business}}."), area: area.into(), built_in };
    // The built-in playbooks the API serves, in its order, and one of the account's own.
    let mut list: Vec<_> = [
        "seo-audit", "keyword-gaps", "aeo-check", "ai-crawlers", "geo-citations", "schema-kit", "rank-watch",
        "entity-consistency", "competitor-scan", "daily-loop", "paying-users", "outcome-review", "portfolio-digest", "weekly-review",
    ]
    .iter()
    .map(|n| p(n, n, "SEO", true))
    .collect();
    list.push(p("sales-recap", "Monday sales recap", "", false));
    list
}

/// The "/" menu after typing "/s": commands first, then playbooks.
pub fn agent_commands(s: &mut App) {
    agent(s);
    s.playbooks = playbooks();
    s.composer.replace_text("/");
    s.command_index = 5;
}

/// The "+" menu open over the composer.
pub fn agent_actions(s: &mut App) {
    agent(s);
    s.composer.replace_text("Write a weekly summary of Northstar Analytics's sign-ups.");
    s.chat_actions = true;
}

pub fn agent_save_playbook(s: &mut App) {
    agent(s);
    s.playbooks = playbooks();
    s.save_playbook = Some(crate::state::SavePlaybook {
        title: rune::TextEdit::new("Weekly sign-ups summary"),
        name: rune::TextEdit::new(""),
        prompt: rune::TextEdit::new("Write a weekly summary of {business}'s sign-ups."),
        busy: false,
        error: None,
    });
}

pub fn agent_share(s: &mut App) {
    agent(s);
    let share = |id: &str, hint: &str, viewed: Option<String>| crate::api::Share { id: id.into(), hint: hint.into(), expires_at: Some("2026-11-24T10:00:00Z".into()), last_viewed_at: viewed, active: true };
    s.share = Some(crate::state::ShareChat {
        conversation: "c1".into(),
        shares: Load::Ready(vec![share("s1", "x7Qa", Some("2026-11-09T15:20:00Z".into())), share("s2", "Lm2c", None)]),
        link: Some("http://localhost:3000/shared/6f1c0b8e7a2d4c35Lm2c".into()),
        busy: false,
        error: None,
    });
}

/// The follow-ups dialog, enabled in this chat, with a recent review.
pub fn agent_followups(s: &mut App) {
    agent(s);
    s.followups = Load::Ready(
        serde_json::from_value(json!({
            "policy": { "kind": "configured", "enabled": true, "grantId": "g1", "conversationId": "c1", "selection": { "instanceId": "i1", "model": "claude-opus-5-5" }, "provider": "claude", "model": "claude-opus-5-5", "updatedAt": "2026-11-09T10:00:00Z" },
            "limits": { "wakeUpsPer24Hours": 1, "modelSteps": 3, "toolCalls": 4, "timeoutSeconds": 120, "readOnly": true },
            "wakes": [{ "id": "w1", "noteId": "n1", "conversationId": "c1", "status": "COMPLETED", "startedAt": "2026-11-10T07:00:00Z", "finishedAt": "2026-11-10T07:01:10Z" }]
        }))
        .expect("fixture follow-ups"),
    );
    s.followups_open = true;
}

/// A turn that failed: its note and Retry.
pub fn agent_failed(s: &mut App) {
    agent(s);
    s.turn = Turn::Failed { message: "And what does setup take for a team of five?".into(), error: "The provider didn't answer. Your message was kept.".into() };
}

/// "Start a new chat" with one client record.
pub fn new_chat(s: &mut App) {
    agent(s);
    s.new_chat = Some(crate::state::NewChat { query: rune::TextEdit::new(""), clients: Load::Ready(vec![("c9".into(), "Harbor Dental".into())]) });
}

/// A reply with a generated view: metrics, a plan, progress, a table and buttons.
pub fn agent_ui(s: &mut App) {
    agent(s);
    let view = r#"{"title":"Pricing page plan","root":"r","elements":[
        {"id":"r","type":"column","gap":"md","children":["m","plan","t","acts"]},
        {"id":"m","type":"row","children":["m1","m2","m3"]},
        {"id":"m1","type":"metric","label":"Trial sign-ups","value":184,"trend":"up","hint":"Last 30 days"},
        {"id":"m2","type":"metric","label":"Answers that guess pricing","value":"3 of 5","trend":"down"},
        {"id":"m3","type":"metric","label":"Conversion","value":"3.1%","trend":"flat"},
        {"id":"plan","type":"card","title":"Next steps","children":["l","p","b1"]},
        {"id":"l","type":"list","items":[{"title":"Publish the pricing and setup page","detail":"Plans, prices and a one-day setup, from your approved facts","tone":"good"},{"title":"Fix the FAQ answer on integrations","detail":"Two assistants say Salesforce isn't supported","tone":"bad"},{"title":"Re-check AI answers next week","tone":"info"}]},
        {"id":"p","type":"progress","label":"Setup complete","value":0.6,"hint":"Search Console is not connected yet"},
        {"id":"b1","type":"badge","text":"Waiting for your approval","tone":"warn"},
        {"id":"t","type":"table","columns":["Assistant","Says","Correct"],"rows":[["ChatGPT","From $49 a month","No"],["Gemini","From $39 a month","Yes"],["Perplexity","Not stated","Unknown"]]},
        {"id":"acts","type":"row","gap":"sm","children":["a1","a2"]},
        {"id":"a1","type":"button","label":"Draft the page","action":{"type":"ask","prompt":"Draft the pricing and setup page from our approved facts."}},
        {"id":"a2","type":"button","label":"Open the current pricing","action":{"type":"open","url":"https://northstar.example/pricing"}}
    ]}"#;
    let text = format!("Here is the plan for the pricing page.\n\n```ui\n{view}\n```\n");
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.push(msg(json!({ "role": "user", "text": "Show me the plan for the pricing page." })));
        c.messages.push(msg(json!({ "role": "agent", "text": text })));
    }
}

/// A ```ui block the validator refuses: it shows as code.
pub fn agent_ui_invalid(s: &mut App) {
    agent(s);
    let text = "This view could not be drawn.\n\n```ui\n{\"root\":\"r\",\"elements\":[{\"id\":\"r\",\"type\":\"script\",\"src\":\"x\"}]}\n```\n";
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.push(msg(json!({ "role": "agent", "text": text })));
    }
}

/// A helper session open beside the conversation.
pub fn agent_helper(s: &mut App) {
    agent(s);
    let helper = Conversation {
        id: "s2".into(),
        title: Some("How others explain onboarding".into()),
        revision: 1,
        messages: vec![
            msg(json!({ "role": "user", "text": "Read how three similar products explain onboarding, and report what they promise about setup time.", "origin": { "kind": "task", "fromSessionId": "c1" } })),
            msg(json!({ "role": "agent", "text": "Two of the three promise setup in a day; one says a week with a call. All three show the steps on a single page.", "activity": [{ "kind": "tool", "tool": "read_web_pages", "text": "Read 3 onboarding pages" }], "durationMs": 21000 })),
        ],
        session: Some(crate::chat::SessionInfo { parent_session_id: Some("c1".into()), title: Some("How others explain onboarding".into()), role: Some("researcher".into()) }),
    };
    s.helper = Some(("s2".into(), Load::Ready(helper)));
}

/// An accepted draft in the chat's work pane.
pub fn agent_work(s: &mut App) {
    agent(s);
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.push(msg(json!({ "role": "user", "text": "Propose buyer questions to check." })));
        c.messages.push(msg(json!({ "role": "agent", "text": "I saved a set of buyer questions for you to review.", "decisions": [{ "type": "AGENT_PROPOSAL", "id": "p9" }] })));
    }
    s.proposals = Load::Ready(vec![serde_json::from_value(json!({
        "id": "p9", "kind": "PROPOSE_QUESTION_SET", "status": "APPROVED",
        "message": "Review buyer-question text. Acceptance does not freeze questions or assert authorization.",
        "payload": { "generatedAt": "2026-11-03T10:14:00.870Z", "text": "1. Which analytics tools integrate with Salesforce?\n2. What does Northstar cost for a team of five?\n3. How long does Northstar take to set up?", "references": [{ "kind": "web", "id": "https://northstar.example/pricing", "text": "Northstar pricing" }] }
    }))
    .expect("fixture proposal")]);
    s.drafts_open = true;
}

/// A reply with a diagram, drawn by Rune's Mermaid renderer.
pub fn agent_diagram(s: &mut App) {
    agent(s);
    let text = "Here is how a visitor becomes a trial.\n\n```mermaid\nflowchart LR\n  A[AI answer] --> B[Pricing page]\n  S[Search result] --> B\n  B --> C{Clear setup steps?}\n  C -- yes --> D[Trial sign-up]\n  C -- no --> E[Leaves]\n```\n\nThe pricing page is where most visitors decide.";
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.push(msg(json!({ "role": "user", "text": "How do visitors become trials?" })));
        c.messages.push(msg(json!({ "role": "agent", "text": text })));
    }
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
    s.insights = Load::Ready(insights());
}

fn section(s: &mut App, sec: Section) {
    overview(s);
    s.section = sec;
}

pub fn overview_answers(s: &mut App) {
    section(s, Section::Answers);
}

pub fn overview_performance(s: &mut App) {
    section(s, Section::Performance);
}

pub fn overview_revenue(s: &mut App) {
    section(s, Section::Revenue);
}

pub fn overview_funnel(s: &mut App) {
    section(s, Section::Funnel);
}

pub fn overview_answers_split(s: &mut App) {
    section(s, Section::Answers);
    s.metric = crate::state::Metric::Answers;
    s.split = true;
}

pub fn overview_answers_hover(s: &mut App) {
    section(s, Section::Answers);
    s.chart_hover = Some(("hero-trend".into(), 20));
}

pub fn overview_answers_share(s: &mut App) {
    section(s, Section::Answers);
    s.metric = crate::state::Metric::Wrong;
    s.split = true;
}

pub fn overview_events(s: &mut App) {
    section(s, Section::Events);
}

fn insights() -> Insights {
    let day = |i: i64| crate::format::iso_date(crate::format::now() - (30 - i) * 86_400);
    // A deterministic, gently rising month of checks.
    let wave = |i: i64, k: i64| ((i * 7 + k * 3) % 5) as i64;
    let daily: Vec<insights::Day> = (0..31)
        .map(|i| insights::Day {
            date: day(i),
            checks: 2,
            v: Verdicts { supported: 1 + wave(i, 0) / 2 + i / 10, wrong: wave(i, 1) / 3, partial: wave(i, 2) / 4, unknown: wave(i, 3) / 4, unreviewed: if i > 27 { 1 } else { 0 } },
        })
        .collect();
    let total = |f: fn(&Verdicts) -> i64| daily.iter().map(|d| f(&d.v)).sum::<i64>();
    let current = Verdicts { supported: total(|v| v.supported), wrong: total(|v| v.wrong), partial: total(|v| v.partial), unknown: total(|v| v.unknown), unreviewed: total(|v| v.unreviewed) };
    let analytics = Analytics {
        checks: 62,
        answers: current.total(),
        failed: 1,
        previous: Verdicts { supported: 31, wrong: 14, partial: 5, unknown: 6, unreviewed: 0 },
        prev_answers: 56,
        current,
        providers: vec![
            insights::Provider { name: "openai".into(), answers: 41, prev_answers: 30, v: Verdicts { supported: 28, wrong: 6, partial: 3, unknown: 4, unreviewed: 0 } },
            insights::Provider { name: "claude".into(), answers: 36, prev_answers: 26, v: Verdicts { supported: 29, wrong: 3, partial: 2, unknown: 1, unreviewed: 1 } },
            insights::Provider { name: "gemini".into(), answers: 22, prev_answers: 0, v: Verdicts { supported: 12, wrong: 6, partial: 2, unknown: 2, unreviewed: 0 } },
            insights::Provider { name: "perplexity".into(), answers: 14, prev_answers: 12, v: Verdicts { supported: 9, wrong: 2, partial: 1, unknown: 1, unreviewed: 0 } },
            insights::Provider { name: "deepseek".into(), answers: 6, prev_answers: 4, v: Verdicts { supported: 3, wrong: 2, partial: 0, unknown: 1, unreviewed: 0 } },
        ],
        provider_daily: (0..31)
            .flat_map(|i| {
                [("openai", 1 + wave(i, 0) / 2), ("claude", 1 + wave(i, 1) / 3), ("gemini", wave(i, 2) / 2), ("perplexity", wave(i, 3) / 3), ("deepseek", wave(i, 4) / 4)]
                    .into_iter()
                    .filter(|(_, n)| *n > 0)
                    .map(move |(p, n)| (day(i), p.to_string(), n))
            })
            .collect(),
        questions: vec![
            insights::Question { prompt: "How much does Northstar cost?".into(), checks: 12, last_checked: ago(60 * 3), v: Verdicts { supported: 5, wrong: 5, partial: 1, unknown: 1, unreviewed: 0 } },
            insights::Question { prompt: "Does Northstar integrate with Snowflake?".into(), checks: 10, last_checked: ago(60 * 26), v: Verdicts { supported: 7, wrong: 2, partial: 0, unknown: 1, unreviewed: 0 } },
            insights::Question { prompt: "Is Northstar SOC 2 compliant?".into(), checks: 8, last_checked: ago(60 * 50), v: Verdicts { supported: 8, wrong: 0, partial: 0, unknown: 0, unreviewed: 0 } },
        ],
        facts: vec![
            insights::FactRow { predicate: "monthly_price".into(), value: "From 49 USD a month".into(), v: Verdicts { supported: 6, wrong: 5, partial: 1, unknown: 0, unreviewed: 0 } },
            insights::FactRow { predicate: "integration".into(), value: "Snowflake, BigQuery and Postgres".into(), v: Verdicts { supported: 9, wrong: 2, partial: 0, unknown: 1, unreviewed: 0 } },
        ],
        citations: 48,
        attributed: 17,
        prev_citations: 35,
        citation_days: (0..31).map(|i| (day(i), 1 + wave(i, 2) / 2, wave(i, 4) / 3)).collect(),
        daily,
    };
    let reports = |r: Report| Source::Reports(vec![r]);
    let m = |l: &str, v: &str, d: Option<f64>| insights::Metric { label: l.into(), value: v.into(), delta: d };
    Insights {
        days: 30,
        analytics: Ok(analytics),
        goal: Ok(Some(insights::Goal {
            statement: "More trial sign-ups from people who asked an assistant about pricing.".into(),
            label: "Trial sign-ups".into(),
            event_name: Some("sign_up".into()),
            counting: "EVENT_COUNT".into(),
            time_zone: Some("America/New_York".into()),
            points: (0..61).map(|i| (crate::format::iso_date(crate::format::now() - (61 - i) * 86_400), (8 + (i * 5) % 7 + i / 6) as f64)).collect(),
            source: Some("GA4_AGGREGATE_EXPORT".into()),
        })),
        initiatives: vec![
            insights::Initiative { title: "Publish a transparent pricing and onboarding guide".into(), status: "APPROVED".into(), progress: "NOT_STARTED".into() },
            insights::Initiative { title: "Answer the questions buyers ask AI assistants".into(), status: "APPROVED".into(), progress: "EXECUTED".into() },
        ],
        health: insights::Health { sources: 5, in_sync: 4, drift: 1, inspected: true, open_findings: 3, urls_inspected: 12, verified_fixes: 1 },
        discovery: Ok(Some(insights::Discovery {
            period: Some(("ChatGPT search".into(), "38 of 40".into(), "21 of 38".into(), "9 of 38".into(), "2026-10-27 to 2026-11-09".into())),
            referral: Some("412 of 9,830 sessions, 2026-10-01 to 2026-10-31. 23 signups reported.".into()),
            limitations: vec![],
        })),
        search: reports(Report {
            title: "Google Search".into(),
            subtitle: "sc-domain:northstar.test, 2026-10-12 to 2026-11-08".into(),
            metrics: vec![m("Clicks", "1,284", Some(0.18)), m("Impressions", "48,210", Some(0.09)), m("Click-through rate", "3%", Some(0.08)), m("Average position", "11.4", None)],
            table: Some((
                vec!["Top queries".into(), "Clicks".into(), "Impressions".into(), "CTR".into()],
                vec![
                    vec!["northstar analytics".into(), "402".into(), "1,980".into(), "20%".into()],
                    vec!["northstar pricing".into(), "131".into(), "860".into(), "15%".into()],
                    vec!["snowflake dashboard tool".into(), "44".into(), "5,120".into(), "1%".into()],
                ],
            )),
            note: None,
        }),
        ads: Source::NotConnected("Connect Google Ads or Meta on the web to see spend, clicks and conversions.".into()),
        local: Source::NotConnected("Connect a Google Business Profile on the web to see calls, direction requests and reviews.".into()),
        revenue: reports(Report {
            title: "Stripe: Northstar Analytics".into(),
            subtitle: "2026-10-12 to 2026-11-08".into(),
            metrics: vec![m("Revenue (USD)", "$18,420.00", Some(0.12)), m("Paying customers", "214", Some(0.05)), m("New customers", "19", Some(-0.1))],
            table: None,
            note: None,
        }),
    }
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
        observation_id: format!("o-{id}"),
        verdict: match state {
            "WRONG" => Some("CONTRADICTED".into()),
            "PARTIAL" => Some("PARTIAL".into()),
            "UNKNOWN" => Some("INSUFFICIENT_EVIDENCE".into()),
            _ => None,
        },
        notes: None,
        facts: vec![],
        citation_evidence: vec![],
    };
    s.issues = Load::Ready(vec![
        issue("i1", "WRONG", "Northstar does not integrate with Salesforce.", "Does Northstar integrate with Salesforce?", "Northstar does not integrate with Salesforce. Teams usually export CSV files instead."),
        issue("i2", "PARTIAL", "Plans start at $49 a month.", "How much does Northstar cost?", "Northstar's plans start at $49 a month, with a free trial."),
        issue("i3", "UNKNOWN", "Setup takes about two weeks.", "How long does Northstar take to set up?", "Most teams report that setup takes about two weeks."),
        issue("i4", "NEEDS_REVIEW", "Northstar is SOC 2 certified.", "Is Northstar secure?", "Yes. Northstar is SOC 2 certified and encrypts data at rest."),
    ]);
}

fn answer_facts() -> Vec<crate::api::Fact> {
    let f = |id: &str, p: &str, v: &str| crate::api::Fact { id: id.into(), subject: "Northstar".into(), predicate: p.into(), value_text: v.into(), status: "ACTIVE".into(), version: 1 };
    vec![f("f1", "monthly_price", "39 USD"), f("f2", "integrations", "Salesforce, HubSpot, Slack"), f("f3", "setup_time", "One day")]
}

/// A wrong claim open, with its verdict, linked fact, sources and an action.
pub fn ai_answer(s: &mut App) {
    ai_answers(s);
    let mut issue = s.issues.ready().unwrap()[0].clone();
    issue.facts = vec![crate::api::IssueFact { id: "f2".into(), predicate: "integrations".into(), value_text: "Salesforce, HubSpot, Slack".into(), version: 1 }];
    issue.notes = Some("The integrations page was updated in March; the assistant is reading an old review.".into());
    issue.citation_evidence = vec![
        crate::api::CitationEvidence { uri: "https://www.example-reviews.test/northstar-2024".into(), title: Some("Northstar review (2024)".into()), attributed: true },
        crate::api::CitationEvidence { uri: "https://northstar.test/integrations".into(), title: None, attributed: false },
    ];
    let actions = vec![crate::api::Intervention {
        id: "a1".into(),
        kind: "THIRD_PARTY_CORRECTION_REQUESTED".into(),
        target: "https://www.example-reviews.test/northstar-2024".into(),
        performed_at: ago(60 * 2),
        notes: Some("Asked the editor to update the integrations section.".into()),
        supersedes_id: None,
    }];
    let mut a = crate::state::AnswerView::fixture(issue.claim_id.clone());
    a.detail = Load::Ready(crate::api::AnswerDetail { issue, facts: answer_facts(), actions });
    s.answer = Some(a);
}

/// An unreviewed claim open on the verdict form, one fact ticked.
pub fn ai_answer_review(s: &mut App) {
    ai_answers(s);
    let issue = s.issues.ready().unwrap()[3].clone();
    let mut a = crate::state::AnswerView::fixture(issue.claim_id.clone());
    a.reviewing = true;
    a.verdict = Some("INSUFFICIENT_EVIDENCE");
    a.facts.insert("f1".into());
    a.recording = true;
    a.detail = Load::Ready(crate::api::AnswerDetail { issue, facts: answer_facts(), actions: vec![] });
    s.answer = Some(a);
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
        ch("stripe", "Stripe", Some("Northstar Inc."), "CONNECTED", "Revenue and new customers, so results are counted in money."),
        ch("wordpress", "WordPress", None, "DISCOVERED", "Improve pages and publish posts, with your approval for each change."),
        ch("google_ads", "Google Ads", None, "PERMISSION_REQUIRED", "Spend and conversions from your campaigns."),
    ]);
}

pub fn collapsed(s: &mut App) {
    agent(s);
    s.sidebar_open = false;
}

pub fn account_update(s: &mut App) {
    inbox(s);
    s.update = crate::update::Update::Available(crate::update::Release { version: "0.2.0".into(), dmg_url: String::new(), page_url: String::new() });
    s.menu = Some(Menu::Account);
}

pub fn agent_find(s: &mut App) {
    agent(s);
    s.find = Some(crate::state::Find { query: rune::TextEdit::new(""), index: 0 });
}

pub fn business_menu(s: &mut App) {
    inbox(s);
    s.menu = Some(Menu::Businesses);
}
