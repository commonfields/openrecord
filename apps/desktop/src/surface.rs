//! Generated views: the agent answers with a ```ui block holding a small
//! declarative surface, drawn from a fixed catalog of components.
//!
//! The shape follows Rune's generative-UI research (research/16): a flat list
//! of elements with ids, containers naming their children by id, and content
//! only. Nothing the agent writes runs, and it never chooses colours, sizes or
//! motion: those come from the app. The whole block is validated before it is
//! drawn (budgets, depth, ids, reachability, a closed set of actions), and a
//! block that fails any rule is rejected whole and shown as code, as an
//! invalid chart is. The server describes this catalog to the agent only when
//! the client sends `surfaces: ["ui"]` (`UI_INSTRUCTION` in the API).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

pub const MAX_ELEMENTS: usize = 80;
pub const MAX_DEPTH: usize = 6;
pub const MAX_BUTTONS: usize = 6;
const MAX_CHILDREN: usize = 30;
const MAX_TEXT: usize = 1200;
const MAX_SHORT: usize = 200;
const MAX_ITEMS: usize = 20;
const MAX_COLUMNS: usize = 6;
const MAX_ROWS: usize = 30;
const MAX_URL: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gap {
    Sm,
    Md,
    Lg,
}

/// A status colour, by meaning: the app maps each to its own tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Good,
    Bad,
    Warn,
    Info,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trend {
    Up,
    Down,
    Flat,
}

/// What a button may do: the closed set of actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Types a follow-up into the composer for the person to read and send.
    Ask(String),
    /// Opens an https page, on the person's press.
    Open(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub title: String,
    pub detail: Option<String>,
    pub tone: Option<Tone>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Column { gap: Gap, children: Vec<String> },
    Row { gap: Gap, children: Vec<String> },
    Card { title: Option<String>, children: Vec<String> },
    Heading(String),
    Text { text: String, muted: bool },
    Metric { label: String, value: String, hint: Option<String>, trend: Option<Trend> },
    Badge { text: String, tone: Tone },
    Progress { label: String, value: f64, hint: Option<String> },
    List(Vec<Item>),
    Table { columns: Vec<String>, rows: Vec<Vec<String>> },
    /// A chart's JSON, already valid as a ```chart block.
    Chart(String),
    Divider,
    Button { label: String, action: Action },
}

impl Node {
    pub fn children(&self) -> &[String] {
        match self {
            Node::Column { children, .. } | Node::Row { children, .. } | Node::Card { children, .. } => children,
            _ => &[],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Surface {
    pub title: Option<String>,
    pub root: String,
    pub nodes: HashMap<String, Node>,
}

/// Why a block was refused: where, and which rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub path: String,
    pub rule: &'static str,
}

fn reject<T>(path: impl Into<String>, rule: &'static str) -> Result<T, Rejection> {
    Err(Rejection { path: path.into(), rule })
}

/// A required string, trimmed, non-empty and at most `max` characters.
fn text(v: &Value, key: &str, path: &str, max: usize) -> Result<String, Rejection> {
    match opt_text(v, key, path, max)? {
        Some(s) => Ok(s),
        None => reject(format!("{path}.{key}"), "required text is missing"),
    }
}

fn opt_text(v: &Value, key: &str, path: &str, max: usize) -> Result<Option<String>, Rejection> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > max {
                return reject(format!("{path}.{key}"), "text is too long");
            }
            Ok((!s.is_empty()).then(|| s.to_string()))
        }
        // A number shown as text, such as a metric's value.
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        _ => reject(format!("{path}.{key}"), "must be text"),
    }
}

fn tone(v: Option<&Value>, path: &str) -> Result<Option<Tone>, Rejection> {
    Ok(match v.and_then(Value::as_str) {
        None => None,
        Some("good") => Some(Tone::Good),
        Some("bad") => Some(Tone::Bad),
        Some("warn") => Some(Tone::Warn),
        Some("info") => Some(Tone::Info),
        Some("neutral") => Some(Tone::Neutral),
        Some(_) => return reject(path, "tone must be good, bad, warn, info or neutral"),
    })
}

fn gap(v: &Value) -> Gap {
    match v.get("gap").and_then(Value::as_str) {
        Some("sm") => Gap::Sm,
        Some("lg") => Gap::Lg,
        _ => Gap::Md,
    }
}

