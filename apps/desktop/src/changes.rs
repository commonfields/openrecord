//! The Changes tab: what the agent changed in the chat's artifacts, the latest
//! version of one set against the version before it, line by line.

use serde::Deserialize;

use crate::api::{ApiResult, Client, enc};
use crate::state::{App, Load};

/// One version's words, as compared.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub title: String,
    #[serde(default)]
    pub format: String,
    pub content: String,
    pub version: u32,
    #[serde(default)]
    pub shown_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Same(String),
    Added(String),
    Removed(String),
}

/// The change open in the tab: the artifact, and its two versions compared.
pub struct Diff {
    pub id: String,
    pub lines: Load<(u32, u32, Vec<Line>)>,
}

impl Client {
    /// The artifact's latest version and the one before it, compared. A first
    /// version is compared with nothing, so all of it reads as added.
    pub fn artifact_diff(&self, business: &str, id: &str) -> ApiResult<(u32, u32, Vec<Line>)> {
        #[derive(Deserialize)]
        struct Response {
            artifact: Text,
        }
        let base = format!("/api/businesses/{}/artifacts/{}", enc(business), enc(id));
        let new = self.get::<Response>(&base)?.artifact;
        let to = new.shown_version.max(new.version);
        let (from, old) = if to > 1 { (to - 1, self.get::<Response>(&format!("{base}?version={}", to - 1))?.artifact.content) } else { (0, String::new()) };
        Ok((from, to, diff(&words(&old, &new.format), &words(&new.content, &new.format))))
    }
}

/// What a person reads in a version: a page's text without its markup, one
/// line per block, or a document's own lines.
pub fn words(content: &str, format: &str) -> Vec<String> {
    let html = format.eq_ignore_ascii_case("html") || content.trim_start().starts_with('<');
    let text = if html { strip_tags(content) } else { content.to_string() };
    text.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|l| !l.is_empty()).collect()
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        let lower = after.get(..8).unwrap_or(after).to_ascii_lowercase();
        // Scripts and styles are not words on the page.
        let skip = if lower.starts_with("<script") { Some("</script>") } else if lower.starts_with("<style") { Some("</style>") } else { None };
        let end = match skip {
            Some(close) => after.to_ascii_lowercase().find(close).map(|j| j + close.len()),
            None => after.find('>').map(|j| j + 1),
        };
        let Some(end) = end else { break };
        out.push('\n');
        rest = &after[end..];
        if skip.is_none() && end == after.len() {
            break;
        }
    }
    if !rest.starts_with('<') {
        out.push_str(rest);
    }
    out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

/// The lines of `old` and `new` in order, each the same, added or removed
/// (a longest common subsequence). Very long texts compare their ends only
/// past what they share at the start and the end.
pub fn diff(old: &[String], new: &[String]) -> Vec<Line> {
    let head = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let tail = old[head..].iter().rev().zip(new[head..].iter().rev()).take_while(|(a, b)| a == b).count();
    let (a, b) = (&old[head..old.len() - tail], &new[head..new.len() - tail]);
    let mut out: Vec<Line> = old[..head].iter().cloned().map(Line::Same).collect();
    const MAX: usize = 1500;
    if a.len() > MAX || b.len() > MAX {
        out.extend(a.iter().cloned().map(Line::Removed));
        out.extend(b.iter().cloned().map(Line::Added));
    } else {
        let (n, m) = (a.len(), b.len());
        let mut lcs = vec![0u16; (n + 1) * (m + 1)];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * (m + 1) + j] = if a[i] == b[j] { lcs[(i + 1) * (m + 1) + j + 1] + 1 } else { lcs[(i + 1) * (m + 1) + j].max(lcs[i * (m + 1) + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && a[i] == b[j] {
                out.push(Line::Same(a[i].clone()));
                i += 1;
                j += 1;
            } else if j < m && (i == n || lcs[i * (m + 1) + j + 1] >= lcs[(i + 1) * (m + 1) + j]) {
                out.push(Line::Added(b[j].clone()));
                j += 1;
            } else {
                out.push(Line::Removed(a[i].clone()));
                i += 1;
            }
        }
    }
    out.extend(old[old.len() - tail..].iter().cloned().map(Line::Same));
    out
}

impl App {
    /// The chat's artifacts, newest version of each, in the order they first appeared.
    pub fn chat_artifacts(&self) -> Vec<crate::chat::ArtifactRef> {
        let mut out: Vec<crate::chat::ArtifactRef> = Vec::new();
        let Some(c) = self.conversation.ready() else { return out };
        if Some(&c.id) != self.chat_id.as_ref() {
            return out;
        }
        for m in &c.messages {
            for r in &m.artifacts {
                match out.iter_mut().find(|o| o.id == r.id) {
                    Some(o) if o.version < r.version => *o = r.clone(),
                    Some(_) => {}
                    None => out.push(r.clone()),
                }
            }
        }
        out
    }

    /// Opens an artifact from the Files tab: a landing page in the browser, anything else as a tab.
    pub fn open_file(&mut self, r: &crate::chat::ArtifactRef) {
        if crate::artifacts::is_page(&r.kind) {
            self.open_page_artifact(&r.id);
        } else {
            self.open_artifact(&r.id);
        }
    }

    /// Compares an artifact's latest version with the one before, in the Changes tab.
    pub fn show_diff(&mut self, id: &str) {
        let Some(business) = self.active.clone() else { return };
        self.side.diff = Some(Diff { id: id.into(), lines: Load::Loading });
        self.net.artifact_diff(business, id.into());
    }

    pub fn diff_loaded(&mut self, id: &str, result: Result<(u32, u32, Vec<Line>), String>) {
        if let Some(d) = self.side.diff.as_mut().filter(|d| d.id == id) {
            d.lines = match result {
                Ok(x) => Load::Ready(x),
                Err(e) => Load::Failed(if e.is_empty() { "Couldn't compare the versions. Try again.".into() } else { e }),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn lines_read_as_kept_added_or_removed_in_order() {
        let d = diff(&v(&["Title", "Old line", "Footer"]), &v(&["Title", "New line", "Footer", "More"]));
        assert_eq!(
            d,
            vec![Line::Same("Title".into()), Line::Added("New line".into()), Line::Removed("Old line".into()), Line::Same("Footer".into()), Line::Added("More".into())]
        );
    }

    #[test]
    fn a_page_compares_its_words_not_its_markup() {
        let w = words("<html><style>p{color:red}</style><h1>Show up</h1><p>in AI &amp; search</p><script>x()</script></html>", "html");
        assert_eq!(w, v(&["Show up", "in AI & search"]));
    }
}
