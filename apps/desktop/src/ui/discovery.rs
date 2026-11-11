//! The AI discovery hero chart and the per-model cards (`HeroChart`,
//! `ModelSmallMultiples`, `AnswerCollectionCard` and `AccuracyByModelCard` in
//! `routes/today.tsx`).

use rune::{Cursor, El, col, el, row};

use crate::brands::{self, Series};
use crate::insights::{Analytics, Goal, Insights, Verdicts, pct};
use crate::state::{App, Metric};
use crate::theme::{Theme, shadows, type_};
use crate::ui::charts::{self, Trend};
use crate::ui::widgets::{CONTROL, card, label};

/// One model series' totals for the period.
pub struct ModelStat {
    pub series: Series,
    pub answers: i64,
    pub prev: i64,
    pub v: Verdicts,
}

/// Everything the cards derive from one analytics payload, grouped per model series.
pub struct Stats {
    pub series: Vec<Series>,
    pub models: Vec<ModelStat>,
    /// Dates and, per date, answers for each series in `series` order.
    pub dates: Vec<String>,
    pub rows: Vec<Vec<f64>>,
    pub total: i64,
    pub prev_total: i64,
}

fn add(a: &mut Verdicts, b: &Verdicts) {
    a.supported += b.supported;
    a.wrong += b.wrong;
    a.partial += b.partial;
    a.unknown += b.unknown;
    a.unreviewed += b.unreviewed;
}

pub fn stats(a: &Analytics) -> Stats {
    let names = a.providers.iter().map(|p| p.name.as_str()).chain(a.provider_daily.iter().map(|d| d.1.as_str()));
    let series = brands::model_series(names);
    let owner = |p: &str| series.iter().position(|s| s.members.iter().any(|m| m == p));
    let models: Vec<ModelStat> = series
        .iter()
        .map(|s| {
            let members: Vec<_> = a.providers.iter().filter(|p| s.members.contains(&p.name)).collect();
            let mut v = Verdicts::default();
            members.iter().for_each(|p| add(&mut v, &p.v));
            ModelStat { series: s.clone(), answers: members.iter().map(|p| p.answers).sum(), prev: members.iter().map(|p| p.prev_answers).sum(), v }
        })
        .collect();
    let mut dates: Vec<String> = a.provider_daily.iter().map(|d| d.0.clone()).collect();
    dates.sort();
    dates.dedup();
    let mut rows = vec![vec![0.0; series.len()]; dates.len()];
    for (date, p, n) in &a.provider_daily {
        if let (Ok(i), Some(j)) = (dates.binary_search(date), owner(p)) {
            rows[i][j] += *n as f64;
        }
    }
    let total = models.iter().map(|m| m.answers).sum();
    let prev_total = models.iter().map(|m| m.prev).sum();
    Stats { series, models, dates, rows, total, prev_total }
}

impl Metric {
    /// The trend switcher's tab name.
    fn tab(self) -> &'static str {
        match self {
            Metric::Accuracy => "Correct answers",
            Metric::Wrong => "Wrong answers",
            Metric::Answers => "Answers collected",
            Metric::Checks => "Checks run",
            Metric::Partial => "Partly right",
            Metric::Unreviewed => "Needs review",
            Metric::Goal => "Goal",
        }
    }
    /// The plotted line's name (`metricMeta`).
    fn name(self) -> &'static str {
        match self {
            Metric::Answers => "Answers collected",
            Metric::Accuracy => "Supported share",
            Metric::Wrong => "Wrong",
            Metric::Partial => "Partly right",
            Metric::Unreviewed => "Needs review",
            Metric::Checks => "Checks run",
            Metric::Goal => "Goal",
        }
    }
    fn subtitle(self) -> &'static str {
        match self {
            Metric::Answers => "Answers collected per provider, per day",
            Metric::Accuracy => "Share of rated answers that were correct, per day",
            Metric::Checks => "Checks queued for configured providers, per day",
            Metric::Unreviewed => "Answers waiting for your rating, per day",
            Metric::Wrong => "Wrong answers, per day",
            Metric::Partial => "Partly right answers, per day",
            Metric::Goal => "",
        }
    }
    /// What "split" shows for this metric, if anything.
    fn split(self) -> Option<&'static str> {
        match self {
            Metric::Answers => Some("By provider"),
            Metric::Checks | Metric::Goal => None,
            _ => Some("By rating"),
        }
    }
    /// The split view's share line: its name and the verdict it counts.
    fn share(self, v: &Verdicts) -> Option<(&'static str, i64)> {
        Some(match self {
            Metric::Accuracy => ("Supported share", v.supported),
            Metric::Wrong => ("Wrong share", v.wrong),
            Metric::Partial => ("Partially correct share", v.partial),
            Metric::Unreviewed => ("Share needing review", v.unreviewed),
            _ => return None,
        })
    }
}