fn children(v: &Value, path: &str) -> Result<Vec<String>, Rejection> {
    let Some(list) = v.get("children").and_then(Value::as_array) else { return Ok(Vec::new()) };
    if list.len() > MAX_CHILDREN {
        return reject(format!("{path}.children"), "too many children");
    }
    list.iter()
        .enumerate()
        .map(|(i, c)| c.as_str().map(str::to_string).ok_or(Rejection { path: format!("{path}.children[{i}]"), rule: "children are element ids" }))
        .collect()
}

fn action(v: Option<&Value>, path: &str) -> Result<Action, Rejection> {
    let Some(a) = v.filter(|a| a.is_object()) else { return reject(path, "a button needs an action") };
    match a.get("type").and_then(Value::as_str) {
        Some("ask") => Ok(Action::Ask(text(a, "prompt", path, MAX_URL)?)),
        Some("open") => {
            let url = text(a, "url", path, MAX_URL)?;
            // Only https pages, opened by the person's press.
            if !url.starts_with("https://") || url.chars().any(char::is_whitespace) {
                return reject(format!("{path}.url"), "only https links can be opened");
            }
            Ok(Action::Open(url))
        }
        _ => reject(format!("{path}.type"), "an action is ask or open"),
    }
}

fn node(v: &Value, path: &str) -> Result<Node, Rejection> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
    Ok(match ty {
        "column" => Node::Column { gap: gap(v), children: children(v, path)? },
        "row" => Node::Row { gap: gap(v), children: children(v, path)? },
        "card" => Node::Card { title: opt_text(v, "title", path, MAX_SHORT)?, children: children(v, path)? },
        "heading" => Node::Heading(text(v, "text", path, MAX_SHORT)?),
        "text" => Node::Text { text: text(v, "text", path, MAX_TEXT)?, muted: v.get("tone").and_then(Value::as_str) == Some("muted") },
        "metric" => Node::Metric {
            label: text(v, "label", path, MAX_SHORT)?,
            value: text(v, "value", path, 40)?,
            hint: opt_text(v, "hint", path, MAX_SHORT)?,
            trend: match v.get("trend").and_then(Value::as_str) {
                None => None,
                Some("up") => Some(Trend::Up),
                Some("down") => Some(Trend::Down),
                Some("flat") => Some(Trend::Flat),
                Some(_) => return reject(format!("{path}.trend"), "trend is up, down or flat"),
            },
        },
        "badge" => Node::Badge { text: text(v, "text", path, 60)?, tone: tone(v.get("tone"), &format!("{path}.tone"))?.unwrap_or(Tone::Neutral) },
        "progress" => {
            let value = v.get("value").and_then(Value::as_f64).filter(|x| x.is_finite() && (0.0..=1.0).contains(x));
            let Some(value) = value else { return reject(format!("{path}.value"), "progress is a number from 0 to 1") };
            Node::Progress { label: text(v, "label", path, MAX_SHORT)?, value, hint: opt_text(v, "hint", path, MAX_SHORT)? }
        }
        "list" => {
            let Some(items) = v.get("items").and_then(Value::as_array) else { return reject(format!("{path}.items"), "a list needs items") };
            if items.is_empty() || items.len() > MAX_ITEMS {
                return reject(format!("{path}.items"), "a list has 1 to 20 items");
            }
            let items = items
                .iter()
                .enumerate()
                .map(|(i, it)| {
                    let p = format!("{path}.items[{i}]");
                    Ok(Item { title: text(it, "title", &p, MAX_SHORT)?, detail: opt_text(it, "detail", &p, MAX_TEXT)?, tone: tone(it.get("tone"), &format!("{p}.tone"))? })
                })
                .collect::<Result<Vec<_>, Rejection>>()?;
            Node::List(items)
        }
        "table" => {
            let cell = |c: &Value, p: String| match c {
                Value::String(s) if s.chars().count() <= MAX_SHORT => Ok(s.trim().to_string()),
                Value::Number(n) => Ok(n.to_string()),
                Value::Null => Ok(String::new()),
                _ => reject(p, "a cell is short text or a number"),
            };
            let Some(cols) = v.get("columns").and_then(Value::as_array) else { return reject(format!("{path}.columns"), "a table needs columns") };
            if cols.is_empty() || cols.len() > MAX_COLUMNS {
                return reject(format!("{path}.columns"), "a table has 1 to 6 columns");
            }
            let columns = cols.iter().enumerate().map(|(i, c)| cell(c, format!("{path}.columns[{i}]"))).collect::<Result<Vec<_>, _>>()?;
            let rows = v.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
            if rows.len() > MAX_ROWS {
                return reject(format!("{path}.rows"), "a table has at most 30 rows");
            }
            let rows = rows
                .iter()
                .enumerate()
                .map(|(r, row)| {
                    let Some(cells) = row.as_array().filter(|c| c.len() == columns.len()) else { return reject(format!("{path}.rows[{r}]"), "each row has one cell per column") };
                    cells.iter().enumerate().map(|(i, c)| cell(c, format!("{path}.rows[{r}][{i}]"))).collect()
                })
                .collect::<Result<Vec<_>, _>>()?;
            Node::Table { columns, rows }
        }
        "chart" => {
            let raw = v.get("chart").map(Value::to_string).unwrap_or_default();
            if crate::visual::parse(&raw).is_none() {
                return reject(format!("{path}.chart"), "the chart is not valid");
            }
            Node::Chart(raw)
        }
        "divider" => Node::Divider,
        "button" => Node::Button { label: text(v, "label", path, 60)?, action: action(v.get("action"), &format!("{path}.action"))? },
        _ => return reject(format!("{path}.type"), "unknown element type"),
    })
}

