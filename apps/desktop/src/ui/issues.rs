//! AI answers, as the web's `routes/issues.tsx` lays it out: the AI discovery
//! summary, the totals by state (each a filter), a prompt to rate what is
//! waiting, then one panel with the "By claim" and "Every answer" views, a
//! search, the model, fact and sort pickers, and the rows.

use std::collections::BTreeMap;

use rune::{Align, Color, Cursor, El, Side, col, el, row, text_input};

use crate::api::Issue;
use crate::brands;
use crate::format;
use crate::icons;
use crate::state::{App, IssueQuery, Load, Menu};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, Variant, button, empty_state, failure, ico, label, page_header, skeleton};

const PAGE_SIZE: usize = 25;
const XS11_MEDIUM: rune::TextStyle = rune::TextStyle::new(11.0, 500.0).lh(16.0);
const XS_SEMIBOLD: rune::TextStyle = rune::TextStyle::new(12.0, 600.0).lh(16.0);
const FILTERS: [&str; 5] = ["ALL", "NEEDS_REVIEW", "WRONG", "PARTIAL", "UNKNOWN"];

/// A state's colour, soft fill and words, as the web's `issueStateMeta`.
pub fn tone(t: &Theme, state: &str) -> (Color, Color, &'static str) {
    match state {
        "WRONG" => (t.wrong, t.wrong_soft, "Wrong"),
        "PARTIAL" => (t.partial, t.partial_soft, "Partly right"),
        "UNKNOWN" => (t.unknown, t.unknown_soft, "Can't tell"),
        _ => (t.review, t.review_soft, "Not rated yet"),
    }
}

fn badge(t: &Theme, state: &str) -> El {
    let (ink, soft, name) = tone(t, state);
    let icon = match state {
        "WRONG" => &icons::CIRCLE_X,
        "PARTIAL" => &icons::CIRCLE_ALERT,
        "UNKNOWN" => &icons::CIRCLE_HELP,
        _ => &icons::CIRCLE_DASHED,
    };
    crate::ui::widgets::badge(t, name, ink, soft, Some(icon))
}

fn severity(state: &str) -> u8 {
    match state {
        "WRONG" => 0,
        "PARTIAL" => 1,
        "UNKNOWN" => 2,
        _ => 3,
    }
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn time(i: &Issue) -> i64 {
    i.collected_at.as_deref().and_then(format::parse_iso).unwrap_or(0)
}

fn sentence(s: &str) -> String {
    let lower = s.replace('_', " ").to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// The sort in force: what was picked, else most repeated for claims and newest for answers.
fn sort_of(q: &IssueQuery) -> &str {
    if q.sort.is_empty() { if q.answers { "recent" } else { "frequent" } } else { q.sort.as_str() }
}

/// The filters other than state (`matchesQuery`).
fn matches(i: &Issue, q: &IssueQuery) -> bool {
    if q.provider != "all" && i.provider != q.provider {
        return false;
    }
    if q.fact == "none" && !i.facts.is_empty() {
        return false;
    }
    if q.fact != "all" && q.fact != "none" && !i.facts.iter().any(|f| f.predicate == q.fact) {
        return false;
    }
    let needle = norm(&q.q.text);
    if !needle.is_empty() {
        let facts: Vec<String> = i.facts.iter().map(|f| format!("{} {}", f.predicate, f.value_text)).collect();
        let hay = norm(&format!("{} {} {} {}", i.claim_text, i.question_prompt.as_deref().unwrap_or(""), i.observed_model.as_deref().unwrap_or(""), facts.join(" ")));
        if !hay.contains(&needle) {
            return false;
        }
    }
    true
}

/// Answers saying the same claim, gathered (`groupClaims`).
struct Group<'a> {
    key: String,
    text: String,
    state: &'a str,
    occurrences: Vec<&'a Issue>,
    providers: Vec<String>,
    questions: Vec<String>,
    facts: Vec<&'a crate::api::IssueFact>,
    first: i64,
    last: i64,
    citations: usize,
}

fn group<'a>(list: &[&'a Issue], sort: &str) -> Vec<Group<'a>> {
    let mut map: BTreeMap<String, Vec<&'a Issue>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for i in list {
        let k = norm(&i.claim_text);
        if !map.contains_key(&k) {
            order.push(k.clone());
        }
        map.entry(k).or_default().push(i);
    }
    let mut out: Vec<Group<'a>> = order
        .into_iter()
        .map(|key| {
            let mut occ = map.remove(&key).unwrap_or_default();
            occ.sort_by_key(|o| std::cmp::Reverse(time(o)));
            let state = occ.iter().map(|o| o.state.as_str()).filter(|s| *s != "NEEDS_REVIEW").min_by_key(|s| severity(s)).unwrap_or("NEEDS_REVIEW");
            let mut facts: Vec<&crate::api::IssueFact> = Vec::new();
            for o in &occ {
                for f in &o.facts {
                    if !facts.iter().any(|x| x.id == f.id) {
                        facts.push(f);
                    }
                }
            }
            let mut counts: Vec<(String, usize)> = Vec::new();
            for o in &occ {
                match counts.iter_mut().find(|c| c.0 == o.provider) {
                    Some(c) => c.1 += 1,
                    None => counts.push((o.provider.clone(), 1)),
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1));
            let mut questions: Vec<String> = Vec::new();
            for q in occ.iter().filter_map(|o| o.question_prompt.clone()) {
                if !questions.contains(&q) {
                    questions.push(q);
                }
            }
            Group {
                key,
                text: occ[0].claim_text.clone(),
                state,
                providers: counts.into_iter().map(|c| c.0).collect(),
                questions,
                facts,
                first: occ.last().map(|o| time(o)).unwrap_or(0),
                last: time(occ[0]),
                citations: occ.iter().map(|o| o.citation_evidence.len()).sum(),
                occurrences: occ,
            }
        })
        .collect();
    out.sort_by(|a, b| match sort {
        "frequent" => b.occurrences.len().cmp(&a.occurrences.len()).then(b.last.cmp(&a.last)),
        "oldest" => a.first.cmp(&b.first),
        _ => b.last.cmp(&a.last),
    });
    out
}

