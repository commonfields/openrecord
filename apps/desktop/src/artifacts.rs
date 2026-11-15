//! Authenticated artifacts. The native renderer never receives a session or preview token.
use crate::api::{ApiResult, Client, enc};
use crate::state::{App, Load};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub title: String,
    pub format: String,
    pub content: String,
    #[serde(skip)]
    pub preview_html: String,
    pub version: u32,
    pub shown_version: u32,
    pub versions: Vec<Version>,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Version {
    pub version: u32,
    pub title: String,
}

pub struct Pane {
    pub business: String,
    pub id: String,
    pub requested: Option<u32>,
    pub loaded: Load<Artifact>,
    pub source: bool,
}
impl Client {
    pub fn artifact(&self, business: &str, id: &str, version: Option<u32>) -> ApiResult<Artifact> {
        #[derive(Deserialize)]
        struct Response {
            artifact: Artifact,
        }
        let query = version.map(|v| format!("?version={v}")).unwrap_or_default();
        let base = format!("/api/businesses/{}/artifacts/{}", enc(business), enc(id));
        let mut artifact = self.get::<Response>(&format!("{base}{query}"))?.artifact;
        // Pin the preview to the version just read, even if another editor saves meanwhile.
        artifact.preview_html = self.get_html(&format!("{base}/preview?version={}", artifact.shown_version))?;
        Ok(artifact)
    }
}
impl App {
    /// After a reply lands, re-reads each open artifact the reply saved a newer
    /// version of, so a change asked for in the chat shows in its tab at once.
    pub fn refresh_open_artifacts(&mut self, c: &crate::api::Conversation) {
        let Some(last) = c.messages.iter().rev().find(|m| m.role == "agent") else { return };
        for r in &last.artifacts {
            if let Some(p) = self.artifacts.iter_mut().find(|p| p.id == r.id && p.requested.is_none()) {
                if p.loaded.ready().is_some_and(|a| (a.version as i64) < r.version) {
                    p.loaded = Load::Loading;
                    self.net.artifact(p.business.clone(), p.id.clone(), None);
                }
            }
        }
    }
    pub fn artifact_version(&mut self, version: Option<u32>) {
        let Some(p) = self.front_artifact_mut() else { return };
        p.requested = version;
        p.loaded = Load::Loading;
        let (b, id) = (p.business.clone(), p.id.clone());
        self.net.artifact(b, id, version);
    }
    pub fn artifact_visible(&self) -> bool {
        self.side_shown() && matches!(self.side_tab(), crate::side::SideTab::Artifact(_))
    }
    /// A helper session beside the conversation, when no artifact holds that place.
    pub fn helper_visible(&self) -> bool {
        self.side_shown() && matches!(self.side_tab(), crate::side::SideTab::Helper(_))
    }
    /// Whether the right panel is open beside the page.
    pub fn side_visible(&self) -> bool {
        self.side_shown()
    }
    pub fn preview_visible(&self) -> bool {
        self.artifact_visible()
            && self
                .front_artifact()
                .is_some_and(|p| !p.source && p.loaded.ready().is_some())
            && self.native_view_clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the local demo API and a saved artifact"]
    fn live_api_preview_matches_the_browser_document() {
        let client = Client::new("http://localhost:3001");
        client.signin("demo@northstar.test", "password123").expect("demo signin");
        for business in client.businesses().expect("businesses") {
            let list: serde_json::Value = client.get(&format!("/api/businesses/{}/artifacts", enc(&business.id))).expect("artifact list");
            if let Some(id) = list["artifacts"].as_array().and_then(|a| a.first()).and_then(|a| a["id"].as_str()) {
                let artifact = client.artifact(&business.id, id, None).expect("native artifact read");
                let browser = client.get_html(&format!("/api/businesses/{}/artifacts/{}/preview?version={}", enc(&business.id), enc(id), artifact.shown_version)).expect("browser document");
                assert_eq!(artifact.preview_html, browser);
                assert!(artifact.preview_html.contains("<html"));
                if artifact.format == "MARKDOWN" {
                    assert!(artifact.preview_html.contains("<style>"));
                    assert!(artifact.preview_html.contains("<main>"));
                }
                return;
            }
        }
        panic!("no saved artifact available for preview verification");
    }
}
