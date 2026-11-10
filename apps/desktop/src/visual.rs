//! Visual replies: the agent answers with a chart or stat tiles by writing a
//! fenced ```chart block holding a small JSON spec (`chat-visual.tsx`). The
//! same limits and the same refusals as the web: a block that is not a valid
//! spec is shown as code, and nothing the agent writes runs.

use serde_json::Value;

const MAX_SERIES: usize = 8;
const MAX_POINTS: usize = 60;
const MAX_STATS: usize = 6;
pub const DONUT_SLICES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bar,
    Line,
    Donut,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub label: String,
    pub value: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Spec {
    Plot { kind: Kind, title: String, unit: Option<String>, labels: Vec<String>, series: Vec<Series>, note: Option<String> },
    Stats { title: String, stats: Vec<Stat>, note: Option<String> },
}

/// A reply split into its Markdown and its chart blocks, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    /// The raw JSON of a ```chart block.
    Chart(String),
}

fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect())
}

/// The spec in a ```chart block, or `None` when it is not a valid one.
pub fn parse(raw: &str) -> Option<Spec> {
    let o: Value = serde_json::from_str(raw).ok()?;
    let o = o.as_object()?;
    let title = text(o.get("title"), 120).unwrap_or_default();
    let note = text(o.get("note"), 300);
    let ty = o.get("type").and_then(Value::as_str)?;
    if ty == "stats" {
        let stats: Vec<Stat> = o
            .get("stats")?
            .as_array()?
            .iter()
            .take(MAX_STATS)
            .filter_map(|x| {
                let label = text(x.get("label"), 60)?;
                let value = match x.get("value") {
                    Some(Value::Number(n)) => Some(n.to_string()),
                    v => text(v, 30),
                }?;
                Some(Stat { label, value, hint: text(x.get("hint"), 80) })
            })
            .collect();
        return (!stats.is_empty()).then_some(Spec::Stats { title, stats, note });
    }
    let kind = match ty {
        "bar" => Kind::Bar,
        "line" => Kind::Line,
        "donut" => Kind::Donut,
        _ => return None,
    };
    let labels: Vec<String> = o.get("labels")?.as_array()?.iter().take(MAX_POINTS).map(|l| text(Some(l), 40).unwrap_or_default()).collect();
    if labels.is_empty() || labels.iter().any(String::is_empty) {
        return None;
    }
    let cap = if kind == Kind::Donut { 1 } else { MAX_SERIES };
    let series: Vec<Series> = o
        .get("series")?
        .as_array()?
        .iter()
        .take(cap)
        .filter_map(|x| {
            let name = text(x.get("name"), 60).unwrap_or_else(|| "Value".into());
            let raw = x.get("values")?.as_array()?;
            // Every label needs a number or an explicit null, or the series is dropped.
            let values = (0..labels.len())
                .map(|i| match raw.get(i) {
                    Some(Value::Null) => Some(None),
                    Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).map(Some),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Series { name, values })
        })
        .collect();
    if series.is_empty() || series.iter().all(|s| s.values.iter().all(Option::is_none)) {
        return None;
    }
    if kind == Kind::Donut && series[0].values.iter().flatten().any(|v| *v < 0.0) {
        return None;
    }
    Some(Spec::Plot { kind, title, unit: text(o.get("unit"), 12), labels, series, note })
}

/// Splits Markdown at its ```chart fences. An unclosed fence stays text.
pub fn split(md: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut lines = md.split_inclusive('\n').peekable();
    while let Some(line) = lines.next() {
        if line.trim_end() == "```chart" {
            let mut body = String::new();
            let mut closed = false;
            let mut taken = Vec::new();
            while let Some(l) = lines.peek() {
                let l = *l;
                lines.next();
                taken.push(l);
                if l.trim_end() == "```" {
                    closed = true;
                    break;
                }
                body.push_str(l);
            }
            if closed {
                if !buf.trim().is_empty() {
                    parts.push(Part::Text(std::mem::take(&mut buf)));
                }
                buf.clear();
                parts.push(Part::Chart(body.trim().to_string()));
            } else {
                buf.push_str(line);
                taken.iter().for_each(|l| buf.push_str(l));
            }
        } else {
            buf.push_str(line);
        }
    }
    if !buf.trim().is_empty() {
        parts.push(Part::Text(buf));
    }
    parts
}

