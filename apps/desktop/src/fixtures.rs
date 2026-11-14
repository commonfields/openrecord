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

/// Home with the decisions stack spread under the pointer.
pub fn notices_open(s: &mut App) {
    agent_empty(s);
    s.notices_open = true;
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

/// The agent open beside the Overview, with a request typed in.
pub fn overview_agent(s: &mut App) {
    overview(s);
    s.chat_id = Some("c1".into());
    s.catalog = Load::Ready(models());
    s.agent_model = Some("i1:claude-sonnet-5-5".into());
    s.conversation = Load::Ready(Conversation { id: "c1".into(), title: Some("Next step for the pricing page".into()), revision: 2, messages: chat_messages(), session: None });
    s.open_pane(Some("Why did visits from AI assistants dip last week?"));
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

pub fn overview_realtime(s: &mut App) {
    section(s, Section::Realtime);
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
    // Twenty-eight days with a weekly rhythm, the period before a step lower.
    let series = |l: &str, d: Option<f64>| {
        let seed = l.len() as f64;
        let day = |i: usize, k: f64| Some((100.0 * k * (1.0 + 0.18 * ((i as f64 + seed) / 3.1).sin() + if i % 7 >= 5 { -0.3 } else { 0.05 } + i as f64 * 0.004)).max(0.0));
        let k = 1.0 + d.unwrap_or(0.0);
        insights::Days {
            dates: (0..28).map(|i| crate::format::iso_date(crate::format::now() - (31 - i as i64) * 86_400)).collect(),
            now: (0..28).map(|i| day(i, k)).collect(),
            before: (0..28).map(|i| day(i, 1.0)).collect(),
        }
    };
    let m = |l: &str, v: &str, d: Option<f64>| insights::Metric { label: l.into(), value: v.into(), delta: d, days: Some(series(l, d)), ..Default::default() };
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
            referral: Some((412.0, 9830.0, "2026-10-01 to 2026-10-31".into(), Some(23.0))),
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
            detail: insights::Detail::Search {
                queries: [
                    ("northstar analytics", 402.0, 1980.0, 1.2),
                    ("northstar pricing", 131.0, 860.0, 1.8),
                    ("ai answer monitoring", 96.0, 7420.0, 8.6),
                    ("snowflake dashboard tool", 44.0, 5120.0, 12.4),
                    ("brand mentions in chatgpt", 38.0, 6310.0, 9.1),
                    ("how to track ai search visibility", 27.0, 4880.0, 14.7),
                    ("northstar vs looker", 21.0, 640.0, 4.2),
                    ("generative engine optimization tool", 12.0, 3920.0, 22.5),
                ]
                .iter()
                .map(|(k, c, i, p)| insights::SearchRow { key: k.to_string(), clicks: *c, impressions: *i, ctr: c / i, position: Some(*p) })
                .collect(),
                pages: [
                    ("/", 488.0, 9200.0, 4.1),
                    ("/pricing", 214.0, 3100.0, 3.2),
                    ("/blog/how-assistants-pick-sources", 176.0, 14200.0, 9.8),
                    ("/integrations/snowflake", 92.0, 6800.0, 11.3),
                    ("/docs/quickstart", 61.0, 2400.0, 6.5),
                ]
                .iter()
                .map(|(k, c, i, p)| insights::SearchRow { key: k.to_string(), clicks: *c, impressions: *i, ctr: c / i, position: Some(*p) })
                .collect(),
            },
        }),
        ads: reports({
            let t = |spend: f64, impressions: f64, clicks: f64, conversions: f64, value: f64| insights::AdTotals {
                spend,
                impressions,
                clicks,
                conversions,
                value,
                ctr: Some(clicks / impressions),
                cpc: Some(spend / clicks),
                cpa: (conversions > 0.0).then(|| spend / conversions),
                roas: Some(value / spend),
            };
            Report {
                title: "Google Ads: Northstar".into(),
                subtitle: "2026-10-12 to 2026-11-08".into(),
                metrics: vec![m("Spend", "$2,140.00", Some(0.06)), m("Clicks", "1,912", Some(0.11)), m("Conversions", "64.0", Some(0.16)), insights::Metric { lower_better: true, ..m("Cost per conversion", "$33.44", Some(-0.09)) }],
                table: None,
                note: Some("Conversions as this platform counts them: Trial sign-up (website, 30-day click).".into()),
                detail: insights::Detail::Ads(insights::AdDetail {
                    provider: "Google Ads".into(),
                    currency: "USD".into(),
                    now: t(2140.0, 61200.0, 1912.0, 64.0, 5180.0),
                    before: t(2020.0, 58800.0, 1722.0, 55.0, 4310.0),
                    campaigns: vec![
                        ("Brand search".into(), Some("ENABLED".into()), t(420.0, 6100.0, 840.0, 31.0, 2480.0)),
                        ("AI visibility, non-brand".into(), Some("ENABLED".into()), t(980.0, 31800.0, 702.0, 22.0, 1760.0)),
                        ("Competitor terms".into(), Some("ENABLED".into()), t(510.0, 14900.0, 268.0, 9.0, 720.0)),
                        ("Display retargeting".into(), Some("PAUSED".into()), t(230.0, 8400.0, 102.0, 2.0, 220.0)),
                    ],
                }),
            }
        }),
        local: reports(Report {
            title: "Google Business Profile: Northstar HQ".into(),
            subtitle: "2026-10-12 to 2026-11-08".into(),
            metrics: vec![m("Calls", "38", Some(0.12)), m("Website clicks", "214", Some(0.2)), m("Direction requests", "17", Some(-0.06)), m("Profile views", "3,940", Some(0.08))]
                .into_iter()
                .map(|x| insights::Metric { days: None, ..x })
                .collect(),
            table: None,
            note: Some("26 reviews, average 4.6, 2 unanswered.".into()),
            detail: insights::Detail::Local(insights::LocalDetail {
                now: insights::LocalTotals { calls: 38.0, website: 214.0, directions: 17.0, bookings: 6.0, conversations: 4.0, views: 3940.0, search: 2810.0, maps: 1130.0 },
                before: insights::LocalTotals { calls: 34.0, website: 178.0, directions: 18.0, bookings: 3.0, conversations: 5.0, views: 3650.0, search: 2560.0, maps: 1090.0 },
                terms: Some(("2026-10".into(), vec![("northstar analytics".into(), 820.0, false), ("analytics software".into(), 310.0, false), ("ai visibility tool".into(), 140.0, false), ("dashboard consultants".into(), 15.0, true)])),
                reviews: Some(insights::Reviews {
                    average: Some(4.6),
                    total: 26.0,
                    unanswered: 2.0,
                    in_window: 4.0,
                    recent: vec![
                        (Some(5.0), "Set up in an afternoon and the pricing page finally matches what ChatGPT says about us.".into(), "2026-11-04T10:00:00Z".into(), true),
                        (Some(4.0), "Good product, the onboarding call was very helpful.".into(), "2026-10-28T10:00:00Z".into(), false),
                        (Some(3.0), "Works, but the Snowflake connector took a while to configure.".into(), "2026-10-19T10:00:00Z".into(), false),
                    ],
                }),
            }),
        }),
        revenue: reports(Report {
            title: "Stripe: Northstar Analytics".into(),
            subtitle: "2026-10-12 to 2026-11-08".into(),
            metrics: vec![m("Revenue (USD)", "$18,420.00", Some(0.12)), m("Paying customers", "214", Some(0.05)), m("New customers", "19", Some(-0.1))],
            table: None,
            note: None,
            detail: insights::Detail::None,
        }),
        realtime: Some(crate::insights::Realtime {
            active: 47.0,
            visitors: Some(312.0),
            views: Some(846.0),
            events: Some(129.0),
            activity: [("Trial sign-up", "/pricing", 0.0), ("page_view", "/integrations", 1.0), ("page_view", "/pricing", 1.0), ("cta_click", "/", 2.0), ("Newsletter sign-up", "/blog/how-assistants-pick-sources", 3.0), ("page_view", "/docs/quickstart", 4.0), ("page_view", "/", 5.0)]
                .iter()
                .map(|(e, p, m)| (e.to_string(), p.to_string(), *m))
                .collect(),
            countries: [("US", "United States", 15.0), ("GB", "United Kingdom", 7.0), ("DE", "Germany", 5.0), ("IN", "India", 4.0), ("ID", "Indonesia", 4.0), ("CA", "Canada", 3.0), ("BR", "Brazil", 3.0), ("AU", "Australia", 2.0), ("FR", "France", 2.0), ("JP", "Japan", 1.0), ("SG", "Singapore", 1.0)]
                .iter().map(|(c, n, u)| (c.to_string(), n.to_string(), *u)).collect(),
            pages: vec![("Home".into(), 16.0), ("Pricing".into(), 10.0), ("How assistants pick sources".into(), 7.0), ("Quickstart".into(), 5.0), ("Integrations".into(), 3.0)],
            per_minute: (0..30).map(|i| (5.0 + 2.5 * (i as f64 / 3.3).sin().abs()).round()).collect(),
        }),
        revenue_data: Some({
            // Thirty days with a weekly rhythm and a gentle climb.
            let day = |i: usize, k: f64| {
                let wave = 1.0 + 0.25 * (i as f64 / 2.2).sin() + if i % 7 >= 5 { -0.45 } else { 0.1 };
                (2.6 * k * wave * (0.85 + i as f64 / 30.0 * 0.3)).round().max(0.0) * 59.7
            };
            let daily: Vec<(String, f64)> = (0..30).map(|i| (crate::format::iso_date(crate::format::now() - (30 - i as i64) * 86_400), day(i, 1.21))).collect();
            let before: Vec<f64> = (0..30).map(|i| day(i, 1.0)).collect();
            let net = daily.iter().map(|d| d.1).sum::<f64>();
            let prev = before.iter().sum::<f64>();
            crate::insights::RevenueData {
                account: "Northstar Analytics".into(),
                subtitle: "Last 30 days".into(),
                currency: "USD".into(),
                net: (net, prev),
                gross: (net / 0.97, prev / 0.97),
                refunded: (net / 0.97 - net, prev / 0.97 - prev),
                orders: ((net / 59.7).round(), (prev / 59.7).round()),
                average: (Some(59.7), Some(59.1)),
                paying: (81.0, 67.0),
                new_customers: (Some(37.0), Some(31.0)),
                daily,
                currencies: vec![("USD".into(), net, net / 0.97, net / 0.97 - net, (net / 59.7).round(), Some(prev)), ("EUR".into(), 1240.0, 1290.0, 50.0, 22.0, Some(1010.0))],
                before,
                note: None,
            }
        }),
    }
}