/// How many times a claim was seen in each tenth of the whole span (`weeklyCounts`).
fn trend(occ: &[&Issue], from: i64, to: i64) -> [f64; 10] {
    let span = (to - from).max(1) as f64;
    let mut out = [0.0; 10];
    for o in occ {
        let k = (((time(o) - from) as f64 / span) * 10.0).floor().clamp(0.0, 9.0) as usize;
        out[k] += 1.0;
    }
    out
}

fn relative(at: i64) -> String {
    format::relative(Some(&format::iso_date(at)).map(|d| format!("{d}T00:00:00Z")).as_deref(), format::now())
}

fn when(i: &Issue) -> String {
    format::relative(i.collected_at.as_deref(), format::now())
}

/// A provider's logo with its name and the model that answered (`ProviderChip`).
fn provider_chip(t: &Theme, provider: &str, model: Option<&str>) -> El {
    let (name, _) = brands::brand(provider);
    row()
        .gap(6.0)
        .center_y()
        .min_w(0.0)
        .child(brands::logo(t, provider, 16.0))
        .child(label(name, type_::XS_MEDIUM, t.foreground).truncate())
        .children(model.filter(|m| !m.is_empty()).map(|m| label(m.to_string(), type_::XS, t.muted_foreground).truncate().min_w(0.0)))
}

/// Up to `max` provider logos, overlapping, with a count for the rest (`ModelStack`).
fn model_stack(t: &Theme, providers: &[String], max: usize) -> El {
    let names: Vec<String> = providers.iter().map(|p| brands::brand(p).0).collect();
    let mut r = row().gap(-4.0).center_y().help(names.join(", "));
    for p in providers.iter().take(max) {
        r = r.child(row().padding(2.0).radius(7.0).fill(t.card).child(brands::logo(t, p, 20.0)));
    }
    if providers.len() > max {
        r = r.child(row().padding(2.0).radius(7.0).fill(t.card).child(row().size(20.0, 20.0).radius(5.0).center().fill(t.accent).child(label(format!("+{}", providers.len() - max), type_::XS2, t.muted_foreground))));
    }
    r
}

fn sparkline(values: &[f64; 10], tone: Color) -> El {
    let peak = values.iter().copied().fold(1.0, f64::max);
    let mut r = row().w(48.0).h(16.0).gap(1.0).items_end();
    for v in values {
        r = r.child(el().w(0.0).grow(1.0).h(((v / peak) * 16.0).max(1.5) as f32).radius(1.0).fill(if *v > 0.0 { tone } else { tone.alpha(0.2) }));
    }
    r
}

