//! The Performance section's detail under each connected source: what the
//! source sends beyond its headline numbers, laid out for a marketing team.
//! Nothing here adds numbers across sources.

use rune::{El, col, el, row};

use crate::insights::{AdDetail, AdTotals, Detail, Goal, Insights, LocalDetail, RevenueData, SearchRow, Source, int, money};
use crate::ui::charts;
use crate::state::App;
use crate::theme::{Theme, type_};
use crate::ui::kit::{self, Column, column};
use crate::ui::widgets::{Variant, button, label, status_chip};

fn ask(request: String) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(&request);
    }
}

fn pct1(x: f64) -> String {
    format!("{:.1}%", x * 100.0)
}

fn position(p: Option<f64>) -> String {
    p.map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into())
}

/// Queries that carry the business's own name.
fn branded(q: &str, brand: &str) -> bool {
    !brand.is_empty() && q.to_lowercase().contains(brand)
}

// ---- Google Search -------------------------------------------------------------

pub fn search(s: &App, t: &Theme, key: &str, queries: &[SearchRow], pages: &[SearchRow]) -> El {
    let mut c = col().w_full().gap(16.0);
    if queries.is_empty() && pages.is_empty() {
        return c;
    }
    const COLS: [Column; 5] = [column("Query", 0.0, false), column("Clicks", 72.0, true), column("Views", 80.0, true), column("CTR", 64.0, true), column("Position", 72.0, true)];
    let site_ctr = {
        let (cl, im) = queries.iter().fold((0.0, 0.0), |a, q| (a.0 + q.clicks, a.1 + q.impressions));
        (im > 0.0).then(|| cl / im)
    };
    let rows = |list: &[SearchRow]| -> Vec<Vec<El>> {
        list.iter()
            .take(10)
            .map(|q| {
                let low = site_ctr.is_some_and(|a| q.ctr < a / 2.0) && q.impressions >= 500.0;
                vec![kit::text(t, q.key.clone()), kit::num(t, int(q.clicks)), kit::faint(t, int(q.impressions)), label(pct1(q.ctr), kit::NUM, if low { t.partial } else { t.foreground }), kit::faint(t, position(q.position))]
            })
            .collect()
    };
    if !queries.is_empty() {
        c = c.child(kit::panel(t, &format!("{key}-queries"), "Top queries", Some("What people searched before they saw or clicked you. An amber click-through rate is under half your average.".into()), None, 0.0, kit::table(t, &format!("{key}-q-table"), &COLS, rows(queries))));
    }
    let mut row2 = Vec::new();
    if !pages.is_empty() {
        const PCOLS: [Column; 4] = [column("Page", 0.0, false), column("Clicks", 64.0, true), column("Views", 72.0, true), column("Position", 64.0, true)];
        let prow: Vec<Vec<El>> = pages.iter().take(8).map(|p| vec![kit::text(t, p.key.clone()), kit::num(t, int(p.clicks)), kit::faint(t, int(p.impressions)), kit::faint(t, position(p.position))]).collect();
        row2.push(kit::panel(t, &format!("{key}-pages"), "Top landing pages", Some("Where search visitors arrive".into()), None, 0.0, kit::table(t, &format!("{key}-p-table"), &PCOLS, prow)));
    }
    // Where the queries rank, weighted by how often they were seen.
    let bucket = |lo: f64, hi: f64| queries.iter().filter(|q| q.position.is_some_and(|p| p >= lo && p < hi)).map(|q| q.impressions).sum::<f64>();
    let ch = &t.chart;
    let spread = vec![
        ("Top 3".to_string(), bucket(0.0, 3.5), ch.tone(0), String::new()),
        ("4 to 10".to_string(), bucket(3.5, 10.5), ch.tone(1), String::new()),
        ("11 to 20".to_string(), bucket(10.5, 20.5), ch.tone(2), String::new()),
        ("Beyond 20".to_string(), bucket(20.5, f64::MAX), ch.tone(3), String::new()),
    ]
    .into_iter()
    .map(|(n, v, c, _)| (n, v, c, format!("{} views", int(v))))
    .collect::<Vec<_>>();
    let brand = s.active_business().map(|b| b.name.split_whitespace().next().unwrap_or("").to_lowercase()).unwrap_or_default();
    let (bc, nc) = queries.iter().fold((0.0, 0.0), |a, q| if branded(&q.key, &brand) { (a.0 + q.clicks, a.1) } else { (a.0, a.1 + q.clicks) });
    let mix = col()
        .w_full()
        .gap(18.0)
        .child(kit::split(t, &format!("{key}-spread"), &spread))
        .children((!brand.is_empty() && bc + nc > 0.0).then(|| {
            col().w_full().gap(8.0).pt(14.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border).child(label("Clicks from your name against everything else", type_::XS, t.muted_foreground)).child(kit::split(
                t,
                &format!("{key}-brand"),
                &[("Searched your name".into(), bc, ch.primary, format!("{} clicks", int(bc))), ("Found you without it".into(), nc, ch.tone(1), format!("{} clicks", int(nc)))],
            ))
        }));
    row2.push(kit::panel(t, &format!("{key}-spread-card"), "Where you rank", Some("Views of your top queries by their average position".into()), None, 0.0, mix));
    c = c.child(kit::cols(row2));

    // What to work on: queries a few places from the top, and ones seen but rarely clicked.
    let mut close: Vec<&SearchRow> = queries.iter().filter(|q| q.position.is_some_and(|p| (4.0..=20.0).contains(&p)) && q.impressions >= 200.0).collect();
    close.sort_by(|a, b| b.impressions.total_cmp(&a.impressions));
    let mut unclicked: Vec<&SearchRow> = queries.iter().filter(|q| site_ctr.is_some_and(|a| q.ctr < a / 2.0) && q.position.is_some_and(|p| p <= 10.0) && q.impressions >= 200.0).collect();
    unclicked.sort_by(|a, b| b.impressions.total_cmp(&a.impressions));
    let mut ideas = col().w_full().gap(10.0);
    let mut n = 0;
    for q in close.iter().take(3) {
        n += 1;
        ideas = ideas.child(kit::callout(
            t,
            &format!("{key}-close-{n}"),
            t.chart.primary,
            format!("\"{}\" ranks {:.0} and was seen {} times", q.key, q.position.unwrap_or(0.0), int(q.impressions)),
            "A few places higher puts it in the top three, where most clicks go. Improve the page that ranks for it.".into(),
            None,
        ));
    }
    for q in unclicked.iter().filter(|q| !close.iter().take(3).any(|c| c.key == q.key)).take(2) {
        n += 1;
        ideas = ideas.child(kit::callout(
            t,
            &format!("{key}-ctr-{n}"),
            t.partial,
            format!("\"{}\" is seen but rarely clicked ({} of views)", q.key, pct1(q.ctr)),
            "It ranks on the first page, so the title and description are likely what people skip. Rewrite them.".into(),
            None,
        ));
    }
    if n > 0 {
        c = c.child(kit::panel(
            t,
            &format!("{key}-ideas"),
            "Search opportunities",
            Some("From your top queries: worth a page update".into()),
            Some(button(t, &format!("{key}-ideas-ask"), "Plan the fixes", Variant::Outline).on_press(ask(
                "Look at our Search Console queries that rank 4 to 20 or get few clicks for their views, and propose page and title changes for me to approve.".into(),
            ))),
            0.0,
            ideas,
        ));
    }
    c
}