pub fn campaigns(s: &mut App) {
    page(s, Page::Campaigns);
    let today = |d: i64| crate::format::iso_date(crate::format::now() + d * 86_400);
    let task = |title: &str, owner: &str, due: i64, channel: &str, status: &str| crate::api::CampaignTask {
        id: format!("task-{title}"),
        note: String::new(),
        title: title.into(),
        owner: owner.into(),
        due: today(due),
        channel: channel.into(),
        status: status.into(),
    };
    s.campaigns = Load::Ready(vec![
        Campaign {
            id: "cp1".into(),
            revision: 4,
            title: "Pricing guide launch".into(),
            status: "ACTIVE".into(),
            goal: "More trial sign-ups from people who asked an assistant about pricing.".into(),
            audience: "Data leads at 50 to 500 person SaaS companies comparing analytics tools.".into(),
            offer: "A transparent pricing and onboarding guide, with a 14-day trial.".into(),
            message: "Know what you'll pay before you talk to sales.".into(),
            hypothesis: "If assistants quote our real price, more pricing-question visitors start a trial.".into(),
            metric: "Trial sign-ups (GA4 sign_up)".into(),
            baseline: "9 a day over the last 30 days".into(),
            target: "12 a day by the review".into(),
            owner: "Maya".into(),
            launch_date: today(-12),
            review_date: today(9),
            tasks: vec![
                task("Publish the pricing guide", "Maya", -10, "WEBSITE", "DONE"),
                task("Update pricing facts on the site", "Agent", -8, "WEBSITE", "DONE"),
                task("Email the trial list", "Sam", -3, "EMAIL", "DONE"),
                task("Brand search ads with the new price", "Sam", 2, "PAID", "IN_PROGRESS"),
                task("LinkedIn carousel", "Ana", 5, "SOCIAL", "TODO"),
            ],
            decision: "UNDECIDED".into(),
            channel: "Website and search".into(),
            motion: "HYBRID".into(),
            funnel_stage: "CONVERSION".into(),
            budget: "$1,500".into(),
            cadence: "Weekly check-in".into(),
            conversion_event: "sign_up".into(),
            tracking_plan: "GA4 sign_up with utm_campaign=pricing-guide".into(),
            updated_at: ago(60 * 5),
            created_by: "ASSISTANT".into(),
            ..Default::default()
        },
        Campaign {
            id: "cp2".into(),
            revision: 2,
            title: "Snowflake integration week".into(),
            status: "REVIEW".into(),
            goal: "Win searches for Snowflake dashboards.".into(),
            audience: "Analytics engineers on Snowflake.".into(),
            offer: "Free dashboard templates.".into(),
            message: "Dashboards on Snowflake in ten minutes.".into(),
            hypothesis: "Templates rank for snowflake dashboard queries.".into(),
            metric: "Search clicks to /integrations/snowflake".into(),
            baseline: "60 clicks a month".into(),
            target: "150 clicks a month".into(),
            owner: "Ana".into(),
            launch_date: today(-40),
            review_date: today(-2),
            tasks: vec![task("Template gallery page", "Ana", -35, "WEBSITE", "DONE"), task("Partner newsletter", "Sam", -30, "EMAIL", "DONE"), task("Webinar recap post", "Ana", -20, "SOCIAL", "BLOCKED")],
            decision: "UNDECIDED".into(),
            channel: "Organic search".into(),
            motion: "OWNED".into(),
            funnel_stage: "CONSIDERATION".into(),
            updated_at: ago(60 * 30),
            created_by: "OPERATOR".into(),
            ..Default::default()
        },
        Campaign {
            id: "cp3".into(),
            revision: 1,
            title: "Answer the questions buyers ask AI assistants".into(),
            status: "DRAFT".into(),
            goal: "Correct answers about SOC 2 and pricing in ChatGPT and Perplexity.".into(),
            audience: "Security reviewers and buyers asking assistants.".into(),
            owner: "Maya".into(),
            tasks: vec![task("FAQ page with sourced answers", "", 0, "WEBSITE", "TODO")],
            decision: "UNDECIDED".into(),
            funnel_stage: "AWARENESS".into(),
            motion: "EARNED".into(),
            updated_at: ago(60 * 50),
            created_by: "ASSISTANT".into(),
            ..Default::default()
        },
        Campaign {
            id: "cp4".into(),
            revision: 6,
            title: "Q3 webinar series".into(),
            status: "CLOSED".into(),
            goal: "Pipeline from mid-market data teams.".into(),
            metric: "Demo requests".into(),
            baseline: "20 a month".into(),
            target: "35 a month".into(),
            owner: "Sam".into(),
            launch_date: today(-120),
            review_date: today(-60),
            tasks: vec![task("Three webinars", "Sam", -90, "OTHER", "DONE"), task("Follow-up sequence", "Sam", -80, "EMAIL", "DONE")],
            result: "31 demo requests a month at the peak; attendance fell after the second session.".into(),
            decision: "CHANGE".into(),
            learning: "Shorter, single-topic sessions held attendance better.".into(),
            next_move: "Run two 20-minute sessions on pricing questions.".into(),
            funnel_stage: "CONSIDERATION".into(),
            motion: "OWNED".into(),
            updated_at: ago(60 * 24 * 40),
            created_by: "OPERATOR".into(),
            ..Default::default()
        },
    ]);
}