pub fn view(s: &App, t: &Theme) -> El {
    let q = &s.issue_query;
    let export = button(t, "issues-export", "Export CSV", Variant::Outline).on_press(|s: &mut App| s.export_issues());
    let head = row()
        .w_full()
        .gap(16.0)
        .items_start()
        .child(col().grow(1.0).min_w(0.0).child(page_header(t, "AI answers", "What AI assistants said about you that still needs a look. The numbers below are measured separately.")))
        .child(export);
    let mut page = col().w_full().gap(16.0).child(head).child(discovery(s, t));
    let issues = match &s.issues {
        Load::Ready(l) => l,
        Load::Failed(e) => return page.child(failure(t, "issues-failed", &format!("Issues could not load. {e}"), |s: &mut App| s.refresh())),
        _ => return page.child(skeleton(t, 4)),
    };
    let scoped: Vec<&Issue> = issues.iter().filter(|i| matches(i, q)).collect();
    let visible: Vec<&Issue> = scoped.iter().copied().filter(|i| q.state == "ALL" || i.state == q.state).collect();

    // The totals by state; each one filters the list.
    let mut strip = row().key("issue-stats").w_full().gap(12.0).items_stretch();
    for f in FILTERS {
        let list: Vec<&&Issue> = scoped.iter().filter(|i| f == "ALL" || i.state == f).collect();
        let distinct = list.iter().map(|i| norm(&i.claim_text)).collect::<std::collections::BTreeSet<_>>().len();
        let on = q.state == f;
        let (ink, _, name) = if f == "ALL" { (t.muted_foreground, t.accent, "All open") } else { tone(t, f) };
        let tile = col()
            .key(format!("issue-stat-{f}"))
            .w(0.0)
            .grow(1.0)
            .min_w(0.0)
            .px(16.0)
            .py(12.0)
            .gap(4.0)
            .radius(12.0)
            .fill(t.card)
            .role("button")
            .label(format!("{name}: {}", list.len()))
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.set_issue_state(f))
            .child(row().gap(6.0).center_y().children((f != "ALL").then(|| el().size(6.0, 6.0).radius(3.0).fill(ink))).child(label(name, type_::XS_MEDIUM, t.muted_foreground).truncate()))
            .child(label(crate::insights::int(list.len() as f64), rune::TextStyle::new(20.0, 600.0).lh(26.0).features("'tnum' 1"), t.foreground))
            .child(label(format!("{distinct} distinct {}", if distinct == 1 { "claim" } else { "claims" }), type_::XS, t.muted_foreground).truncate());
        strip = strip.child(if on { shadows(tile.border(1.0, t.primary_ink.alpha(0.5)), &t.card_shadow) } else { shadows(tile, &t.card_shadow) });
    }
    page = page.child(strip);

    // What still waits for a rating, newest first.
    let mut queue: Vec<&Issue> = scoped.iter().copied().filter(|i| i.state == "NEEDS_REVIEW").collect();
    queue.sort_by_key(|i| std::cmp::Reverse(time(i)));
    if let Some(first) = queue.first().filter(|_| q.state != "NEEDS_REVIEW") {
        let id = first.claim_id.clone();
        page = page.child(shadows(
            row()
                .key("issue-queue")
                .w_full()
                .px(16.0)
                .py(10.0)
                .gap(12.0)
                .radius(12.0)
                .center_y()
                .fill(t.review_soft.alpha(0.6))
                .border(1.0, t.review.alpha(0.2))
                .child(ico(&icons::PEN_LINE, 16.0, t.review))
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(6.0)
                        .child(label(format!("{} {} still need a rating.", queue.len(), if queue.len() == 1 { "answer" } else { "answers" }), type_::XS_MEDIUM, t.foreground))
                        .child(label("Unreviewed claims are not counted as wrong until someone judges them.", type_::XS, t.muted_foreground).truncate().min_w(0.0)),
                )
                .child(button(t, "issue-start-review", "Start reviewing →", Variant::Outline).on_press(move |s: &mut App| s.open_answer(&id))),
            &t.float_shadow,
        ));
    }

    // The panel: toolbar, then the rows.
    let sort = sort_of(q).to_string();
    let groups = group(&visible, &sort);
    let mut answers: Vec<&Issue> = visible.clone();
    answers.sort_by(|a, b| if sort == "oldest" { time(a).cmp(&time(b)) } else { time(b).cmp(&time(a)) });
    let mut panel = shadows(col().key("issue-panel").w_full().radius(12.0).fill(t.card).clip_rounded(12.0), &t.card_shadow).child(toolbar(s, t, issues, groups.len(), visible.len()));
    let filtered = !q.q.text.is_empty() || q.provider != "all" || q.fact != "all" || q.state != "ALL";
    panel = panel.child(if issues.is_empty() {
        col().w_full().padding(16.0).child(empty_state(t, "issues-empty", &icons::INBOX, "No answers to review", "When answers are collected and need review, they will appear here.", None))
    } else if visible.is_empty() {
        let title = if q.state != "ALL" && q.q.text.is_empty() && q.provider == "all" && q.fact == "all" { format!("No issues marked {}", tone(t, &q.state).2.to_lowercase()) } else { "No issues match these filters".into() };
        col().w_full().padding(16.0).child(empty_state(
            t,
            "issues-none",
            &icons::SEARCH,
            &title,
            "Loosen a filter or clear them all to see the rest of the inbox.",
            Some(button(t, "issues-clear", "Clear filters", Variant::Outline).on_press(|s: &mut App| s.clear_issue_filters())),
        ))
    } else if q.answers {
        answers_table(t, &answers, q.page)
    } else {
        let (from, to) = issues.iter().map(time).fold((i64::MAX, i64::MIN), |a, x| (a.0.min(x), a.1.max(x)));
        let mut list = col().w_full();
        let single = groups.len() == 1;
        for g in &groups {
            list = list.child(claim_row(s, t, g, from, to, single));
        }
        list
    });
    if filtered && !visible.is_empty() {
        panel = panel.child(
            row()
                .w_full()
                .px(16.0)
                .py(8.0)
                .center_y()
                .child(label(format!("Showing {} of {} open answers", crate::insights::int(visible.len() as f64), crate::insights::int(issues.len() as f64)), type_::XS11, t.muted_foreground))
                .child(el().grow(1.0))
                .child(label("Clear filters", XS11_MEDIUM, t.foreground).key("issues-clear-foot").role("button").cursor(Cursor::Pointer).on_press(|s: &mut App| s.clear_issue_filters())),
        );
    }
    page.child(panel)
}