/// A segmented control in the web's `TabsList` style.
pub fn tabs(t: &Theme, key: &str, items: Vec<(String, bool, Box<dyn Fn(&mut App)>)>) -> El {
    let mut r = row().key(key).h(32.0).padding(3.0).gap(2.0).radius(8.0).fill(t.accent).role("tablist");
    for (i, (name, on, act)) in items.into_iter().enumerate() {
        let mut chip = row()
            .key(format!("{key}-{i}"))
            .h_full()
            .px(10.0)
            .radius(6.0)
            .center()
            .role("tab")
            .label(name.clone())
            .checked(on)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .motion(CONTROL)
            .on_press(move |s: &mut App| act(s))
            .child(label(name, type_::XS_MEDIUM, if on { t.foreground } else { t.muted_foreground }));
        if on {
            chip = shadows(chip.fill(t.control), &t.control_shadow);
        }
        r = r.child(chip);
    }
    r
}

fn switcher(s: &App, t: &Theme, goal: Option<&Goal>) -> El {
    let mut items: Vec<(String, bool, Box<dyn Fn(&mut App)>)> = [Metric::Accuracy, Metric::Wrong, Metric::Answers, Metric::Checks]
        .into_iter()
        .map(|m| (m.tab().to_string(), s.metric == m, Box::new(move |s: &mut App| s.set_metric(m)) as Box<dyn Fn(&mut App)>))
        .collect();
    if let Some(g) = goal {
        items.push((g.label.clone(), s.metric == Metric::Goal, Box::new(|s: &mut App| s.set_metric(Metric::Goal))));
    }
    tabs(t, "trend-metric", items)
}

fn empty(t: &Theme, days: u32, what: &str) -> El {
    col()
        .w_full()
        .h(280.0)
        .center()
        .gap(4.0)
        .radius(12.0)
        .border(1.0, t.border)
        .child(label(format!("No {what} in the last {days} days"), type_::XS_MEDIUM, t.foreground))
        .child(label("Try a longer period, or run a check to collect fresh answers.", type_::XS, t.muted_foreground))
}

