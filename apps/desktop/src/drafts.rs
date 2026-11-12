//! Unsent composer text per chat, kept in the app's support folder so it
//! survives switching chats and quitting, as the web keeps drafts in the browser.

use std::collections::BTreeMap;

/// Drafts kept at most, the newest first to stay.
const KEEP: usize = 200;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Drafts {
    map: BTreeMap<String, (u64, String)>,
    clock: u64,
}

impl Drafts {
    pub fn load() -> Drafts {
        if rune::tooling::headless_run().is_some() {
            return Drafts::default();
        }
        let map: BTreeMap<String, (u64, String)> = path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let clock = map.values().map(|v| v.0).max().unwrap_or(0);
        Drafts { map, clock }
    }

    pub fn get(&self, key: &str) -> &str {
        self.map.get(key).map(|v| v.1.as_str()).unwrap_or("")
    }

    /// Saves (or, when empty, forgets) a chat's draft, and writes the file.
    pub fn set(&mut self, key: &str, text: &str) {
        if text.trim().is_empty() {
            if self.map.remove(key).is_none() {
                return;
            }
        } else {
            self.clock += 1;
            self.map.insert(key.to_string(), (self.clock, text.to_string()));
            while self.map.len() > KEEP {
                let oldest = self.map.iter().min_by_key(|(_, v)| v.0).map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    self.map.remove(&k);
                }
            }
        }
        self.save();
    }

    fn save(&self) {
        if rune::tooling::headless_run().is_some() {
            return;
        }
        if let (Some(p), Ok(json)) = (path(), serde_json::to_string(&self.map)) {
            let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
            let _ = std::fs::write(p, json);
        }
    }
}

fn path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Application Support/OpenRecord/drafts.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_and_forgets_drafts() {
        let mut d = Drafts::default();
        d.map.insert("a".into(), (1, "hello".into()));
        assert_eq!(d.get("a"), "hello");
        d.map.remove("a");
        assert_eq!(d.get("a"), "");
    }
}