/// The web's `DiscoveryOverview`: what sampled AI answers say, and separately, AI-referred visits.
fn discovery(s: &App, t: &Theme) -> El {
    let body = match &s.insights {
        Load::Ready(i) => match &i.discovery {
            Ok(Some(d)) => {
                let mut c = col().w_full().gap(10.0);
                c = c.child(match &d.period {
                    Some((surface, reviewed, mentions, owned, range)) => col()
                        .gap(2.0)
                        .child(label(format!("AI answers on {surface}"), type_::XS_MEDIUM, t.foreground))
                        .child(label(format!("Reviewed: {reviewed} successful samples. Confirmed mentions: {mentions} clear mention reviews. Owned-site citations: {owned} successful samples."), type_::XS, t.foreground).wrap())
                        .child(label(format!("{range}. Citations are reported by the provider, not verified support."), type_::XS, t.muted_foreground).wrap()),
                    None => label("AI answer discovery: not measured yet.", type_::XS, t.foreground),
                });
                c.child(match &d.referral {
                    Some((ai, total, range, signups)) => col()
                        .gap(2.0)
                        .child(label("AI-attributed website sessions, from a GA4 export", type_::XS_MEDIUM, t.foreground))
                        .child(label(
                            format!("{} of {} sessions, {range}. {}", crate::insights::int(*ai), crate::insights::int(*total), signups.map(|n| format!("{} signups reported.", crate::insights::int(n))).unwrap_or_else(|| "Signups not measured.".into())),
                            type_::XS,
                            t.foreground,
                        ).wrap())
                        .child(label("This is a separate data source; it does not show that a sampled AI answer caused a visit or signup.", type_::XS, t.muted_foreground).wrap()),
                    None => label("AI-attributed website sessions and signups: not measured.", type_::XS, t.foreground),
                })
                .child(row().child(button(t, "issues-discovery", "See the full report", Variant::Outline).on_press(|s: &mut App| s.show_section(crate::insights::Section::Answers))))
            }
            Ok(None) => col()
                .gap(4.0)
                .child(label("AI answer discovery: not measured yet.", type_::XS, t.foreground))
                .child(label("AI-attributed website sessions and signups: not measured.", type_::XS, t.foreground)),
            Err(_) => label("This could not load right now. That does not mean there is nothing to show.", type_::XS, t.muted_foreground).wrap(),
        },
        Load::Failed(_) => label("This could not load right now. That does not mean there is nothing to show.", type_::XS, t.muted_foreground).wrap(),
        _ => el().w_full().h(56.0).radius(8.0).fill(t.accent),
    };
    shadows(col().key("issues-discovery-card").w_full().px(16.0).py(14.0).gap(10.0).radius(12.0).fill(t.card), &t.card_shadow)
        .child(col().gap(2.0).child(label("AI discovery and referrals", type_::SM_MEDIUM, t.foreground).role("heading")).child(label("What sampled AI answers say, and separately, visits attributed to AI assistants.", type_::XS, t.muted_foreground)))
        .child(body)
}

fn count(t: &Theme, n: usize) -> El {
    row().h(16.0).px(6.0).radius(8.0).center().fill(t.accent).child(label(n.to_string(), XS11_MEDIUM.features("'tnum' 1"), t.muted_foreground))
}

/// A picker that opens one of the toolbar's menus.
fn picker(t: &Theme, key: &str, text_: String, width: f32, menu: Menu, open: bool) -> El {
    shadows(
        row()
            .key(key.to_string())
            .w(width)
            .h(32.0)
            .px(10.0)
            .gap(6.0)
            .radius(8.0)
            .center_y()
            .fill(t.control)
            .role("button")
            .label(text_.clone())
            .expanded(open)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .on_press(move |s: &mut App| s.menu = if s.menu == Some(menu) { None } else { Some(menu) })
            .child(label(text_, type_::XS, t.foreground).truncate().grow(1.0).min_w(0.0))
            .child(ico(&icons::CHEVRON_DOWN, 14.0, t.muted_foreground)),
        &t.control_shadow,
    )
}