/// The hero: the metric tabs, the Trend / split toggle and the chart they pick.
pub fn hero(s: &App, t: &Theme, i: &Insights, a: &Analytics, st: &Stats) -> El {
    let goal = i.goal.as_ref().ok().and_then(|g| g.as_ref());
    let metric = if s.metric == Metric::Goal && goal.is_none() { Metric::Accuracy } else { s.metric };
    let w = charts::window(i.days);
    let avg_name = format!("{w}-day average");

    let mut head = col().min_w(0.0).gap(8.0).child(row().child(switcher(s, t, goal)));
    let subtitle = if metric == Metric::Goal {
        let from = match goal.and_then(|g| g.source.as_deref()) {
            Some("GA4_AGGREGATE_EXPORT") => "Google Analytics",
            _ => "imported exports",
        };
        format!("{} per day, from {from}, last {} days", goal.map(|g| g.label.as_str()).unwrap_or("Goal"), i.days)
    } else {
        format!("{}, last {} days", metric.subtitle(), i.days)
    };
    head = head.child(label(subtitle, type_::XS, t.muted_foreground));
    let mut top = row().w_full().gap(12.0).items_end().flex_wrap().child(head.grow(1.0));
    if let Some(split) = metric.split() {
        top = top.child(tabs(
            t,
            "trend-view",
            vec![("Trend".into(), !s.split, Box::new(|s: &mut App| s.set_split(false))), (split.into(), s.split, Box::new(|s: &mut App| s.set_split(true)))],
        ));
    }
    let mut c = col().key("hero").w_full().gap(12.0).child(top);

    if metric == Metric::Goal {
        return c.child(match goal {
            Some(g) => goal_trend(s, t, g, i.days, "hero-goal"),
            None => empty(t, i.days, "measurements"),
        });
    }

    // The first day covers only part of a day, so it stays out of every trend.
    let daily = a.daily.get(1..).unwrap_or(&[]);
    let dates: Vec<String> = daily.iter().map(|d| d.date.clone()).collect();
    let values: Vec<Option<f64>> = match metric {
        Metric::Answers => {
            let by_date = |d: &str| st.dates.binary_search_by(|x| x.as_str().cmp(d)).ok().map(|k| st.rows[k].iter().sum::<f64>()).unwrap_or(0.0);
            daily.iter().map(|d| Some(by_date(&d.date))).collect()
        }
        Metric::Accuracy => daily.iter().map(|d| d.v.accuracy().map(|x| (x * 1000.0).round() / 10.0)).collect(),
        Metric::Checks => daily.iter().map(|d| Some(d.checks as f64)).collect(),
        Metric::Wrong => daily.iter().map(|d| Some(d.v.wrong as f64)).collect(),
        Metric::Partial => daily.iter().map(|d| Some(d.v.partial as f64)).collect(),
        Metric::Unreviewed => daily.iter().map(|d| Some(d.v.unreviewed as f64)).collect(),
        Metric::Goal => vec![],
    };
    let nothing = values.iter().all(|v| v.unwrap_or(0.0) == 0.0) && a.current.total() == 0 && st.total == 0;
    if nothing {
        return c.child(empty(t, i.days, "answers"));
    }

    if s.split && metric == Metric::Answers {
        return c.child(small_multiples(s, t, st)).child(model_chips(s, t, st));
    }
    if s.split {
        let Some((name, _)) = metric.share(&Verdicts::default()) else { return c };
        let share: Vec<Option<f64>> = daily
            .iter()
            .map(|d| {
                let total = d.v.total();
                (total > 0).then(|| (metric.share(&d.v).map(|x| x.1).unwrap_or(0) as f64 / total as f64 * 1000.0).round() / 10.0)
            })
            .collect();
        let avg = charts::trailing(&share, w);
        let color = match metric {
            Metric::Wrong => t.chart.wrong,
            Metric::Partial => t.chart.partial,
            Metric::Unreviewed => t.chart.unreviewed,
            _ => t.chart.supported,
        };
        return c
            .child(charts::area_trend(s, t, Trend::new("hero-share", name, &dates, &share, color).compare(&avg, avg_name.clone()).height(280.0).percent()))
            .child(charts::trend_legend(t, name, color, Some(&avg_name)));
    }

    let avg = charts::trailing(&values, w);
    let mut tr = Trend::new("hero-trend", metric.name(), &dates, &values, t.chart.primary).compare(&avg, avg_name.clone()).height(280.0);
    if metric == Metric::Accuracy {
        tr = tr.percent();
    }
    c = c.child(charts::area_trend(s, t, tr)).child(charts::trend_legend(t, metric.name(), t.chart.primary, Some(&avg_name)));
    c
}

/// The goal's daily values for the last `days` days (`GoalTrend`); a day
/// without an import is a gap, not zero.
pub fn goal_trend(s: &App, t: &Theme, g: &Goal, days: u32, key: &str) -> El {
    let mut pts: Vec<(String, f64)> = g.points.clone();
    pts.sort_by(|a, b| a.0.cmp(&b.0));
    let pts = &pts[pts.len().saturating_sub(days as usize)..];
    if pts.is_empty() {
        return col()
            .w_full()
            .h(280.0)
            .center()
            .gap(4.0)
            .radius(12.0)
            .border(1.0, t.border)
            .child(label(format!("No measurements in the last {days} days"), type_::XS_MEDIUM, t.foreground))
            .child(label("Connect a measurement account from Channels, or import daily results in the business's growth settings.", type_::XS, t.muted_foreground).wrap().max_w(320.0));
    }
    let dates: Vec<String> = pts.iter().map(|p| p.0.clone()).collect();
    let values: Vec<Option<f64>> = pts.iter().map(|p| Some(p.1)).collect();
    let name = format!("{} per day", g.label);
    col()
        .w_full()
        .gap(8.0)
        .child(charts::area_trend(s, t, Trend::new(key, &g.label, &dates, &values, t.chart.primary).height(280.0)))
        .child(charts::trend_legend(t, &name, t.chart.primary, None))
}