pub fn campaign_open(s: &mut App) {
    campaigns(s);
    s.campaign_open = s.campaigns.ready().and_then(|l| l.first().map(|c| c.id.clone()));
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
    s.channel_status = Load::Ready(crate::channel_status::Status {
        measure: vec![
            crate::channel_status::read_search_console(&serde_json::json!({ "configured": true, "binding": { "siteUrl": "sc-domain:northstar.test" }, "connections": [] })),
            crate::channel_status::Row { key: "revenue", mark: "stripe", title: "Stripe", purpose: "Revenue and new customers, so results are counted in money.", identity: None, state: Some(crate::channel_status::State::Available) },
        ],
        ads: crate::channel_status::read_ads(&serde_json::json!({ "providers": { "google_business": { "configured": false }, "google_ads": { "configured": true }, "meta": { "configured": true } },
            "connections": [{ "provider": "meta", "status": "ACTIVE" }], "bindings": [{ "provider": "google_ads", "name": "Northstar Ads" }] })),
        website: vec![crate::channel_status::Row { key: "wordpress", mark: "wordpress", title: "WordPress", purpose: "Improve pages and publish posts, with your approval for each change.", identity: None, state: Some(crate::channel_status::State::Reconnect) }],
    });
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

pub fn account_menu(s: &mut App) {
    inbox(s);
    s.menu = Some(Menu::Account);
}

pub fn usage(s: &mut App) {
    page(s, Page::Usage);
    let day = |i: i64| crate::format::iso_date(crate::format::now() - (29 - i) * 86_400);
    let model = |p: &str, m: &str, turns: f64, i: f64, o: f64, usd: Option<f64>| crate::account::ModelUse {
        provider: p.into(),
        model: m.into(),
        turns,
        tokens_in: Some(i),
        tokens_out: Some(o),
        usd,
        priced: usd.is_some(),
    };
    s.usage = Load::Ready(crate::account::Usage {
        days: 30,
        turns: 412.0,
        tool_calls: 2_380.0,
        model_steps: 1_904.0,
        tokens: Some(18_400_000.0),
        tokens_in: Some(16_900_000.0),
        tokens_out: Some(1_500_000.0),
        without_counts: 0.0,
        usd: Some(41.37),
        unpriced: 12.0,
        by_model: vec![model("anthropic", "claude-opus-5-5", 288.0, 12_100_000.0, 1_020_000.0, Some(36.2)), model("openai", "gpt-5.2", 112.0, 4_600_000.0, 430_000.0, Some(5.17)), model("9router", "kimi-k2", 12.0, 200_000.0, 50_000.0, None)],
        by_business: vec![("Northstar Analytics".into(), 301.0, Some(13_900_000.0), 1_810.0), ("Harbor Coffee".into(), 88.0, Some(3_700_000.0), 470.0), ("General".into(), 23.0, Some(800_000.0), 100.0)],
        daily: (0..30).map(|i| (day(i), (8.0 + 9.0 * ((i as f64) / 3.0).sin().abs() + if i % 7 >= 5 { -5.0 } else { 3.0 }).max(0.0).round())).collect(),
        research_calls: 640.0,
        research_usd: 3.84,
        research: vec![("Web search".into(), 410.0, 6.0, 120.0, 2.4), ("Search Console".into(), 160.0, 0.0, 0.0, 0.0), ("Page reader".into(), 70.0, 2.0, 72.0, 1.44)],
        answers: 119.0,
        checks: vec![("OpenAI".into(), 41.0), ("Claude".into(), 36.0), ("Gemini".into(), 22.0), ("Perplexity".into(), 14.0), ("DeepSeek".into(), 6.0)],
        note: "Token counts are as each provider reported them. Estimated cost is not a bill.".into(),
    });
}

pub fn businesses(s: &mut App) {
    page(s, Page::Businesses);
    let o = |c: i64, last: Option<i64>, u: i64, a: i64| crate::api::Overview { completed: c, last_checked: last.and_then(ago), unreviewed: u, needs_attention: a };
    let v = |sup: i64, w: i64, p: i64| Some(Verdicts { supported: sup, wrong: w, partial: p, unknown: 1, unreviewed: 0 });
    let days = |k: f64| (0..30).map(|i| ((i as f64 * 0.7 + k).sin().abs() * 6.0).round()).collect::<Vec<_>>();
    s.portfolio = Load::Ready(
        s.businesses
            .iter()
            .enumerate()
            .map(|(k, b)| crate::account::Portfolio {
                id: b.id.clone(),
                name: b.name.clone(),
                overview: Some(o(40, if k == 2 { None } else { Some(60 * (k as i64 + 1) * 7) }, k as i64 % 3, (3 - k as i64).max(0))),
                verdicts: if k == 2 { None } else { v(80 - 10 * k as i64, 10 + 4 * k as i64, 6) },
                per_day: days(k as f64),
            })
            .collect(),
    );
}

pub fn clients(s: &mut App) {
    page(s, Page::Clients);
    let c = |id: &str, name: &str, web: &str, shared: bool, goal: Option<&str>, ideas: usize, approved: usize, verified: usize| crate::account::ClientRow {
        id: id.into(),
        name: name.into(),
        website: web.into(),
        shared,
        known: true,
        goal: goal.map(str::to_string),
        metric: goal.map(|_| "Trial sign-ups".to_string()),
        ideas,
        approved,
        verified,
    };
    s.client_rows = Load::Ready(vec![
        c("b1", "Northstar Analytics", "https://northstar.test", true, Some("More trial sign-ups"), 6, 3, 1),
        c("b2", "Harbor Coffee", "https://harbor.coffee", false, Some("More online orders"), 2, 0, 0),
        c("b3", "Atlas Legal", "https://atlas.legal", false, None, 0, 0, 0),
    ]);
}

pub fn collapsed_peek(s: &mut App) {
    collapsed(s);
    s.sidebar_peek = true;
}

pub fn add_business(s: &mut App) {
    businesses(s);
    s.open_add_business(None);
}

/// A reply with a generated series view (cash over time and what moved it).
pub fn agent_series(s: &mut App) {
    agent(s);
    let day = |i: i64| crate::format::iso_date(crate::format::now() - (30 - i) * 86_400);
    let values = [372000.0, 372000.0, 418000.0, 418000.0, 418000.0, 418000.0, 418000.0, 351200.0, 351200.0, 349800.0, 349800.0, 349800.0, 351000.0, 351000.0, 374900.0, 374900.0, 369083.06, 369083.06, 369083.06, 369083.06, 411283.41, 411283.41, 413600.0, 413600.0, 336400.0, 336400.0, 389700.0, 389700.0, 389700.0, 395100.0, 395100.0];
    let points: Vec<String> = values.iter().enumerate().map(|(i, v)| format!(r#"{{"date":"{}","value":{v}}}"#, day(i as i64))).collect();
    let view = format!(
        r#"{{"root":"s","elements":[{{"id":"s","type":"series","unit":"money","currency":"USD","points":[{}],"items":[{{"label":"Larkspur Hotels","amount":41200}},{{"label":"Shop payout","amount":2340.35}},{{"label":"9 card purchases","amount":-2011.05,"muted":true}}]}}]}}"#,
        points.join(",")
    );
    let text = format!("Here's where your cash stands.\n\n```ui\n{view}\n```\n");
    if let Load::Ready(c) = &mut s.conversation {
        c.messages.clear();
        c.messages.push(msg(json!({ "role": "user", "text": "Where's our cash right now?" })));
        c.messages.push(msg(json!({ "role": "agent", "text": text, "activity": [{ "kind": "tool", "tool": "get_cash_position", "text": "Read the cash position" }], "durationMs": 4200 })));
    }
    s.chart_hover = Some(("surface-1-1-s".into(), 20));
}

/// An artifact opens alongside the conversation, without covering it.
pub fn agent_artifact(s: &mut App) {
    agent(s);
    let content = "# A clearer path to your next campaign\n\nOne team, one plan, and a record of what shipped.\n\n## This week\n\n- Review the landing page\n- Connect the measurement account\n- Agree the launch date\n\n**Draft for review.** Nothing is published.";
    s.artifact = Some(crate::artifacts::Pane { business: s.active.clone().unwrap(), id: "fixture-artifact".into(), requested: None,
        loaded: Load::Ready(crate::artifacts::Artifact { id: "fixture-artifact".into(), title: "Campaign brief".into(), format: "MARKDOWN".into(), content: content.into(), preview_html: "<!doctype html><html><body><h1>A clearer path to your next campaign</h1><p>Draft for review.</p></body></html>".into(), version: 2, shown_version: 2,
            versions: vec![crate::artifacts::Version { version: 2, title: "Campaign brief".into() }, crate::artifacts::Version { version: 1, title: "First brief".into() }] }),
        source: false });
}
pub fn channels_wordpress(s: &mut App) {
    channels(s);
    s.channel_setup = Some(crate::channel_setup::Setup { generation: 1, business: s.active.clone().unwrap(), kind: crate::channel_setup::Kind::WordPress,
        loaded: Load::Ready(crate::channel_setup::Detail { configured: true, connected: false, choices: vec![], warning: None }),
        site: rune::TextEdit::new("https://northstar.test"), username: rune::TextEdit::new(""), secret: rune::TextEdit::new("").secure(),
        busy: false, authorizing: false, error: None, confirming_disconnect: false });
}
pub fn channels_google(s: &mut App) {
    channels(s);
    s.channel_setup = Some(crate::channel_setup::Setup { generation: 1, business: s.active.clone().unwrap(), kind: crate::channel_setup::Kind::Google,
        loaded: Load::Ready(crate::channel_setup::Detail { configured: true, connected: true, warning: None, choices: vec![
            crate::channel_setup::Choice { connection: "fixture-google".into(), id: "sc-domain:northstar.test".into(), title: "northstar.test (whole domain)".into(), bound: true },
            crate::channel_setup::Choice { connection: "fixture-google".into(), id: "sc-domain:northstar.test".into(), title: "northstar.test · Marketing team".into(), bound: false },
        ] }), site: rune::TextEdit::new(""), username: rune::TextEdit::new(""), secret: rune::TextEdit::new("").secure(),
        busy: false, authorizing: false, error: None, confirming_disconnect: false });
}
