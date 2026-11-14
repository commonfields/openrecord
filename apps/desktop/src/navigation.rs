//! Product links stay native, including links in generated views and citations.
use crate::state::{App, Page};

fn internal_path<'a>(url: &'a str, api: &str) -> Option<&'a str> {
    [api.to_string(), crate::ui::web_url(api)]
        .iter()
        .find_map(|origin| {
            let rest = url.strip_prefix(origin.trim_end_matches('/'))?;
            (rest.starts_with('/')
                || rest.is_empty()
                || rest.starts_with('?')
                || rest.starts_with('#'))
            .then_some(rest)
        })
}
impl App {
    pub fn open_link(&mut self, url: &str, tx: &mut rune::Tx) {
        let api = crate::state::api_base();
        let Some(path) = internal_path(url, &api) else {
            let _ = tx.open_url(url);
            return;
        };
        let path = path.split(['?', '#']).next().unwrap_or("");
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        match parts.as_slice() {
            [""] => self.go_home(),
            ["start"] => self.open_add_business(None),
            ["businesses"] => self.show_page(Page::Businesses),
            ["clients"] => self.show_page(Page::Clients),
            ["businesses", business, page, ..] => {
                if !self.businesses.iter().any(|b| b.id == *business) {
                    self.notice = Some("That business is not available in this account.".into());
                    return;
                }
                if self.active.as_deref() != Some(*business) {
                    self.select_business(business);
                }
                match *page {
                    "channels" => self.show_page(Page::Channels),
                    "inbox" => self.show_page(Page::Inbox),
                    "campaigns" | "work" => self.show_page(Page::Campaigns),
                    "overview" | "results" => self.show_page(Page::Overview),
                    "issues" | "answers" => self.show_page(Page::AiAnswers),
                    "agent" => self.go_home(),
                    _ => self.ask_agent(&format!(
                        "Help me review {page} for this business using the available tools."
                    )),
                }
            }
            ["api", "businesses", business, "artifacts", artifact, ..]
                if self.active.as_deref() == Some(*business) =>
            {
                self.open_artifact(artifact)
            }
            _ => self.notice = Some(
                "This product link has no desktop view yet. Continue with the agent in the app."
                    .into(),
            ),
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn app_links_are_native_but_similar_hostnames_are_external() {
        let api = "https://app.example.test";
        assert_eq!(
            super::internal_path("https://app.example.test/businesses/b/channels", api),
            Some("/businesses/b/channels")
        );
        assert_eq!(
            super::internal_path(
                "https://app.example.test.evil.test/businesses/b/channels",
                api
            ),
            None
        );
        assert_eq!(
            super::internal_path("https://app.example.test@evil.test/path", api),
            None
        );
        assert_eq!(
            super::internal_path(
                "http://localhost:3000/businesses/b/channels",
                "http://localhost:3001"
            ),
            Some("/businesses/b/channels")
        );
    }
}