/// The surface in a ```ui block, or why it was refused.
pub fn parse(raw: &str) -> Result<Surface, Rejection> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return reject("", "not JSON") };
    if !v.is_object() {
        return reject("", "not an object");
    }
    let title = opt_text(&v, "title", "", 120)?;
    let Some(root) = v.get("root").and_then(Value::as_str).map(str::to_string) else { return reject("root", "a surface names its root element") };
    let Some(list) = v.get("elements").and_then(Value::as_array) else { return reject("elements", "a surface needs elements") };
    if list.is_empty() || list.len() > MAX_ELEMENTS {
        return reject("elements", "a surface has 1 to 80 elements");
    }
    let mut nodes = HashMap::new();
    for (i, e) in list.iter().enumerate() {
        let path = format!("elements[{i}]");
        let Some(id) = e.get("id").and_then(Value::as_str) else { return reject(format!("{path}.id"), "every element has an id") };
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return reject(format!("{path}.id"), "ids are short letters, digits, - and _");
        }
        let n = node(e, &path)?;
        if nodes.insert(id.to_string(), n).is_some() {
            return reject(format!("{path}.id"), "ids are unique");
        }
    }
    if !nodes.contains_key(&root) {
        return reject("root", "the root is not an element");
    }
    // Walk from the root: every child exists, no element is reached twice
    // (no cycles, no shared subtrees), depth is bounded, and nothing is left over.
    let mut seen = HashSet::new();
    let mut stack = vec![(root.clone(), 1usize)];
    let mut buttons = 0;
    while let Some((id, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return reject(id, "the surface is nested too deep");
        }
        if !seen.insert(id.clone()) {
            return reject(id, "an element appears twice");
        }
        let Some(n) = nodes.get(&id) else { return reject(id, "a child is not an element") };
        if matches!(n, Node::Button { .. }) {
            buttons += 1;
        }
        for c in n.children().iter().rev() {
            stack.push((c.clone(), depth + 1));
        }
    }
    if buttons > MAX_BUTTONS {
        return reject("elements", "at most 6 buttons");
    }
    if seen.len() != nodes.len() {
        return reject("elements", "every element is reachable from the root");
    }
    Ok(Surface { title, root, nodes })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = r#"{"title":"Next two weeks","root":"r","elements":[
        {"id":"r","type":"column","children":["m","c","b"]},
        {"id":"m","type":"row","children":["m1","m2"]},
        {"id":"m1","type":"metric","label":"Trials","value":184,"trend":"up","hint":"30 days"},
        {"id":"m2","type":"metric","label":"Conversion","value":"3.1%"},
        {"id":"c","type":"card","title":"Steps","children":["l","p"]},
        {"id":"l","type":"list","items":[{"title":"Publish pricing page","tone":"good"},{"title":"Fix FAQ","detail":"Two wrong answers"}]},
        {"id":"p","type":"progress","label":"Setup","value":0.6},
        {"id":"b","type":"button","label":"Draft the page","action":{"type":"ask","prompt":"Draft the pricing page"}}
    ]}"#;

    #[test]
    fn reads_a_surface() {
        let s = parse(PLAN).unwrap();
        assert_eq!(s.title.as_deref(), Some("Next two weeks"));
        assert_eq!(s.nodes.len(), 8);
        assert_eq!(s.nodes["m1"], Node::Metric { label: "Trials".into(), value: "184".into(), hint: Some("30 days".into()), trend: Some(Trend::Up) });
        assert_eq!(s.nodes["b"], Node::Button { label: "Draft the page".into(), action: Action::Ask("Draft the pricing page".into()) });
    }

    #[test]
    fn refuses_unsafe_or_broken_surfaces() {
        let one = |e: &str| format!(r#"{{"root":"r","elements":[{e}]}}"#);
        assert_eq!(parse("nope").unwrap_err().rule, "not JSON");
        assert_eq!(parse(&one(r#"{"id":"r","type":"script","src":"x"}"#)).unwrap_err().rule, "unknown element type");
        assert_eq!(
            parse(&one(r#"{"id":"r","type":"button","label":"Go","action":{"type":"open","url":"javascript:alert(1)"}}"#)).unwrap_err().rule,
            "only https links can be opened"
        );
        assert_eq!(parse(&one(r#"{"id":"r","type":"button","label":"Go","action":{"type":"run","cmd":"rm"}}"#)).unwrap_err().rule, "an action is ask or open");
        assert_eq!(parse(&one(r#"{"id":"r","type":"progress","label":"x","value":3}"#)).unwrap_err().rule, "progress is a number from 0 to 1");
        assert_eq!(parse(&one(r##"{"id":"r","type":"badge","text":"x","tone":"#ff0000"}"##)).unwrap_err().rule, "tone must be good, bad, warn, info or neutral");
        // A cycle, a missing child, a leftover element, a duplicate id.
        assert_eq!(parse(r#"{"root":"a","elements":[{"id":"a","type":"column","children":["b"]},{"id":"b","type":"column","children":["a"]}]}"#).unwrap_err().rule, "an element appears twice");
        assert_eq!(parse(r#"{"root":"a","elements":[{"id":"a","type":"column","children":["z"]}]}"#).unwrap_err().rule, "a child is not an element");
        assert_eq!(parse(r#"{"root":"a","elements":[{"id":"a","type":"divider"},{"id":"b","type":"divider"}]}"#).unwrap_err().rule, "every element is reachable from the root");
        assert_eq!(parse(r#"{"root":"a","elements":[{"id":"a","type":"divider"},{"id":"a","type":"divider"}]}"#).unwrap_err().rule, "ids are unique");
    }

    #[test]
    fn enforces_budgets() {
        // Seven levels deep.
        let mut els = Vec::new();
        for i in 0..7 {
            els.push(format!(r#"{{"id":"n{i}","type":"column","children":["n{}"]}}"#, i + 1));
        }
        els.push(r#"{"id":"n7","type":"divider"}"#.to_string());
        let deep = format!(r#"{{"root":"n0","elements":[{}]}}"#, els.join(","));
        assert_eq!(parse(&deep).unwrap_err().rule, "the surface is nested too deep");
        // Seven buttons.
        let ids: Vec<String> = (0..7).map(|i| format!("\"b{i}\"")).collect();
        let mut els = vec![format!(r#"{{"id":"r","type":"row","children":[{}]}}"#, ids.join(","))];
        for i in 0..7 {
            els.push(format!(r#"{{"id":"b{i}","type":"button","label":"Ask","action":{{"type":"ask","prompt":"x"}}}}"#));
        }
        let many = format!(r#"{{"root":"r","elements":[{}]}}"#, els.join(","));
        assert_eq!(parse(&many).unwrap_err().rule, "at most 6 buttons");
    }

    #[test]
    fn charts_inside_must_be_valid_charts() {
        let ok = r#"{"root":"c","elements":[{"id":"c","type":"chart","chart":{"type":"bar","title":"T","labels":["a"],"series":[{"name":"x","values":[1]}]}}]}"#;
        assert!(matches!(parse(ok).unwrap().nodes["c"], Node::Chart(_)));
        let bad = r#"{"root":"c","elements":[{"id":"c","type":"chart","chart":{"type":"pie"}}]}"#;
        assert_eq!(parse(bad).unwrap_err().rule, "the chart is not valid");
    }
}