// ---- Ads -----------------------------------------------------------------------

fn ratio_change(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.zip(b).and_then(|(a, b)| kit::change(a, b))
}

pub fn ads(t: &Theme, key: &str, d: &AdDetail) -> El {
    let m = |x: f64| money(x, &d.currency);
    let (n, b) = (&d.now, &d.before);
    let conv_rate = |x: &AdTotals| (x.clicks > 0.0).then(|| x.conversions / x.clicks);
    let strip = kit::rows_of(vec![
        kit::tile(t, &format!("{key}-impr"), "Impressions", int(n.impressions), kit::change(n.impressions, b.impressions).map(|c| (c, true)), Some(format!("{} the period before", int(b.impressions)))),
        kit::tile(t, &format!("{key}-ctr"), "Click-through rate", n.ctr.map(pct1).unwrap_or_else(|| "—".into()), ratio_change(n.ctr, b.ctr).map(|c| (c, true)), Some("Clicks for every view".into())),
        kit::tile(t, &format!("{key}-cpc"), "Cost per click", n.cpc.map(m).unwrap_or_else(|| "—".into()), ratio_change(n.cpc, b.cpc).map(|c| (c, false)), Some(format!("{} the period before", b.cpc.map(m).unwrap_or_else(|| "—".into())))),
        kit::tile(t, &format!("{key}-cvr"), "Conversion rate", conv_rate(n).map(pct1).unwrap_or_else(|| "—".into()), ratio_change(conv_rate(n), conv_rate(b)).map(|c| (c, true)), Some("Conversions for every click".into())),
        kit::tile(t, &format!("{key}-value"), "Conversion value", m(n.value), kit::change(n.value, b.value).map(|c| (c, true)), Some("As the platform values them".into())),
        kit::tile(t, &format!("{key}-roas"), "Return on ad spend", n.roas.map(|r| format!("{r:.2}x")).unwrap_or_else(|| "—".into()), ratio_change(n.roas, b.roas).map(|c| (c, true)), Some("Conversion value for every 1 spent".into())),
    ], 3);
    let mut c = col().w_full().gap(16.0).child(strip);
    if d.campaigns.is_empty() {
        return c;
    }
    const COLS: [Column; 8] = [
        column("Campaign", 0.0, false),
        column("Spend", 90.0, true),
        column("Share", 56.0, true),
        column("Clicks", 64.0, true),
        column("CTR", 56.0, true),
        column("Conv.", 56.0, true),
        column("Cost per conv.", 100.0, true),
        column("ROAS", 56.0, true),
    ];
    let total_spend: f64 = d.campaigns.iter().map(|x| x.2.spend).sum();
    let avg_cpa = n.cpa;
    let rows: Vec<Vec<El>> = d
        .campaigns
        .iter()
        .map(|(name, status, x)| {
            let paused = status.as_deref().is_some_and(|s| s != "ENABLED" && s != "ACTIVE");
            let costly = x.cpa.zip(avg_cpa).is_some_and(|(a, b)| a > b * 1.5);
            vec![
                row().w_full().gap(8.0).center_y().child(kit::text(t, name.clone()).min_w(0.0)).children(paused.then(|| status_chip(t, "Paused", t.muted_foreground, t.accent))),
                kit::num(t, m(x.spend)),
                kit::faint(t, if total_spend > 0.0 { format!("{:.0}%", x.spend / total_spend * 100.0) } else { "—".into() }),
                kit::faint(t, int(x.clicks)),
                kit::faint(t, x.ctr.map(pct1).unwrap_or_else(|| "—".into())),
                kit::faint(t, format!("{:.1}", x.conversions)),
                label(x.cpa.map(m).unwrap_or_else(|| "—".into()), kit::NUM, if costly { t.wrong } else { t.foreground }),
                kit::faint(t, x.roas.map(|r| format!("{r:.2}x")).unwrap_or_else(|| "—".into())),
            ]
        })
        .collect();
    c = c.child(kit::panel(
        t,
        &format!("{key}-campaigns"),
        "Campaigns",
        Some(format!("Spend, results and efficiency per campaign. Red cost per conversion is over 1.5 times the account's {}.", avg_cpa.map(m).unwrap_or_else(|| "average".into()))),
        None,
        0.0,
        kit::table(t, &format!("{key}-c-table"), &COLS, rows),
    ));
    // Where the money goes against where the conversions come from.
    let total_conv: f64 = d.campaigns.iter().map(|x| x.2.conversions).sum();
    let spend_parts: Vec<_> = d.campaigns.iter().enumerate().map(|(k, (name, _, x))| (name.clone(), x.spend, t.chart.tone(k), m(x.spend))).collect();
    let conv_parts: Vec<_> = d.campaigns.iter().enumerate().map(|(k, (name, _, x))| (name.clone(), x.conversions, t.chart.tone(k), format!("{:.1}", x.conversions))).collect();
    let mut by_cpa: Vec<(String, f64, String)> = d.campaigns.iter().filter_map(|(name, _, x)| x.cpa.map(|v| (name.clone(), v, m(v)))).collect();
    by_cpa.sort_by(|a, b| a.1.total_cmp(&b.1));
    let best = by_cpa.first().cloned();
    let worst = by_cpa.last().cloned().filter(|w| best.as_ref().is_some_and(|b| b.0 != w.0));
    let mut eff = col().w_full().gap(14.0).child(kit::bars(t, &format!("{key}-cpa-bars"), &by_cpa, None));
    if let (Some(b), Some(w)) = (best, worst) {
        eff = eff.child(kit::callout(
            t,
            &format!("{key}-shift"),
            t.chart.primary,
            format!("{} converts at {}, {} at {}", b.0, b.2, w.0, w.2),
            "Moving budget toward the cheaper campaign is worth testing, as long as it still has room to spend.".into(),
            None,
        ));
    }
    c.child(kit::cols(vec![
        kit::panel(
            t,
            &format!("{key}-mix"),
            "Spend against results",
            Some(format!("{} spent, {:.1} conversions", m(total_spend), total_conv)),
            None,
            0.0,
            col().w_full().gap(16.0).child(label("Share of spend", type_::XS, t.muted_foreground)).child(kit::split(t, &format!("{key}-spend"), &spend_parts)).child(label("Share of conversions", type_::XS, t.muted_foreground)).child(kit::split(t, &format!("{key}-conv"), &conv_parts)),
        ),
        kit::panel(t, &format!("{key}-cpa"), "Cost per conversion", Some("Cheapest first".into()), None, 0.0, eff),
    ]))
}

