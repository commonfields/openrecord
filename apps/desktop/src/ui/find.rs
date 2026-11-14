//! "Find…" (the web's `command-palette.tsx`): one keyboard-first jump list for
//! the workspace. F or ⌘K opens it; arrows move, Return goes, Escape closes.
//! Two separate cards float near the top of the window: the query field, and
//! the grouped results with their key hints. Claims and facts load only while
//! it is open. Navigation stays within the desktop.

use rune::{Cursor, El, ScrollSpec, col, el, row, text_input};

use crate::icons;
use crate::state::{App, Page, SettingsPage, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{ico, label};

/// Where a result goes.
#[derive(Clone)]
pub enum Go {
    View(View),
    Page(Page),
    Ask(String),
    AddBusiness,
    Settings,
    Business(String),
    Claim(String),
}

pub struct Item {
    pub group: String,
    pub label: String,
    pub hint: Option<String>,
    pub icon: &'static rune::Icon,
    pub keywords: String,
    /// A claim's state: its badge.
    pub badge: Option<String>,
    pub go: Go,
}

/// Every result, in the web's order: the business's pages, actions, the other
/// businesses, then its claims and approved facts.
fn items(s: &App) -> Vec<Item> {
    let mut out = Vec::new();
    let item = |group: &str, label: &str, icon: &'static rune::Icon, keywords: &str, go: Go| Item {
        group: group.into(), label: label.into(), hint: None, icon, keywords: keywords.into(), badge: None, go,
    };
    let bid = s.active.clone();
    if bid.is_some() {
        let name = s.active_business().map(|x| x.name.clone()).unwrap_or_else(|| "Workspace".into());
        let review = |topic: &str| Go::Ask(format!("Review {topic} for this business using the available tools. Show the evidence and what needs my attention."));
        let pages: [(&str, Go, &'static rune::Icon, &str); 11] = [
            ("Agent", Go::View(View::Agent), &icons::LAYOUT_GRID, "chat setup status plan report"),
            ("Channels", Go::Page(Page::Channels), &icons::GLOBE, "channels connect integrations google ads meta stripe wordpress analytics"),
            ("Work", Go::Page(Page::Campaigns), &icons::INBOX, "initiatives approvals executions campaigns"),
            ("Overview", Go::Page(Page::Overview), &icons::LAYOUT_GRID, "results today dashboard analytics overview"),
            ("AI answers", Go::Page(Page::AiAnswers), &icons::INBOX, "wrong answers review rate"),
            ("Facts on the web", review("facts on the web"), &icons::GLOBE, "representations sources drift in sync"),
            ("Approved facts", review("approved facts"), &icons::BOOK_CHECK, "truth facts approved"),
            ("AI answer checks", review("AI answer checks"), &icons::RADAR, "checks questions run"),
            ("Website checks", review("website checks"), &icons::SEARCH, "search website seo findings"),
            ("Prospect research", review("prospect research"), &icons::FLASK, "assay prospect"),
            ("Discover sources", review("source discovery"), &icons::TELESCOPE, "discovery scan"),
        ];
        for (label, go, icon, keywords) in pages {
            out.push(item(&name, label, icon, keywords, go));
        }
        out.push(item("Actions", "Run a check", &icons::RADAR, "ask ai question", review("AI answer checks")));
        if let Some(next) = s.issues.ready().and_then(|l| l.iter().find(|i| i.state == "NEEDS_REVIEW")) {
            out.push(Item { hint: Some("Oldest answers wait longest".into()), ..item("Actions", "Rate the next answer", &icons::MESSAGE_QUOTE, "", Go::Claim(next.claim_id.clone())) });
        }
    }
    out.push(item("Actions", "New business", &icons::PLUS, "set up add website", Go::AddBusiness));
    out.push(item("Actions", "Settings", &icons::SETTINGS, "", Go::Settings));
    out.push(item("Actions", "Inbox", &icons::FILE_CHECK, "waiting approve approvals decisions inbox proposals pending", Go::Page(Page::Inbox)));
    out.push(item("Actions", "Businesses and clients", &icons::BUILDING, "clients agency all", Go::Page(Page::Businesses)));
    for b in &s.businesses {
        if bid.as_deref() == Some(b.id.as_str()) {
            continue;
        }
        out.push(item("Switch business", &b.name, &icons::BUILDING, "", Go::Business(b.id.clone())));
    }
    if bid.is_some() {
        // Claims grouped by their text, the most frequent first (`groupClaims(…, "frequent")`).
        let mut groups: Vec<(String, Vec<&crate::api::Issue>)> = Vec::new();
        for i in s.issues.ready().map(|l| l.iter().collect::<Vec<_>>()).unwrap_or_default() {
            match groups.iter_mut().find(|(k, _)| k == &i.claim_text) {
                Some((_, list)) => list.push(i),
                None => groups.push((i.claim_text.clone(), vec![i])),
            }
        }
        groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        for (text, list) in groups {
            let latest = list[0];
            let target = list.iter().find(|o| o.state != "NEEDS_REVIEW").copied().unwrap_or(latest);
            let questions: Vec<String> = list.iter().filter_map(|o| o.question_prompt.clone()).collect();
            out.push(Item {
                hint: Some(format!("{}×", list.len())),
                badge: Some(latest.state.clone()),
                keywords: questions.join(" "),
                ..item("Answers", &text, &icons::MESSAGE_QUOTE, "", Go::Claim(target.claim_id.clone()))
            });
        }
        for f in s.find_facts.ready().map(|l| l.iter().collect::<Vec<_>>()).unwrap_or_default() {
            out.push(Item {
                hint: Some(format!("v{}", f.version)),
                keywords: f.subject.clone(),
                ..item("Approved facts", &format!("{}: {}", sentence(&f.predicate), f.value_text), &icons::BOOK_CHECK, "", Go::Ask(format!("Review this approved fact: {}: {} (version {}).", f.predicate, f.value_text, f.version)))
            });
        }
    }
    out
}

fn sentence(predicate: &str) -> String {
    let s = predicate.replace('_', " ");
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// What the query shows: with no query, everything but claims and facts, then
/// five claims; otherwise the items holding every word typed.
pub fn results(s: &App) -> Vec<Item> {
    let all = items(s);
    let q = s.find.as_ref().map(|f| f.query.text.trim().to_lowercase()).unwrap_or_default();
    if q.is_empty() {
        let (claims, rest): (Vec<Item>, Vec<Item>) = all.into_iter().filter(|i| i.group != "Approved facts").partition(|i| i.group == "Answers");
        return rest.into_iter().chain(claims.into_iter().take(5)).collect();
    }
    let words: Vec<&str> = q.split_whitespace().collect();
    all.into_iter()
        .filter(|i| {
            let hay = format!("{} {} {}", i.label, i.keywords, i.group).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .collect()
}

/// Goes where a result points, closing "Find…".
pub fn run(s: &mut App, go: Go, _tx: &mut rune::Tx) {
    s.find = None;
    match go {
        Go::View(v) => s.show_view(v),
        Go::Page(p) => s.show_page(p),
        Go::Settings => s.open_settings(SettingsPage::General),
        Go::Business(id) => {
            s.select_business(&id);
            s.show_view(View::Agent);
        }
        Go::Claim(id) => {
            s.show_page(Page::AiAnswers);
            s.open_answer(&id);
        }
        Go::Ask(prompt) => s.ask_agent(&prompt),
        Go::AddBusiness => s.open_add_business(None),
    }
}

/// Runs the highlighted result (Return in the field).
pub fn run_selected(s: &mut App, tx: &mut rune::Tx) {
    let Some(i) = s.find.as_ref().map(|f| f.index) else { return };
    if let Some(item) = results(s).into_iter().nth(i) {
        run(s, item.go, tx);
    }
}

/// Moves the highlight by `by`, within the results.
pub fn step(s: &mut App, by: i32) {
    let n = results(s).len();
    if let Some(f) = s.find.as_mut() {
        f.index = (f.index as i32 + by).clamp(0, n.saturating_sub(1) as i32) as usize;
    }
}

fn kbd(t: &Theme, k: &str) -> El {
    row().min_w(18.0).h(18.0).px(4.0).radius(4.0).center().fill(t.accent).border(1.0, t.border).child(label(k.to_string(), type_::XS2.lh(14.0), t.muted_foreground))
}

fn badge(t: &Theme, state: &str) -> El {
    let (text, ink) = match state {
        "NEEDS_REVIEW" => ("Needs review", t.muted_foreground),
        "CONTRADICTED" | "WRONG" => ("Wrong", t.wrong),
        "PARTIAL" | "UNCLEAR" => ("Unclear", t.muted_foreground),
        "SUPPORTED" | "CORRECT" => ("Correct", t.muted_foreground),
        other => (other, t.muted_foreground),
    };
    row().h(18.0).px(6.0).radius(4.0).center().fill(t.accent).child(label(text, type_::XS2.lh(14.0), ink))
}

/// The two floating cards, over a click-away layer.
pub fn layers(s: &App, t: &Theme, layer: &mut Vec<El>) {
    let Some(f) = &s.find else { return };
    let placeholder = s.active_business().map(|b| format!("Find in {}…", b.name)).unwrap_or_else(|| "Find…".into());
    let input = text_input(&f.query, type_::SM)
        .key("find-query")
        .placeholder(placeholder, t.muted_foreground)
        .label("Find")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| {
            let f = s.find.as_mut().expect("find open");
            f.index = 0;
            &mut f.query
        })
        .on_submit(|s: &mut App, tx| run_selected(s, tx));
    let field = shadows(
        row().w_full().h(44.0).px(12.0).gap(10.0).radius(8.0).center_y().fill(t.sidebar).border(1.0, t.border)
            .child(ico(&icons::SEARCH, 16.0, t.muted_foreground))
            .child(col().grow(1.0).min_w(0.0).child(input))
            .child(kbd(t, "Esc")),
        &t.float_shadow,
    );

    let list = results(s);
    let q = f.query.text.trim().to_string();
    let mut body = col().key("find-results").w_full().padding(6.0);
    if list.is_empty() {
        body = body.child(row().w_full().py(32.0).justify_center().child(label(format!("Nothing matches \u{201c}{q}\u{201d}."), type_::XS, t.muted_foreground)));
    }
    let mut group: Option<String> = None;
    for (i, item) in list.iter().enumerate() {
        if group.as_deref() != Some(item.group.as_str()) {
            group = Some(item.group.clone());
            body = body.child(label(item.group.clone(), type_::XS2.lh(14.0), t.muted_foreground).px(10.0).pt(8.0).pb(4.0));
        }
        let on = i == f.index;
        let go = item.go.clone();
        let mut r = row()
            .key(format!("find-{i}"))
            .w_full()
            .min_h(30.0)
            .px(10.0)
            .gap(10.0)
            .radius(6.0)
            .center_y()
            .role("option")
            .label(item.label.clone())
            .checked(on)
            .cursor(Cursor::Pointer)
            .on_hover_change(move |s: &mut App, inside, _tx| {
                if inside {
                    if let Some(f) = s.find.as_mut() {
                        f.index = i;
                    }
                }
            })
            .on_press_tx(move |s: &mut App, tx| run(s, go.clone(), tx))
            .child(ico(item.icon, 16.0, t.muted_foreground))
            .child(label(item.label.clone(), type_::XS_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0));
        if let Some(b) = &item.badge {
            r = r.child(badge(t, b));
        }
        if let Some(h) = &item.hint {
            r = r.child(label(h.clone(), type_::XS.features("'tnum' 1"), t.muted_foreground));
        }
        // The chat's "/" menu highlight: the accent fill and control shadow ease in
        // under the pointer or the arrows. The ↵ mark is always there, only shown on
        // the highlighted row, so nothing shifts as the highlight moves.
        r = r.child(row().size(14.0, 14.0).center().opacity(if on { 1.0 } else { 0.0 }).motion(crate::ui::widgets::HOVER).child(ico(&icons::CORNER_DOWN_LEFT, 14.0, t.muted_foreground)));
        body = body.child(crate::ui::widgets::highlight(t, r, on, false));
    }
    let footer = row()
        .w_full()
        .px(16.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .fill(t.sidebar_accent.alpha(0.4))
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(row().gap(4.0).center_y().child(kbd(t, "↑")).child(kbd(t, "↓")).child(label("move", type_::XS11, t.muted_foreground)))
        .child(row().gap(4.0).center_y().child(kbd(t, "↵")).child(label("open", type_::XS11, t.muted_foreground)))
        .child(el().grow(1.0))
        .child(row().gap(4.0).center_y().child(kbd(t, "F")).child(label("or", type_::XS11, t.muted_foreground)).child(kbd(t, "⌘K")).child(label("anywhere", type_::XS11, t.muted_foreground)));
    let menu = shadows(
        col().w_full().radius(8.0).fill(t.sidebar).border(1.0, t.border).clip_rounded(8.0)
            .child(col().key("find-scroll").w_full().max_h(448.0).child(body).scroll(ScrollSpec { stick_bottom: false }))
            .child(footer),
        &t.float_shadow,
    );
    let panel = col().key("find").role("dialog").label("Find in OpenRecord").w_full().max_w(768.0).gap(6.0).child(field).child(menu);
    layer.push(
        col().key("find-layer").absolute(0.0, 0.0).w_full().h_full().pt(96.0).px(12.0).items_center()
            .on_press(|s: &mut App| s.find = None)
            .child(panel.on_press(|_s: &mut App| {})),
    );
}