fn toolbar(s: &App, t: &Theme, issues: &[Issue], groups: usize, answers: usize) -> El {
    let q = &s.issue_query;
    let tab = |key: &str, name: &str, n: usize, on: bool, answers: bool| {
        let mut r = row()
            .key(key.to_string())
            .h_full()
            .px(10.0)
            .gap(6.0)
            .radius(6.0)
            .center_y()
            .role("tab")
            .label(name.to_string())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| s.set_issue_view(answers))
            .child(label(name.to_string(), type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }))
            .child(count(t, n));
        if on {
            r = shadows(r.fill(t.control), &t.control_shadow);
        }
        r
    };
    let tabs = row().h(32.0).padding(3.0).gap(2.0).radius(8.0).fill(t.accent).role("tablist").child(tab("issue-view-claims", "By claim", groups, !q.answers, false)).child(tab("issue-view-answers", "Every answer", answers, q.answers, true));
    let input = text_input(&q.q, type_::XS)
        .key("issue-search")
        .placeholder("Search claims and questions", t.muted_foreground)
        .label("Search issues")
        .w_full()
        .color(t.foreground)
        .on_edit(|s: &mut App| {
            s.issue_query.page = 1;
            &mut s.issue_query.q
        });
    let search = shadows(
        row()
            .grow(1.0)
            .min_w(140.0)
            .h(32.0)
            .px(10.0)
            .gap(8.0)
            .radius(8.0)
            .center_y()
            .fill(t.control)
            .child(ico(&icons::SEARCH, 14.0, t.muted_foreground))
            .child(input.grow(1.0).min_w(0.0))
            .children((!q.q.text.is_empty()).then(|| {
                row().key("issue-search-clear").size(20.0, 20.0).radius(4.0).center().role("button").label("Clear search").cursor(Cursor::Pointer).hover(t.hover_tint).on_press(|s: &mut App| s.issue_query.q.clear()).child(ico(&icons::X, 12.0, t.muted_foreground))
            })),
        &t.control_shadow,
    );
    let model = if q.provider == "all" { "All models".to_string() } else { brands::brand(&q.provider).0 };
    let fact = match q.fact.as_str() {
        "all" => "All facts".to_string(),
        "none" => "No fact linked".to_string(),
        f => sentence(f),
    };
    let sort = match sort_of(q) {
        "frequent" => "Most repeated",
        "oldest" => "Oldest first",
        _ => "Newest first",
    };
    let _ = issues;
    row()
        .key("issue-toolbar")
        .w_full()
        .px(12.0)
        .py(10.0)
        .gap(8.0)
        .center_y()
        .flex_wrap()
        .child(tabs)
        .child(search)
        .child(picker(t, "issue-model", model, 128.0, Menu::IssueModel, s.menu == Some(Menu::IssueModel)))
        .child(picker(t, "issue-fact", fact, 128.0, Menu::IssueFact, s.menu == Some(Menu::IssueFact)))
        .child(picker(t, "issue-sort", sort.to_string(), 124.0, Menu::IssueSort, s.menu == Some(Menu::IssueSort)))
}