// ---- Google Business Profile ----------------------------------------------------

pub fn local(t: &Theme, key: &str, d: &LocalDetail) -> El {
    let (n, b) = (&d.now, &d.before);
    let tile = |k: &str, name: &str, now: f64, before: f64| kit::tile(t, &format!("{key}-{k}"), name, int(now), kit::change(now, before).map(|c| (c, true)), Some(format!("{} the period before", int(before))));
    let strip = kit::cols(vec![
        tile("calls", "Calls", n.calls, b.calls),
        tile("web", "Website clicks", n.website, b.website),
        tile("dir", "Directions", n.directions, b.directions),
        tile("book", "Bookings", n.bookings, b.bookings),
        tile("msg", "Messages", n.conversations, b.conversations),
    ]);
    let actions = n.calls + n.website + n.directions + n.bookings + n.conversations;
    let ch = &t.chart;
    let seen = kit::panel(
        t,
        &format!("{key}-seen"),
        "How people found the profile",
        Some(format!("{} views, {} actions ({} of views)", int(n.views), int(actions), if n.views > 0.0 { pct1(actions / n.views) } else { "—".into() })),
        None,
        0.0,
        col()
            .w_full()
            .gap(16.0)
            .child(kit::split(t, &format!("{key}-surface"), &[("Google Search".into(), n.search, ch.tone(0), int(n.search)), ("Google Maps".into(), n.maps, ch.tone(1), int(n.maps))]))
            .child(label("What they did", type_::XS, t.muted_foreground))
            .child(kit::bars(
                t,
                &format!("{key}-acts"),
                &[("Website clicks".into(), n.website, int(n.website)), ("Calls".into(), n.calls, int(n.calls)), ("Direction requests".into(), n.directions, int(n.directions)), ("Bookings".into(), n.bookings, int(n.bookings)), ("Messages".into(), n.conversations, int(n.conversations))],
                None,
            )),
    );
    let terms = match &d.terms {
        Some((month, list)) if !list.is_empty() => {
            let rows: Vec<(String, f64, String)> = list.iter().take(10).map(|(term, v, at_least)| (term.clone(), *v, format!("{}{} views", if *at_least { "at least " } else { "" }, int(*v)))).collect();
            kit::panel(t, &format!("{key}-terms"), "What people searched", Some(format!("Searches that showed the profile, {month}")), None, 0.0, kit::bars(t, &format!("{key}-term-bars"), &rows, Some(ch.primary)))
        }
        _ => kit::panel(t, &format!("{key}-terms"), "What people searched", None, None, 0.0, kit::note(t, "Google has not reported search terms for this profile yet.")),
    };
    let mut c = col().w_full().gap(16.0).child(strip).child(kit::cols(vec![seen, terms]));
    if let Some(r) = &d.reviews {
        let mut list = col().w_full().gap(12.0);
        for (k, (rating, text, at, replied)) in r.recent.iter().take(4).enumerate() {
            let stars = rating.map(|x| "★".repeat(x.round().clamp(0.0, 5.0) as usize)).unwrap_or_default();
            list = list.child(
                col()
                    .key(format!("{key}-review-{k}"))
                    .w_full()
                    .gap(4.0)
                    .child(
                        row()
                            .w_full()
                            .gap(8.0)
                            .center_y()
                            .child(label(stars, type_::XS, t.partial))
                            .child(label(crate::format::date(at), type_::XS, t.muted_foreground))
                            .child(el().grow(1.0))
                            .child(if *replied { status_chip(t, "Replied", t.supported, t.supported_soft) } else { status_chip(t, "No reply", t.partial, t.partial_soft) }),
                    )
                    .child(label(text.clone(), type_::SM_13, t.foreground).wrap().max_lines(3)),
            );
        }
        let summary = kit::cols(vec![
            kit::tile(t, &format!("{key}-avg"), "Average rating", r.average.map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into()), None, Some(format!("{} reviews in all", int(r.total)))),
            kit::tile(t, &format!("{key}-new"), "New this period", int(r.in_window), None, None),
            kit::tile(t, &format!("{key}-open"), "Waiting for a reply", int(r.unanswered), None, Some(if r.unanswered > 0.0 { "Replies help ranking and trust".into() } else { "All answered".into() })),
        ]);
        c = c.child(kit::panel(
            t,
            &format!("{key}-reviews"),
            "Reviews",
            Some("The latest reviews and whether they were answered".into()),
            (r.unanswered > 0.0).then(|| button(t, &format!("{key}-reply"), "Draft replies", Variant::Outline).on_press(ask("Draft replies to our unanswered Google reviews for me to approve. Do not post anything.".into()))),
            0.0,
            col().w_full().gap(16.0).child(summary).child(list),
        ));
    }
    c
}