/// A value with its unit, as the web's `fmt`: "%" sticks, other units follow a space.
pub fn format(v: Option<f64>, unit: Option<&str>) -> String {
    let Some(v) = v else { return "—".into() };
    let rounded = (v * 100.0).round() / 100.0;
    let mut s = if rounded.fract() == 0.0 { group(rounded as i64) } else { format!("{}.{}", group(rounded.trunc() as i64), format!("{:.2}", rounded.abs().fract()).trim_start_matches("0.").trim_end_matches('0')) };
    if rounded < 0.0 && rounded.trunc() == 0.0 {
        s.insert(0, '-');
    }
    match unit {
        Some("%") => format!("{s}%"),
        Some(u) => format!("{s} {u}"),
        None => s,
    }
}

fn group(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// A donut's slices, largest first; past six the rest fold into "Other".
pub fn slices(labels: &[String], values: &[Option<f64>]) -> Vec<(String, f64)> {
    let mut order: Vec<(String, f64)> = labels.iter().cloned().zip(values.iter().map(|v| v.unwrap_or(0.0))).collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    if order.len() > DONUT_SLICES {
        let rest: f64 = order[DONUT_SLICES - 1..].iter().map(|x| x.1).sum();
        order.truncate(DONUT_SLICES - 1);
        order.push(("Other".into(), rest));
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_reply_at_chart_fences() {
        let md = "Here is the trend.\n\n```chart\n{\"type\":\"bar\"}\n```\nAnd more.\n";
        assert_eq!(split(md), vec![Part::Text("Here is the trend.\n\n".into()), Part::Chart("{\"type\":\"bar\"}".into()), Part::Text("And more.\n".into())]);
    }

    #[test]
    fn unclosed_fence_stays_text() {
        let md = "a\n```chart\n{";
        assert_eq!(split(md), vec![Part::Text(md.into())]);
    }

    #[test]
    fn parses_a_bar_chart() {
        let s = parse(r#"{"type":"bar","title":"Clicks","unit":"%","labels":["Mon","Tue"],"series":[{"name":"A","values":[1,null]}]}"#).unwrap();
        match s {
            Spec::Plot { kind, labels, series, unit, .. } => {
                assert_eq!(kind, Kind::Bar);
                assert_eq!(labels.len(), 2);
                assert_eq!(series[0].values, vec![Some(1.0), None]);
                assert_eq!(unit.as_deref(), Some("%"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn refuses_what_the_web_refuses() {
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"type":"pie","labels":["a"],"series":[{"values":[1]}]}"#).is_none());
        assert!(parse(r#"{"type":"bar","labels":["a",""],"series":[{"values":[1,2]}]}"#).is_none());
        assert!(parse(r#"{"type":"bar","labels":["a"],"series":[{"values":[null]}]}"#).is_none());
        assert!(parse(r#"{"type":"bar","labels":["a","b"],"series":[{"values":[1]}]}"#).is_none(), "a missing value drops the series");
        assert!(parse(r#"{"type":"donut","labels":["a"],"series":[{"values":[-1]}]}"#).is_none());
        assert!(parse(r#"{"type":"stats","stats":[{"label":"x"}]}"#).is_none());
    }

    #[test]
    fn stats_take_numbers_or_text() {
        let s = parse(r#"{"type":"stats","title":"T","stats":[{"label":"Clicks","value":120},{"label":"Rate","value":"4%","hint":"up"}]}"#).unwrap();
        assert_eq!(s, Spec::Stats { title: "T".into(), stats: vec![Stat { label: "Clicks".into(), value: "120".into(), hint: None }, Stat { label: "Rate".into(), value: "4%".into(), hint: Some("up".into()) }], note: None });
    }

    #[test]
    fn formats_like_the_web() {
        assert_eq!(format(Some(1234.5), None), "1,234.5");
        assert_eq!(format(Some(12.0), Some("%")), "12%");
        assert_eq!(format(Some(3.456), Some("USD")), "3.46 USD");
        assert_eq!(format(None, None), "—");
    }

    #[test]
    fn donut_folds_small_slices() {
        let labels: Vec<String> = (0..8).map(|i| format!("s{i}")).collect();
        let values: Vec<Option<f64>> = (0..8).map(|i| Some(i as f64)).collect();
        let s = slices(&labels, &values);
        assert_eq!(s.len(), DONUT_SLICES);
        assert_eq!(s[0], ("s7".into(), 7.0));
        assert_eq!(s.last().unwrap(), &("Other".to_string(), 2.0 + 1.0 + 0.0));
    }
}