/// The toolbar's open picker, anchored under it.
pub fn menu(s: &App, t: &Theme, which: Menu) -> Option<El> {
    let issues: &[Issue] = s.issues.ready().map(Vec::as_slice).unwrap_or(&[]);
    let q = &s.issue_query;
    let item = |key: String, lead: Option<El>, name: String, n: Option<usize>, on: bool, act: Box<dyn Fn(&mut App)>| {
        row()
            .key(key)
            .w_full()
            .h(32.0)
            .px(8.0)
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .role("option")
            .label(name.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(move |s: &mut App| {
                act(s);
                s.menu = None;
            })
            .children(lead)
            .child(label(name, type_::XS, t.foreground).truncate().grow(1.0).min_w(0.0))
            .children(n.map(|n| label(n.to_string(), type_::XS.features("'tnum' 1"), t.muted_foreground)))
            .children(on.then(|| ico(&icons::CHECK, 14.0, t.foreground)))
    };
    let (anchor, width) = match which {
        Menu::IssueModel => ("issue-model", 220.0),
        Menu::IssueFact => ("issue-fact", 240.0),
        Menu::IssueSort => ("issue-sort", 160.0),
        _ => return None,
    };
    let mut m = shadows(col().key(format!("{anchor}-menu")).w(width).padding(4.0).gap(1.0).radius(10.0).fill(t.popover), &t.float_shadow).role("listbox");
    match which {
        Menu::IssueModel => {
            let mut counts: Vec<(String, usize)> = Vec::new();
            for i in issues {
                match counts.iter_mut().find(|c| c.0 == i.provider) {
                    Some(c) => c.1 += 1,
                    None => counts.push((i.provider.clone(), 1)),
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1));
            m = m.child(item("im-all".into(), None, "All models".into(), None, q.provider == "all", Box::new(|s| s.set_issue_provider("all"))));
            for (p, n) in counts {
                let v = p.clone();
                m = m.child(item(format!("im-{p}"), Some(brands::logo(t, &p, 16.0)), brands::brand(&p).0, Some(n), q.provider == p, Box::new(move |s| s.set_issue_provider(&v))));
            }
        }
        Menu::IssueFact => {
            let mut counts: Vec<(String, usize)> = Vec::new();
            for i in issues {
                for f in &i.facts {
                    match counts.iter_mut().find(|c| c.0 == f.predicate) {
                        Some(c) => c.1 += 1,
                        None => counts.push((f.predicate.clone(), 1)),
                    }
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1));
            m = m.child(item("if-all".into(), None, "All facts".into(), None, q.fact == "all", Box::new(|s| s.set_issue_filter_fact("all"))));
            for (f, n) in counts {
                let v = f.clone();
                m = m.child(item(format!("if-{f}"), None, sentence(&f), Some(n), q.fact == f, Box::new(move |s| s.set_issue_filter_fact(&v))));
            }
            m = m.child(item("if-none".into(), None, "No fact linked".into(), None, q.fact == "none", Box::new(|s| s.set_issue_filter_fact("none"))));
        }
        _ => {
            let current = sort_of(q).to_string();
            if !q.answers {
                m = m.child(item("is-frequent".into(), None, "Most repeated".into(), None, current == "frequent", Box::new(|s| s.set_issue_sort("frequent"))));
            }
            m = m.child(item("is-recent".into(), None, "Newest first".into(), None, current == "recent", Box::new(|s| s.set_issue_sort("recent"))));
            m = m.child(item("is-oldest".into(), None, "Oldest first".into(), None, current == "oldest", Box::new(|s| s.set_issue_sort("oldest"))));
        }
    }
    Some(m.anchored(anchor, Side::Bottom, Align::End, 6.0).modal(true, |s: &mut App| s.menu = None))
}

/// One claim and every answer that said it (`ClaimGroupRow`).
fn claim_row(s: &App, t: &Theme, g: &Group<'_>, from: i64, to: i64, single: bool) -> El {
    let open = single || s.issue_query.open.contains(&g.key);
    let all = s.issue_query.all.contains(&g.key);
    let to_review: Vec<&&Issue> = g.occurrences.iter().filter(|o| o.state == "NEEDS_REVIEW").collect();
    let reviewed = g.occurrences.iter().find(|o| o.state != "NEEDS_REVIEW");
    let ink = match g.state {
        "WRONG" => t.chart.wrong,
        "PARTIAL" => t.chart.partial,
        "UNKNOWN" => t.chart.unknown,
        _ => t.chart.unreviewed,
    };
    let key = g.key.clone();
    // The facts line, the question and the cited sources.
    let mut meta = row().w_full().gap(12.0).flex_wrap().center_y();
    if g.facts.is_empty() {
        meta = meta.child(row().gap(4.0).center_y().child(ico(&icons::BOOK_CHECK, 12.0, t.muted_foreground)).child(label(if reviewed.is_some() { "No approved fact linked" } else { "Not compared yet" }, type_::XS11, t.muted_foreground)));
    }
    for f in &g.facts {
        meta = meta.child(
            row()
                .gap(4.0)
                .center_y()
                .child(ico(&icons::BOOK_CHECK, 12.0, t.muted_foreground))
                .child(label(format!("Approved {}", sentence(&f.predicate).to_lowercase()), type_::XS11, t.muted_foreground))
                .child(label(f.value_text.clone(), XS11_MEDIUM, t.foreground))
                .child(label(format!("v{}", f.version), type_::XS11.features("'tnum' 1"), t.muted_foreground)),
        );
    }
    if let Some(q) = g.questions.first() {
        meta = meta.child(
            row()
                .gap(4.0)
                .center_y()
                .min_w(0.0)
                .child(ico(&icons::MESSAGE_SQUARE_QUOTE, 12.0, t.muted_foreground))
                .child(label(format!("“{q}”"), type_::XS11, t.muted_foreground).truncate().max_w(360.0))
                .children((g.questions.len() > 1).then(|| label(format!("+{}", g.questions.len() - 1), type_::XS11, t.muted_foreground))),
        );
    }
    if g.citations > 0 {
        meta = meta.child(row().gap(4.0).center_y().child(ico(&icons::LINK, 12.0, t.muted_foreground)).child(label(format!("{} cited {}", g.citations, if g.citations == 1 { "source" } else { "sources" }), type_::XS11, t.muted_foreground)));
    }
    let lead = row()
        .grow(1.0)
        .min_w(0.0)
        .gap(10.0)
        .items_start()
        .role("button")
        .label(g.text.clone())
        .expanded(open)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .on_press(move |s: &mut App| s.toggle_issue_group(&key))
        .child(ico(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 16.0, t.muted_foreground).mt(2.0))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(6.0)
                .child(
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(badge(t, g.state))
                        .children((g.state != "NEEDS_REVIEW" && !to_review.is_empty()).then(|| label(format!("{} need review", to_review.len()), XS11_MEDIUM, t.review)))
                        .child(label(format!("{} {}", g.providers.len(), if g.providers.len() == 1 { "model" } else { "models" }), type_::XS11, t.muted_foreground)),
                )
                .child(label(g.text.clone(), type_::XS_MEDIUM.lh(18.0), t.foreground).wrap())
                .child(meta),
        );
    let seen = row()
        .gap(10.0)
        .center_y()
        .help(format!("Seen {} times, first {}, last {}", g.occurrences.len(), format::date(&format::iso_date(g.first)), relative(g.last)))
        .child(sparkline(&trend(&g.occurrences, from, to), ink))
        .child(col().w(72.0).items_end().child(label(format!("{}×", g.occurrences.len()), XS_SEMIBOLD.features("'tnum' 1"), t.foreground)).child(label(when(g.occurrences[0]), type_::XS11, t.muted_foreground)));
    let mut actions = row().w(128.0).gap(4.0).center_y().child(el().grow(1.0));
    if let Some(first) = to_review.first() {
        let id = first.claim_id.clone();
        actions = actions.child(
            shadows(
                row()
                    .key(format!("issue-review-{}", g.key.len()))
                    .h(28.0)
                    .px(8.0)
                    .gap(4.0)
                    .radius(6.0)
                    .center_y()
                    .fill(t.primary)
                    .role("button")
                    .label(format!("Rate this answer, {} waiting", to_review.len()))
                    .help(format!("Rate this answer: {} {} waiting", to_review.len(), if to_review.len() == 1 { "answer" } else { "answers" }))
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut App| s.open_answer(&id))
                    .child(ico(&icons::PEN_LINE, 14.0, t.primary_foreground))
                    .child(label("Review", type_::XS_MEDIUM, t.primary_foreground))
                    .child(label(to_review.len().to_string(), type_::XS.features("'tnum' 1"), t.primary_foreground.alpha(0.8))),
                &t.control_shadow,
            ),
        );
    }
    if let Some(r) = reviewed {
        let id = r.claim_id.clone();
        actions = actions.child(if to_review.is_empty() {
            button(t, &format!("issue-view-{}", r.claim_id), "View issue ›", Variant::Outline).on_press(move |s: &mut App| s.open_answer(&id))
        } else {
            row().key(format!("issue-view-{}", r.claim_id)).size(28.0, 28.0).radius(6.0).center().role("button").label("View issue").help("View issue").cursor(Cursor::Pointer).hover(t.hover_tint).on_press(move |s: &mut App| s.open_answer(&id)).child(ico(&icons::CHEVRON_RIGHT, 16.0, t.muted_foreground))
        });
    }
    let mut c = col()
        .key(format!("claim-{}", g.key))
        .w_full()
        .fill(if open { t.accent.alpha(0.25) } else { Color::TRANSPARENT })
        .child(row().w_full().px(16.0).py(12.0).gap(24.0).center_y().child(lead).child(model_stack(t, &g.providers, 4)).child(seen).child(actions));
    if open {
        let shown: Vec<&&Issue> = if all { g.occurrences.iter().collect() } else { g.occurrences.iter().take(6).collect() };
        let mut list = shadows(col().w_full().radius(10.0).fill(t.card).clip_rounded(10.0), &t.card_shadow);
        for o in shown {
            let id = o.claim_id.clone();
            let r = row()
                .key(format!("occ-{}", o.claim_id))
                .w_full()
                .px(12.0)
                .py(8.0)
                .gap(16.0)
                .center_y()
                .role("button")
                .label(o.claim_text.clone())
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.open_answer(&id))
                .child(row().w(208.0).min_w(0.0).child(provider_chip(t, &o.provider, o.observed_model.as_deref())))
                .child(label(o.question_prompt.as_ref().map(|q| format!("Asked “{q}”")).unwrap_or_else(|| "Question not recorded".into()), type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0))
                .child(badge(t, &o.state))
                .child(row().w(80.0).child(el().grow(1.0)).child(label(when(o), type_::XS.features("'tnum' 1"), t.muted_foreground)).help(o.collected_at.as_deref().map(format::date_time).unwrap_or_default()))
                .child(row().w(110.0).gap(4.0).center_y().child(el().grow(1.0)).child(label(if o.state == "NEEDS_REVIEW" { "Rate this answer" } else { "View issue" }, type_::XS_MEDIUM, t.foreground)).child(ico(&icons::CHEVRON_RIGHT, 14.0, t.muted_foreground)));
            list = list.child(r);
        }
        let mut under = col().w_full().pl(40.0).pr(16.0).pb(12.0).gap(8.0).child(list);
        if g.occurrences.len() > 6 && !all {
            let key = g.key.clone();
            under = under.child(label(format!("Show all {} answers", g.occurrences.len()), XS11_MEDIUM, t.muted_foreground).key(format!("claim-all-{}", g.key)).role("button").cursor(Cursor::Pointer).on_press(move |s: &mut App| {
                s.issue_query.all.insert(key.clone());
            }));
        }
        c = c.child(under);
    }
    c
}