// ---- Revenue ---------------------------------------------------------------------

/// The first ad account's totals, when one is connected.
pub fn first_ads(i: &Insights) -> Option<&AdDetail> {
    match &i.ads {
        Source::Reports(list) => list.iter().find_map(|r| match &r.detail {
            Detail::Ads(d) => Some(d),
            _ => None,
        }),
        _ => None,
    }
}

/// Under the revenue hero: value per customer, the pace of the period, the
/// weekly rhythm, the best days, each currency, and revenue against ad spend.
pub fn revenue(s: &App, t: &Theme, i: &Insights, r: &RevenueData) -> El {
    let cur = r.currency.as_str();
    let m = |x: f64| money(x, cur);
    let per = |a: f64, b: f64| (b > 0.0).then(|| a / b);
    let refund = |x: (f64, f64)| per(x.0, x.1);
    let rpc = (per(r.net.0, r.paying.0), per(r.net.1, r.paying.1));
    let opc = (per(r.orders.0, r.paying.0), per(r.orders.1, r.paying.1));
    let rr = (refund((r.refunded.0, r.gross.0)), refund((r.refunded.1, r.gross.1)));
    let days = r.daily.len().max(1) as f64;
    let with_sales = r.daily.iter().filter(|d| d.1 > 0.0).count();
    let strip = kit::cols(vec![
        kit::tile(t, "rev-per-customer", "Per paying customer", rpc.0.map(m).unwrap_or_else(|| "—".into()), rpc.0.zip(rpc.1).and_then(|(a, b)| kit::change(a, b)).map(|c| (c, true)), Some(format!("{} the period before", rpc.1.map(m).unwrap_or_else(|| "—".into())))),
        kit::tile(t, "rev-orders-per", "Orders per customer", opc.0.map(|x| format!("{x:.2}")).unwrap_or_else(|| "—".into()), opc.0.zip(opc.1).and_then(|(a, b)| kit::change(a, b)).map(|c| (c, true)), Some("Times each customer paid".into())),
        kit::tile(t, "rev-per-day", "Average per day", m(r.net.0 / days), kit::change(r.net.0, r.net.1).map(|c| (c, true)), Some(format!("Sales on {with_sales} of {} days", r.daily.len()))),
        kit::tile(t, "rev-refunds", "Refund rate", rr.0.map(pct1).unwrap_or_else(|| "—".into()), rr.0.zip(rr.1).and_then(|(a, b)| kit::change(a, b)).map(|c| (c, false)), Some(format!("{} the period before", rr.1.map(pct1).unwrap_or_else(|| "—".into())))),
    ]);
    let mut c = col().w_full().gap(16.0).child(kit::heading(t, "Revenue analytics", "How the money came in, and what it cost to bring in")).child(strip);

    // The pace: the running total against the period before, and the weekly rhythm.
    if !r.daily.is_empty() {
        let dates: Vec<String> = r.daily.iter().map(|d| d.0.clone()).collect();
        let now_run = kit::running(&r.daily.iter().map(|d| d.1).collect::<Vec<_>>());
        let before_run = kit::running(&r.before);
        let before_run: Vec<Option<f64>> = (0..dates.len()).map(|k| before_run.get(k).copied().flatten()).collect();
        let pace = r.net.1 > 0.0;
        let pace_card = kit::panel(
            t,
            "rev-pace",
            "Running total",
            Some(if pace { format!("{} this period against {} the period before", m(r.net.0), m(r.net.1)) } else { format!("{} this period", m(r.net.0)) }),
            None,
            0.0,
            col()
                .w_full()
                .gap(8.0)
                .child(charts::area_trend(s, t, charts::Trend::new("rev-running", "Running total", &dates, &now_run, t.chart.primary).compare(&before_run, "Period before".into()).height(200.0).width_hint(440.0)))
                .child(row().gap(16.0).child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(4.0).fill(t.chart.primary)).child(label("This period", type_::XS11, t.muted_foreground))).child(charts::dotted_label(t, "Period before"))),
        );
        let wk = kit::by_weekday(&r.daily);
        let best = wk.iter().enumerate().filter_map(|(k, v)| v.map(|v| (k, v))).max_by(|a, b| a.1.total_cmp(&b.1)).map(|x| x.0);
        let items: Vec<(String, f64, String)> = wk.iter().enumerate().map(|(k, v)| (kit::WEEKDAYS[k].to_string(), v.unwrap_or(0.0), v.map(|v| short_money(v, cur)).unwrap_or_else(|| "—".into()))).collect();
        let week_card = kit::panel(
            t,
            "rev-weekday",
            "By day of the week",
            Some(best.map(|b| format!("Average revenue per weekday; {} is strongest", full_day(b))).unwrap_or_else(|| "Average revenue per weekday".into())),
            None,
            0.0,
            kit::columns(t, "rev-weekday-cols", &items, 180.0, best),
        );
        c = c.child(kit::cols(vec![pace_card, week_card]));
    }

    // The best days, and each currency.
    let mut top: Vec<&(String, f64)> = r.daily.iter().filter(|d| d.1 > 0.0).collect();
    top.sort_by(|a, b| b.1.total_cmp(&a.1));
    const DAY_COLS: [Column; 3] = [column("Day", 0.0, false), column("Net revenue", 110.0, true), column("Against average", 120.0, true)];
    let avg = r.net.0 / days;
    let day_rows: Vec<Vec<El>> = top
        .iter()
        .take(6)
        .map(|(d, v)| vec![kit::text(t, format!("{}, {}", kit::weekday(d).map(full_day).unwrap_or(""), crate::format::date(d))), kit::num(t, m(*v)), kit::faint(t, if avg > 0.0 { format!("{:+.0}%", (v / avg - 1.0) * 100.0) } else { "—".into() })])
        .collect();
    let best_days = kit::panel(t, "rev-best", "Best days", Some("The days that brought in the most; look for what ran on them".into()), None, 0.0, if day_rows.is_empty() { kit::note(t, "No sales in this period.") } else { kit::table(t, "rev-best-table", &DAY_COLS, day_rows) });
    const CUR_COLS: [Column; 5] = [column("Currency", 0.0, false), column("Net", 110.0, true), column("Refunded", 96.0, true), column("Orders", 64.0, true), column("Change", 72.0, true)];
    let cur_rows: Vec<Vec<El>> = r
        .currencies
        .iter()
        .map(|(code, net, _gross, refunded, orders, before)| {
            vec![kit::text(t, code.clone()), kit::num(t, money(*net, code)), kit::faint(t, money(*refunded, code)), kit::faint(t, int(*orders)), before.and_then(|b| kit::change(*net, b)).map(|d| kit::change_chip(t, d, true)).unwrap_or_else(|| kit::faint(t, "New"))]
        })
        .collect();
    let currencies = kit::panel(
        t,
        "rev-currencies",
        "By currency",
        Some("Each currency on its own; they are never converted or added".into()),
        None,
        0.0,
        if cur_rows.is_empty() { kit::note(t, "No currency breakdown reported.") } else { kit::table(t, "rev-cur-table", &CUR_COLS, cur_rows) },
    );
    c = c.child(kit::cols(vec![best_days, currencies]));

    // Revenue against ad spend, when an ad account in the same currency is connected.
    let efficiency = match first_ads(i) {
        Some(a) if a.currency.eq_ignore_ascii_case(cur) && a.now.spend > 0.0 => {
            let spend = a.now.spend;
            let mer = (r.net.0 / spend, per(r.net.1, a.before.spend));
            let cac = (per(spend, r.paying.0), r.paying.1.gt(&0.0).then(|| a.before.spend / r.paying.1));
            let ncac = r.new_customers.0.and_then(|n| per(spend, n));
            kit::panel(
                t,
                "rev-efficiency",
                "Revenue against ad spend",
                Some(format!("{} ({}) spent {} in the same period", a.provider, a.currency, m(spend))),
                None,
                0.0,
                col()
                    .w_full()
                    .gap(14.0)
                    .child(kit::cols(vec![
                        kit::tile(t, "rev-mer", "Revenue for every 1 spent", format!("{:.2}", mer.0), mer.1.and_then(|b| kit::change(mer.0, b)).map(|c| (c, true)), Some("Net revenue divided by ad spend".into())),
                        kit::tile(t, "rev-cac", "Ad spend per paying customer", cac.0.map(m).unwrap_or_else(|| "—".into()), cac.0.zip(cac.1).and_then(|(x, y)| kit::change(x, y)).map(|c| (c, false)), Some(format!("{} the period before", cac.1.map(m).unwrap_or_else(|| "—".into())))),
                        kit::tile(t, "rev-ncac", "Ad spend per new customer", ncac.map(m).unwrap_or_else(|| "—".into()), None, Some(rpc.0.zip(ncac).map(|(v, k)| format!("Against {} revenue per customer", m(v)).to_string() + if v >= k { "" } else { ", more than they bring" }).unwrap_or_default())),
                    ]))
                    .child(label("A blended view: it sets all revenue against all ad spend and does not say which ads brought which customers.", type_::XS, t.muted_foreground).wrap()),
            )
        }
        Some(a) => kit::panel(t, "rev-efficiency", "Revenue against ad spend", None, None, 0.0, kit::note(t, format!("Your ads report in {} and Stripe in {}; they are not compared across currencies.", a.currency, cur))),
        None => kit::panel(
            t,
            "rev-efficiency",
            "Revenue against ad spend",
            None,
            Some(button(t, "rev-connect-ads", "Connect ads", Variant::Outline).on_press(|s: &mut App| s.show_page(crate::state::Page::Channels))),
            0.0,
            kit::note(t, "Connect Google Ads or Meta to see revenue for every unit spent and what each paying customer cost."),
        ),
    };
    c.child(efficiency)
}