/// One small trend per model, so no model hides behind another.
fn small_multiples(s: &App, t: &Theme, st: &Stats) -> El {
    let rows = st.rows.get(1..).unwrap_or(&[]);
    let dates = st.dates.get(1..).unwrap_or(&[]);
    let mut ranked: Vec<(usize, f64)> =
        st.series.iter().enumerate().filter(|(_, x)| !s.hidden_models.contains(&x.key)).map(|(j, _)| (j, rows.iter().map(|r| r[j]).sum::<f64>())).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let count = ranked.len();
    let shown = if s.all_models { count } else { count.min(4) };
    let mut tiles = Vec::new();
    for (j, total) in ranked.into_iter().take(shown) {
        let x = &st.series[j];
        let values: Vec<Option<f64>> = rows.iter().map(|r| Some(r[j])).collect();
        let key = format!("model-trend-{}", x.key);
        let dim = s.model_focus.as_ref().is_some_and(|f| f != &x.key);
        let tile = card(t)
            .key(format!("multiple-{}", x.key))
            .grow(1.0)
            .min_w(0.0)
            .padding(12.0)
            .gap(4.0)
            .opacity(if dim { 0.4 } else { 1.0 })
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .px(4.0)
                    .pb(4.0)
                    .child(brands::series_logo(t, x, 16.0))
                    .child(label(x.label.clone(), type_::XS_MEDIUM, t.foreground).truncate().grow(1.0).min_w(0.0))
                    .child(label(format!("{} answers", crate::insights::int(total)), type_::XS.features("'tnum' 1"), t.muted_foreground)),
            )
            .child(charts::area_trend(s, t, Trend::new(&key, &x.label, dates, &values, x.color(t)).height(110.0).width_hint(380.0)));
        tiles.push(tile);
    }
    // Two to a row, as the web's `sm:grid-cols-2`.
    let mut grid = col().w_full().gap(12.0);
    let mut it = tiles.into_iter();
    while let Some(a) = it.next() {
        let b = it.next().unwrap_or_else(|| el().grow(1.0).min_w(0.0));
        grid = grid.child(row().w_full().gap(12.0).child(a).child(b));
    }
    let mut c = col().w_full().gap(12.0).child(grid);
    if count > 4 {
        let text_ = if s.all_models { "Show fewer providers".to_string() } else { format!("Show all {count} providers") };
        c = c.child(
            row().w_full().center().child(
                row()
                    .key("models-more")
                    .h(28.0)
                    .px(10.0)
                    .radius(6.0)
                    .center()
                    .role("button")
                    .label(text_.clone())
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .hover(t.hover_tint)
                    .on_press(|s: &mut App| s.all_models = !s.all_models)
                    .child(label(text_, type_::XS_MEDIUM, t.foreground)),
            ),
        );
    }
    c
}

/// The model chips under the small multiples: a press hides or shows a model,
/// hovering one fades the others.
fn model_chips(s: &App, t: &Theme, st: &Stats) -> El {
    let mut ranked: Vec<&ModelStat> = st.models.iter().collect();
    ranked.sort_by(|a, b| b.answers.cmp(&a.answers));
    let total = st.series.len();
    let mut r = row().key("model-chips").w_full().gap(4.0).flex_wrap();
    for m in ranked {
        let key = m.series.key.clone();
        let off = s.hidden_models.contains(&key);
        let (k1, k2) = (key.clone(), key.clone());
        r = r.child(
            row()
                .key(format!("chip-{key}"))
                .gap(6.0)
                .center_y()
                .px(8.0)
                .py(4.0)
                .radius(6.0)
                .role("switch")
                .label(m.series.label.clone())
                .checked(!off)
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .opacity(if off { 0.4 } else { 1.0 })
                .on_press(move |s: &mut App| s.toggle_model(&k1, total))
                .on_hover_change(move |s: &mut App, inside, _| {
                    if inside && !s.hidden_models.contains(&k2) {
                        s.model_focus = Some(k2.clone());
                    } else if s.model_focus.as_deref() == Some(k2.as_str()) {
                        s.model_focus = None;
                    }
                })
                .child(el().size(8.0, 8.0).radius(4.0).fill(m.series.color(t)))
                .child(label(m.series.label.clone(), type_::XS, t.foreground))
                .child(label(crate::insights::int(m.answers as f64), type_::XS.features("'tnum' 1"), t.muted_foreground)),
        );
    }
    r
}