/// Every answer, 25 to a page (`AnswersTable`).
fn answers_table(t: &Theme, rows: &[&Issue], page: usize) -> El {
    let pages = rows.len().div_ceil(PAGE_SIZE).max(1);
    let current = page.clamp(1, pages);
    let slice = &rows[(current - 1) * PAGE_SIZE..(current * PAGE_SIZE).min(rows.len())];
    let cell = |w: f32, grow: bool, c: El| if grow { row().w(0.0).grow(w).min_w(0.0).child(c) } else { row().w(w).child(c) };
    let head = row()
        .w_full()
        .px(16.0)
        .py(6.0)
        .gap(16.0)
        .fill(t.accent.alpha(0.3))
        .child(cell(144.0, false, label("State", type_::XS11, t.muted_foreground)))
        .child(cell(2.0, true, label("AI said", type_::XS11, t.muted_foreground)))
        .child(cell(1.0, true, label("Your approved fact", type_::XS11, t.muted_foreground)))
        .child(cell(1.0, true, label("Model", type_::XS11, t.muted_foreground)))
        .child(cell(48.0, false, label("Sources", type_::XS11, t.muted_foreground)))
        .child(row().w(80.0).child(el().grow(1.0)).child(label("Seen", type_::XS11, t.muted_foreground)));
    let mut c = col().w_full().child(head);
    for i in slice {
        let id = i.claim_id.clone();
        let facts = if i.facts.is_empty() {
            label(if i.state == "NEEDS_REVIEW" { "Not compared yet" } else { "No fact linked" }, type_::XS, t.muted_foreground).truncate()
        } else {
            let mut r = row().gap(8.0).min_w(0.0);
            for f in &i.facts {
                r = r.child(row().gap(4.0).min_w(0.0).child(label(sentence(&f.predicate), type_::XS, t.muted_foreground)).child(label(f.value_text.clone(), type_::XS_MEDIUM, t.foreground).truncate()).child(label(format!("v{}", f.version), type_::XS11, t.muted_foreground)));
            }
            r
        };
        let sources = if i.citation_evidence.is_empty() {
            label("None", type_::XS, t.muted_foreground)
        } else {
            row().gap(4.0).center_y().child(ico(&icons::LINK, 12.0, t.foreground)).child(label(i.citation_evidence.len().to_string(), type_::XS_MEDIUM, t.foreground))
        };
        let r = row()
            .key(format!("answer-{}", i.claim_id))
            .w_full()
            .px(16.0)
            .py(10.0)
            .gap(16.0)
            .center_y()
            .role("button")
            .label(i.claim_text.clone())
            .focusable(true)
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(move |s: &mut App| s.open_answer(&id))
            .child(cell(144.0, false, badge(t, &i.state)))
            .child(cell(
                2.0,
                true,
                col()
                    .w_full()
                    .min_w(0.0)
                    .child(label(i.claim_text.clone(), type_::XS_MEDIUM, t.foreground).truncate())
                    .child(label(i.question_prompt.as_ref().map(|q| format!("Asked “{q}”")).unwrap_or_else(|| "Question not recorded".into()), type_::XS11, t.muted_foreground).truncate()),
            ))
            .child(cell(1.0, true, facts))
            .child(cell(1.0, true, provider_chip(t, &i.provider, i.observed_model.as_deref())))
            .child(cell(48.0, false, sources))
            .child(row().w(80.0).child(el().grow(1.0)).child(label(when(i), type_::XS.features("'tnum' 1"), t.muted_foreground)));
        c = c.child(r);
    }
    if pages > 1 {
        let nav = |key: &str, i: &'static rune::Icon, name: &str, to: usize, on: bool| {
            let r = row().key(key.to_string()).size(28.0, 28.0).radius(6.0).center().role("button").label(name.to_string()).disabled(!on).opacity(if on { 1.0 } else { 0.4 }).child(ico(i, 16.0, t.muted_foreground));
            if on { r.cursor(Cursor::Pointer).hover(t.hover_tint).on_press(move |s: &mut App| s.issue_query.page = to) } else { r }
        };
        c = c.child(
            row()
                .w_full()
                .px(16.0)
                .py(6.0)
                .center_y()
                .child(label(format!("{}–{} of {}", (current - 1) * PAGE_SIZE + 1, (current * PAGE_SIZE).min(rows.len()), rows.len()), type_::XS11.features("'tnum' 1"), t.muted_foreground))
                .child(el().grow(1.0))
                .child(nav("answers-prev", &icons::CHEVRON_LEFT, "Previous page", current.saturating_sub(1), current > 1))
                .child(label(format!("Page {current} of {pages}"), type_::XS11.features("'tnum' 1"), t.muted_foreground).px(4.0))
                .child(nav("answers-next", &icons::CHEVRON_RIGHT, "Next page", current + 1, current < pages)),
        );
    }
    c
}