fn full_day(k: usize) -> &'static str {
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].get(k).copied().unwrap_or("")
}

/// "$1.2k" for a column label.
fn short_money(x: f64, cur: &str) -> String {
    let sym = if cur.eq_ignore_ascii_case("USD") || cur.is_empty() { "$" } else if cur.eq_ignore_ascii_case("EUR") { "€" } else if cur.eq_ignore_ascii_case("GBP") { "£" } else { "" };
    if x >= 1000.0 { format!("{sym}{:.1}k", x / 1000.0) } else { format!("{sym}{x:.0}") }
}

// ---- Funnel ----------------------------------------------------------------------

/// One funnel step: its name, this period's count, the change, and its source.
pub type Step<'a> = (String, f64, Option<f64>, &'a str);

/// Under the funnel: each step against the period before, the weakest
/// hand-off, what each step cost in ads, and where the journey starts.
pub fn funnel(s: &App, t: &Theme, i: &Insights, steps: &[Step<'_>]) -> El {
    let before = |st: &Step<'_>| st.2.filter(|d| (1.0 + d).abs() > f64::EPSILON).map(|d| st.1 / (1.0 + d));
    const COLS: [Column; 6] = [column("Step", 0.0, false), column("This period", 96.0, true), column("Before", 88.0, true), column("Change", 72.0, true), column("To next step", 96.0, true), column("Before", 88.0, true)];
    let mut rows = Vec::new();
    let mut weakest: Option<(usize, f64)> = None;
    for (k, st) in steps.iter().enumerate() {
        let next = steps.get(k + 1);
        let rate = next.and_then(|n| (st.1 > 0.0).then(|| n.1 / st.1));
        let rate_before = next.and_then(|n| before(st).zip(before(n))).and_then(|(a, b)| (a > 0.0).then(|| b / a));
        if let Some(r) = rate {
            if weakest.is_none_or(|w| r < w.1) {
                weakest = Some((k, r));
            }
        }
        rows.push(vec![
            col().gap(0.0).child(label(st.0.clone(), type_::SM_13, t.foreground).truncate()).child(label(st.3.to_string(), type_::XS11, t.muted_foreground)),
            kit::num(t, int(st.1)),
            kit::faint(t, before(st).map(|b| int(b.round())).unwrap_or_else(|| "—".into())),
            st.2.map(|d| kit::change_chip(t, d, true)).unwrap_or_else(|| kit::faint(t, "—")),
            match (rate, rate_before) {
                (Some(r), Some(b)) => row().gap(6.0).center_y().child(kit::num(t, pct1(r))).child(kit::points_chip(t, (r - b) * 100.0, true)),
                (Some(r), None) => kit::num(t, pct1(r)),
                _ => kit::faint(t, "—"),
            },
            kit::faint(t, rate_before.map(pct1).unwrap_or_else(|| "—".into())),
        ]);
    }
    let mut c = col().w_full().gap(16.0).child(kit::panel(
        t,
        "funnel-steps",
        "Step by step",
        Some("Each step against the period before, and the share that reached the next one".into()),
        None,
        0.0,
        kit::table(t, "funnel-step-table", &COLS, rows),
    ));
    if let Some((k, r)) = weakest {
        let (from, to) = (&steps[k].0, &steps[k + 1].0);
        c = c.child(kit::callout(
            t,
            "funnel-weakest",
            t.partial,
            format!("The biggest drop is from \"{from}\" to \"{to}\": {} make it through", pct1(r)),
            "Improving the weakest hand-off usually moves the end result most. Ask the agent what is getting in the way there.".into(),
            Some(button(t, "funnel-ask", "Find the cause", Variant::Outline).on_press(ask(format!(
                "Our funnel loses the most people between \"{from}\" and \"{to}\" ({} make it through). Look at the evidence we have and propose what to change, for me to approve.",
                pct1(r)
            )))),
        ));
    }

    // What each step cost in ad spend, when an ad account is connected.
    let cost = match first_ads(i) {
        Some(a) if a.now.spend > 0.0 => {
            const CCOLS: [Column; 3] = [column("Step", 0.0, false), column("Count", 88.0, true), column("Ad spend per step", 130.0, true)];
            let crow: Vec<Vec<El>> = steps.iter().filter(|st| st.1 > 0.0).map(|st| vec![kit::text(t, st.0.clone()), kit::faint(t, int(st.1)), kit::num(t, money(a.now.spend / st.1, &a.currency))]).collect();
            kit::panel(
                t,
                "funnel-cost",
                "What each step costs",
                Some(format!("{} of {} ad spend divided by each step", money(a.now.spend, &a.currency), a.provider)),
                None,
                0.0,
                col().w_full().gap(10.0).child(kit::table(t, "funnel-cost-table", &CCOLS, crow)).child(label("Blended: not every step came from ads, so read this as an upper bound on what ads paid per step.", type_::XS, t.muted_foreground).wrap()),
            )
        }
        _ => kit::panel(
            t,
            "funnel-cost",
            "What each step costs",
            None,
            Some(button(t, "funnel-connect-ads", "Connect ads", Variant::Outline).on_press(|s: &mut App| s.show_page(crate::state::Page::Channels))),
            0.0,
            kit::note(t, "Connect Google Ads or Meta to see ad spend per click, per goal and per paying customer."),
        ),
    };
    // Where the journey starts: the pages search sends people to, and AI assistants.
    let pages: Vec<(String, f64, String)> = match &i.search {
        Source::Reports(list) => list
            .iter()
            .find_map(|r| match &r.detail {
                Detail::Search { pages, .. } => Some(pages.iter().take(6).map(|p| (p.key.clone(), p.clicks, format!("{} clicks", int(p.clicks)))).collect()),
                _ => None,
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let entry = kit::panel(
        t,
        "funnel-entry",
        "Where the journey starts",
        Some("The pages search visitors land on first".into()),
        None,
        0.0,
        if pages.is_empty() { kit::note(t, "Connect Google Search Console to see the pages people arrive on.") } else { kit::bars(t, "funnel-entry-bars", &pages, Some(t.chart.primary)) },
    );
    c = c.child(kit::cols(vec![cost, entry]));

    // AI assistants as a way in, kept separate from the steps above.
    if let Ok(Some(d)) = &i.discovery {
        let of = |x: &str| -> Option<(f64, f64)> {
            let (n, d) = x.split_once(" of ")?;
            Some((n.trim().replace(',', "").parse().ok()?, d.trim().replace(',', "").parse().ok()?))
        };
        let mention = d.period.as_ref().and_then(|p| of(&p.2));
        let link = d.period.as_ref().and_then(|p| of(&p.3));
        let share = |x: Option<(f64, f64)>| x.filter(|x| x.1 > 0.0).map(|x| format!("{:.0}%", x.0 / x.1 * 100.0)).unwrap_or_else(|| "—".into());
        let tiles = vec![
            kit::tile(t, "funnel-ai-mention", "Answers that mention you", share(mention), None, mention.map(|x| format!("{} of {} answers", int(x.0), int(x.1)))),
            kit::tile(t, "funnel-ai-link", "Answers that link to you", share(link), None, link.map(|x| format!("{} of {} answers", int(x.0), int(x.1)))),
            kit::tile(t, "funnel-ai-visits", "Visits from AI assistants", d.referral.as_ref().map(|r| int(r.0)).unwrap_or_else(|| "—".into()), None, d.referral.as_ref().map(|r| format!("{} of all visits", share(Some((r.0, r.1)))))),
            kit::tile(t, "funnel-ai-signups", "Sign-ups after those visits", d.referral.as_ref().and_then(|r| r.3).map(int).unwrap_or_else(|| "—".into()), None, d.referral.as_ref().map(|r| r.2.clone())),
        ];
        let _ = s;
        c = c.child(kit::panel(
            t,
            "funnel-ai",
            "AI assistants as a way in",
            Some("Being named and linked in answers, then the visits and sign-ups that followed. Measured separately from the steps above.".into()),
            None,
            0.0,
            kit::cols(tiles),
        ));
    }
    c
}

// ---- Events ----------------------------------------------------------------------

/// The goal event in detail: its key numbers, rhythm, weeks and pace, then
/// every other action the connected accounts count.
pub fn events(s: &App, t: &Theme, i: &Insights, g: &Goal, chart: El) -> El {
    let days = i.days as i64;
    let now_s = crate::format::now();
    let cut = crate::format::iso_date(now_s - days * 86_400);
    let start = crate::format::iso_date(now_s - 2 * days * 86_400);
    let mut pts = g.points.clone();
    pts.sort_by(|a, b| a.0.cmp(&b.0));
    let cur: Vec<(String, f64)> = pts.iter().filter(|p| p.0.as_str() > cut.as_str()).cloned().collect();
    let prev: Vec<(String, f64)> = pts.iter().filter(|p| p.0.as_str() <= cut.as_str() && p.0.as_str() > start.as_str()).cloned().collect();
    let (total, total_before) = (cur.iter().map(|p| p.1).sum::<f64>(), prev.iter().map(|p| p.1).sum::<f64>());
    let avg = if cur.is_empty() { None } else { Some(total / cur.len() as f64) };
    let avg_before = if prev.is_empty() { None } else { Some(total_before / prev.len() as f64) };
    let best = cur.iter().max_by(|a, b| a.1.total_cmp(&b.1));
    let last7: f64 = cur.iter().rev().take(7).map(|p| p.1).sum();
    let prev7: f64 = cur.iter().rev().skip(7).take(7).map(|p| p.1).sum();
    let fmt = |x: f64| charts::format_count((x * 10.0).round() / 10.0);
    let strip = kit::cols(vec![
        kit::tile(t, "ev-total", &g.label, fmt(total), kit::change(total, total_before).map(|c| (c, true)), Some(format!("{} the period before", fmt(total_before)))),
        kit::tile(t, "ev-avg", "Per day", avg.map(fmt).unwrap_or_else(|| "—".into()), avg.zip(avg_before).and_then(|(a, b)| kit::change(a, b)).map(|c| (c, true)), Some("On days with a value".into())),
        kit::tile(t, "ev-week", "Last 7 days", fmt(last7), kit::change(last7, prev7).map(|c| (c, true)), Some(format!("{} the 7 days before", fmt(prev7)))),
        kit::tile(t, "ev-best", "Best day", best.map(|b| fmt(b.1)).unwrap_or_else(|| "—".into()), None, best.map(|b| crate::format::date(&b.0))),
        kit::tile(t, "ev-coverage", "Days recorded", format!("{} of {}", cur.len(), days), None, Some(if (cur.len() as i64) < days { "Gaps are not zero".into() } else { "Every day has a value".into() })),
    ]);
    let mut c = col().w_full().gap(16.0).child(strip).child(chart);
    if cur.is_empty() {
        return c;
    }

    // The weekly rhythm, and week by week.
    let wk = kit::by_weekday(&cur);
    let top = wk.iter().enumerate().filter_map(|(k, v)| v.map(|v| (k, v))).max_by(|a, b| a.1.total_cmp(&b.1)).map(|x| x.0);
    let items: Vec<(String, f64, String)> = wk.iter().enumerate().map(|(k, v)| (kit::WEEKDAYS[k].to_string(), v.unwrap_or(0.0), v.map(fmt).unwrap_or_else(|| "—".into()))).collect();
    let weekday = kit::panel(
        t,
        "ev-weekday",
        "By day of the week",
        Some(top.map(|k| format!("Average per weekday; {} is strongest", full_day(k))).unwrap_or_default()),
        None,
        0.0,
        kit::columns(t, "ev-weekday-cols", &items, 160.0, top),
    );
    // Weeks ending on the latest day, newest first.
    let mut weeks: Vec<(String, String, f64, usize)> = Vec::new();
    for chunk in cur.rchunks(7) {
        weeks.push((chunk.first().map(|p| p.0.clone()).unwrap_or_default(), chunk.last().map(|p| p.0.clone()).unwrap_or_default(), chunk.iter().map(|p| p.1).sum(), chunk.len()));
    }
    weeks.reverse();
    const WCOLS: [Column; 4] = [column("Week", 0.0, false), column("Days", 48.0, true), column("Total", 72.0, true), column("Change", 72.0, true)];
    let wrows: Vec<Vec<El>> = weeks
        .iter()
        .enumerate()
        .rev()
        .map(|(k, (a, b, v, n))| {
            let before = k.checked_sub(1).and_then(|j| weeks.get(j)).filter(|w| w.3 == *n && *n == 7).map(|w| w.2);
            vec![
                kit::text(t, format!("{} to {}", crate::format::short_day(a), crate::format::short_day(b))),
                kit::faint(t, n.to_string()),
                kit::num(t, fmt(*v)),
                before.and_then(|b| kit::change(*v, b)).map(|d| kit::change_chip(t, d, true)).unwrap_or_else(|| kit::faint(t, "—")),
            ]
        })
        .collect();
    let weekly = kit::panel(t, "ev-weeks", "Week by week", Some("Newest first; a partial week is not compared".into()), None, 0.0, kit::table(t, "ev-week-table", &WCOLS, wrows));
    c = c.child(kit::cols(vec![weekday, weekly]));

    // The pace against the period before, and the event's definition.
    let dates: Vec<String> = cur.iter().map(|p| p.0.clone()).collect();
    let run = kit::running(&cur.iter().map(|p| p.1).collect::<Vec<_>>());
    let run_before = kit::running(&prev.iter().map(|p| p.1).collect::<Vec<_>>());
    let run_before: Vec<Option<f64>> = (0..dates.len()).map(|k| run_before.get(k).copied().flatten()).collect();
    let pace = kit::panel(
        t,
        "ev-pace",
        "Running total",
        Some(format!("{} this period against {} the period before", fmt(total), fmt(total_before))),
        None,
        0.0,
        col()
            .w_full()
            .gap(8.0)
            .child(charts::area_trend(s, t, charts::Trend::new("ev-running", "Running total", &dates, &run, t.chart.primary).compare(&run_before, "Period before".into()).height(180.0).width_hint(440.0)))
            .child(row().gap(16.0).child(row().gap(6.0).center_y().child(el().size(8.0, 8.0).radius(4.0).fill(t.chart.primary)).child(label("This period", type_::XS11, t.muted_foreground))).child(charts::dotted_label(t, "Period before"))),
    );
    let counting = match g.counting.as_str() {
        "EVENT_COUNT" => "Each time the event fires, not distinct people",
        "SUM" => "The sum of values in the source report",
        _ => "As the saved metric defines it",
    };
    let field = |name: &str, value: String| col().w_full().gap(2.0).child(label(name.to_string(), type_::XS11, t.muted_foreground)).child(label(value, type_::SM_13, t.foreground).wrap());
    let definition = kit::panel(
        t,
        "ev-definition",
        "How it is counted",
        None,
        Some(button(t, "events-accounts", "Manage accounts", Variant::Outline).on_press(|s: &mut App| s.show_page(crate::state::Page::Channels))),
        0.0,
        col()
            .w_full()
            .gap(12.0)
            .child(field("Event name", g.event_name.clone().unwrap_or_else(|| "Not configured".into())))
            .child(field("Counting", counting.into()))
            .child(field("Reporting time zone", g.time_zone.clone().unwrap_or_else(|| "Not configured".into())))
            .child(field(
                "Source",
                match g.source.as_deref() {
                    Some("GA4_AGGREGATE_EXPORT") => "Google Analytics, daily".into(),
                    Some(x) => x.replace('_', " ").to_lowercase(),
                    None => "Imported exports".into(),
                },
            )),
    );
    c.child(kit::cols(vec![pace, definition]))
}

/// Every other action a connected account counts: ad conversions, profile
/// actions, orders and AI-referred sign-ups. Each in its own source's terms.
pub fn other_actions(t: &Theme, i: &Insights) -> El {
    let mut rows: Vec<(String, String, f64, Option<f64>)> = Vec::new();
    if let Source::Reports(list) = &i.ads {
        for r in list {
            if let Detail::Ads(a) = &r.detail {
                rows.push(("Conversions".into(), a.provider.clone(), a.now.conversions, kit::change(a.now.conversions, a.before.conversions)));
                rows.push(("Ad clicks".into(), a.provider.clone(), a.now.clicks, kit::change(a.now.clicks, a.before.clicks)));
            }
        }
    }
    if let Source::Reports(list) = &i.search {
        for r in list {
            if let Some(m) = r.metrics.iter().find(|m| m.label == "Clicks") {
                if let Some(v) = crate::ui::overview_number(&m.value) {
                    rows.push(("Search clicks".into(), "Google Search".into(), v, m.delta));
                }
            }
        }
    }
    if let Source::Reports(list) = &i.local {
        for r in list {
            if let Detail::Local(d) = &r.detail {
                for (name, now, before) in [("Calls", d.now.calls, d.before.calls), ("Website clicks", d.now.website, d.before.website), ("Direction requests", d.now.directions, d.before.directions), ("Bookings", d.now.bookings, d.before.bookings)] {
                    if now > 0.0 || before > 0.0 {
                        rows.push((name.into(), "Business Profile".into(), now, kit::change(now, before)));
                    }
                }
            }
        }
    }
    if let Some(r) = &i.revenue_data {
        rows.push(("Paid orders".into(), "Stripe".into(), r.orders.0, kit::change(r.orders.0, r.orders.1)));
        if let Some(n) = r.new_customers.0 {
            rows.push(("New customers".into(), "Stripe".into(), n, r.new_customers.1.and_then(|b| kit::change(n, b))));
        }
    }
    if let Ok(Some(d)) = &i.discovery {
        if let Some(n) = d.referral.as_ref().and_then(|r| r.3) {
            rows.push(("Sign-ups after AI visits".into(), "Google Analytics export".into(), n, None));
        }
    }
    const COLS: [Column; 4] = [column("Action", 0.0, false), column("Counted by", 160.0, false), column("This period", 96.0, true), column("Change", 72.0, true)];
    let body = if rows.is_empty() {
        kit::note(t, "Connect ads, Search Console, a Business Profile or Stripe to see the actions they count.")
    } else {
        let max = rows.iter().map(|r| r.2).fold(0.0, f64::max).max(1.0);
        kit::table(
            t,
            "ev-other-table",
            &COLS,
            rows.into_iter()
                .map(|(name, src, v, d)| {
                    vec![
                        col().w_full().gap(4.0).child(kit::text(t, name)).child(row().w_full().h(4.0).radius(2.0).fill(t.foreground.alpha(0.05)).child(el().w_frac((v / max) as f32).h_full().radius(2.0).fill(t.chart.primary.alpha(0.7)))),
                        kit::faint(t, src),
                        kit::num(t, charts::format_count((v * 10.0).round() / 10.0)),
                        d.map(|d| kit::change_chip(t, d, true)).unwrap_or_else(|| kit::faint(t, "—")),
                    ]
                })
                .collect(),
        )
    };
    kit::panel(t, "ev-other", "Other tracked actions", Some("Everything your connected accounts count, each over its own dates and in its own terms, so they are not added together".into()), None, 0.0, body)
}