fn panel(t: &Theme, key: &str, title: &str, description: String) -> El {
    card(t)
        .key(key)
        .grow(1.0)
        .min_w(360.0)
        .px(8.0)
        .pt(16.0)
        .pb(8.0)
        .gap(8.0)
        .child(col().w_full().px(8.0).gap(2.0).child(label(title, type_::SM_MEDIUM, t.foreground).role("heading")).child(label(description, type_::XS, t.muted_foreground).wrap()))
}

fn header(t: &Theme, cells: &[(&str, Option<f32>)]) -> El {
    let mut r = row().w_full().gap(12.0).px(8.0).pb(2.0);
    for (i, (name, w)) in cells.iter().enumerate() {
        let l = label(name.to_string(), type_::XS11, t.muted_foreground);
        r = r.child(match w {
            Some(w) => row().w(*w).child(if i > 0 { el().grow(1.0) } else { el() }).child(l),
            None => row().grow(1.0).min_w(0.0).child(l),
        });
    }
    r
}

fn faint(t: &Theme, text_: String) -> El {
    row().w_full().px(8.0).py(32.0).center().child(label(text_, type_::XS, t.muted_foreground))
}

/// Share of collected answers per provider, and the change in share points.
pub fn answer_collection(t: &Theme, st: &Stats, days: u32) -> El {
    let desc = format!("{} answers collected across {} providers", crate::insights::int(st.total as f64), st.series.len());
    let p = panel(t, "answers-by-provider", "Answers by provider", desc);
    if st.total == 0 {
        return p.child(faint(t, format!("No answers in the last {days} days.")));
    }
    let mut ranked: Vec<&ModelStat> = st.models.iter().collect();
    ranked.sort_by(|a, b| b.answers.cmp(&a.answers));
    let share = |m: &ModelStat| m.answers as f64 / st.total as f64;
    let max = ranked.iter().map(|m| share(m)).fold(0.01, f64::max);
    let mut list = col().w_full().gap(4.0);
    for m in ranked {
        let sh = share(m);
        let pts = (st.prev_total > 0).then(|| ((sh - m.prev as f64 / st.prev_total as f64) * 1000.0).round() / 10.0);
        let change = match pts {
            None => "New".to_string(),
            Some(p) => format!("{}{p:.1}", if p > 0.0 { "+" } else { "" }),
        };
        // A bar behind the row, as long as the provider's share of the leader's.
        let bar = el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w_frac((sh / max) as f32).radius(6.0).fill(m.series.color(t).alpha(0.12));
        list = list.child(
            row()
                .key(format!("share-{}", m.series.key))
                .w_full()
                .h(32.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .child(bar)
                .child(brands::series_logo(t, &m.series, 16.0))
                .child(label(m.series.label.clone(), type_::XS_MEDIUM, t.foreground).truncate())
                .child(label(crate::insights::int(m.answers as f64), type_::XS.features("'tnum' 1"), t.muted_foreground))
                .child(el().grow(1.0))
                .child(label(pct_1(sh), type_::XS_MEDIUM.features("'tnum' 1"), t.foreground))
                .child(row().w(40.0).child(el().grow(1.0)).child(label(change, type_::XS11.features("'tnum' 1"), t.muted_foreground))),
        );
    }
    p.child(header(t, &[("Provider", None), ("Share, change", Some(120.0))]))
        .child(list)
        .child(row().w_full().px(8.0).pt(4.0).child(label(format!("Share of collected answers, not visibility. Change in share points vs the previous {days} days."), type_::XS11, t.muted_foreground).wrap()))
}

fn pct_1(x: f64) -> String {
    format!("{:.1}%", x * 100.0)
}

/// Supported share of judged claims per provider, best first.
pub fn accuracy_by_model(t: &Theme, a: &Analytics, st: &Stats) -> El {
    let judged = a.current.supported + a.current.wrong + a.current.partial;
    let desc = format!(
        "{} of {} rated answers were correct{}",
        a.current.accuracy().map(pct).unwrap_or_else(|| "—".into()),
        crate::insights::int(judged as f64),
        if a.current.unknown > 0 { format!(" ({} could not be rated)", crate::insights::int(a.current.unknown as f64)) } else { String::new() }
    );
    let p = panel(t, "accuracy-by-model", "Correct answers by assistant", desc);
    let mut by: Vec<&ModelStat> = st.models.iter().filter(|m| m.v.total() > 0).collect();
    if by.is_empty() {
        return p.child(faint(t, "Nothing rated yet.".into()));
    }
    by.sort_by(|x, y| y.v.accuracy().unwrap_or(-1.0).total_cmp(&x.v.accuracy().unwrap_or(-1.0)).then(y.v.total().cmp(&x.v.total())));
    let mut list = col().w_full();
    for m in by {
        list = list.child(
            row()
                .key(format!("accuracy-{}", m.series.key))
                .w_full()
                .px(8.0)
                .py(6.0)
                .gap(12.0)
                .radius(6.0)
                .center_y()
                .hover(t.hover_tint)
                .child(
                    row()
                        .w(128.0)
                        .gap(8.0)
                        .center_y()
                        .child(brands::series_logo(t, &m.series, 16.0))
                        .child(label(m.series.label.clone(), type_::XS_MEDIUM, t.foreground).truncate()),
                )
                .child(col().grow(1.0).min_w(0.0).child(charts::verdict_bar_fill(t, &m.v)))
                .child(row().w(48.0).child(el().grow(1.0)).child(label(m.v.accuracy().map(pct).unwrap_or_else(|| "—".into()), type_::XS_MEDIUM.features("'tnum' 1"), t.foreground)))
                .child(row().w(56.0).child(el().grow(1.0)).child(label(m.v.wrong.to_string(), type_::XS.features("'tnum' 1"), t.muted_foreground))),
        );
    }
    p.child(header(t, &[("Assistant", Some(128.0)), ("Ratings", None), ("Correct", Some(48.0)), ("Wrong", Some(56.0))])).child(list)
}

/// Citations returned with answers per day, against their trailing average.
pub fn citations(s: &App, t: &Theme, a: &Analytics, days: u32) -> El {
    let desc = format!("{} returned with answers, {} tracked to a source", crate::insights::int(a.citations as f64), crate::insights::int(a.attributed as f64));
    let p = panel(t, "citations", "Citations", desc);
    if a.citations == 0 {
        return p.child(faint(t, format!("No citations in the last {days} days. Some providers answer without returning sources.")));
    }
    let raw = a.citation_days.get(1..).unwrap_or(&[]);
    let dates: Vec<String> = raw.iter().map(|d| d.0.clone()).collect();
    let values: Vec<Option<f64>> = raw.iter().map(|d| Some(d.1 as f64)).collect();
    let w = charts::window(days);
    let avg = charts::trailing(&values, w);
    let avg_name = format!("{w}-day average");
    let tracked = format!("{} tracked", pct(a.attributed as f64 / a.citations as f64));
    p.child(row().w_full().px(8.0).child(charts::area_trend(s, t, Trend::new("citation-trend", "Citations", &dates, &values, t.chart.primary).compare(&avg, avg_name.clone()).height(180.0).width_hint(420.0))))
        .child(
            row()
                .w_full()
                .px(8.0)
                .center_y()
                .child(charts::trend_legend(t, "Citations per day", t.chart.primary, Some(&avg_name)))
                .child(el().grow(1.0))
                .child(label(tracked, type_::XS11, t.muted_foreground)),
        )
}