/// The open answers as CSV, in the web's columns (`issuesCsv`).
pub fn csv(list: &[Issue]) -> String {
    let esc = |v: &str| format!("\"{}\"", v.replace('"', "\"\""));
    let mut sorted: Vec<&Issue> = list.iter().collect();
    sorted.sort_by_key(|i| std::cmp::Reverse(time(i)));
    let mut out = vec!["collected_at,state,verdict,provider,model,question,claim,approved_facts,citations".to_string()];
    for i in sorted {
        let facts: Vec<String> = i.facts.iter().map(|f| format!("{}={} (v{})", f.predicate, f.value_text, f.version)).collect();
        out.push(
            [
                i.collected_at.clone().unwrap_or_default(),
                i.state.clone(),
                i.verdict.clone().unwrap_or_default(),
                i.provider.clone(),
                esc(i.observed_model.as_deref().unwrap_or("")),
                esc(i.question_prompt.as_deref().unwrap_or("")),
                esc(&i.claim_text),
                esc(&facts.join("; ")),
                i.citation_evidence.len().to_string(),
            ]
            .join(","),
        );
    }
    out.join("\n")
}

/// The filtered list, as the export takes it.
pub fn visible(s: &App) -> Vec<Issue> {
    let q = &s.issue_query;
    s.issues.ready().map(|l| l.iter().filter(|i| matches(i, q) && (q.state == "ALL" || i.state == q.state)).cloned().collect()).unwrap_or_default()
}
