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
    pub fn artifact_version(&mut self, version: Option<u32>) {
        let Some(p) = &mut self.artifact else { return };
        p.requested = version;
        p.loaded = Load::Loading;
        self.net.artifact(p.business.clone(), p.id.clone(), version);
    }
    pub fn artifact_visible(&self) -> bool {
        self.screen == crate::state::Screen::Workspace
            && self.view == crate::state::View::Agent
            && self.artifact.is_some()
    }
    /// A helper session beside the conversation, when no artifact holds that place.
    pub fn helper_visible(&self) -> bool {
        self.screen == crate::state::Screen::Workspace
            && self.view == crate::state::View::Agent
            && (self.active.is_some() || self.general)
            && self.helper.is_some()
            && !self.artifact_visible()
    }
    /// Whether a card (an artifact or a helper) is open beside the panel.
    pub fn side_visible(&self) -> bool {
        self.artifact_visible() || self.helper_visible()
    }
    pub fn preview_visible(&self) -> bool {
        self.artifact_visible()
            && self
                .artifact
                .as_ref()
                .is_some_and(|p| !p.source && p.loaded.ready().is_some())
            && self.settings.is_none()
            && self.menu.is_none()
            && self.find.is_none()
            && self.new_chat.is_none()
            && !self.chat_actions
            && !self.notices_open
            && self.share.is_none()
            && self.save_playbook.is_none()
            && self.add_business.is_none()
            && self.menu_entries().is_empty()
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
