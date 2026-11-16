//! Native campaign brief editing against the existing revision-checked API.
use crate::api::{ApiError, Campaign};
use crate::state::App;
use rune::TextEdit;
use serde_json::{Value, json};

pub const SECTIONS: [&str; 6] = [
    "Goal & audience",
    "Offer & message",
    "Distribution & tracking",
    "Owners & timeline",
    "Deliverables",
    "Results & decision",
];
pub(crate) struct Field {
    pub(crate) key: &'static str,
    pub(crate) name: &'static str,
    pub(crate) hint: &'static str,
    pub(crate) section: usize,
    pub(crate) max: usize,
}
pub(crate) const FIELDS: &[Field] = &[
    Field {
        key: "title",
        name: "Campaign name",
        hint: "Mid-market process audit",
        section: 0,
        max: 200,
    },
    Field {
        key: "goal",
        name: "Problem and desired outcome",
        hint: "What needs to change, and what should people do?",
        section: 0,
        max: 2000,
    },
    Field {
        key: "audience",
        name: "Audience and fit",
        hint: "Operations leaders at 50–500 person companies; why this group?",
        section: 0,
        max: 2000,
    },
    Field {
        key: "metric",
        name: "Success metric and data source",
        hint: "Qualified demos, measured in the CRM",
        section: 0,
        max: 500,
    },
    Field {
        key: "baseline",
        name: "Baseline",
        hint: "Current performance, or why it is unavailable",
        section: 0,
        max: 500,
    },
    Field {
        key: "target",
        name: "Target",
        hint: "40 qualified demos in four weeks",
        section: 0,
        max: 500,
    },
    Field {
        key: "offer",
        name: "Offer and call to action",
        hint: "Free 20-minute process audit; book a slot",
        section: 1,
        max: 2000,
    },
    Field {
        key: "message",
        name: "Message, proof points and why now",
        hint: "What should resonate? Which evidence supports the promise?",
        section: 1,
        max: 2000,
    },
    Field {
        key: "hypothesis",
        name: "Hypothesis",
        hint: "We believe this offer will move this audience because…",
        section: 1,
        max: 2000,
    },
    Field {
        key: "primaryChannel",
        name: "Channels",
        hint: "LinkedIn ads + existing email list + partner post",
        section: 2,
        max: 200,
    },
    Field {
        key: "rationale",
        name: "Why these channels",
        hint: "Where this audience already pays attention",
        section: 2,
        max: 1000,
    },
    Field {
        key: "destination",
        name: "Destination",
        hint: "Landing page or booking destination",
        section: 2,
        max: 1000,
    },
    Field {
        key: "cadence",
        name: "Distribution and monitoring cadence",
        hint: "Send Tuesday; inspect early signals daily; review after two weeks",
        section: 2,
        max: 500,
    },
    Field {
        key: "budget",
        name: "Budget and allocation",
        hint: "Total cap, channel split and stop conditions; planning only",
        section: 2,
        max: 500,
    },
    Field {
        key: "conversionEvent",
        name: "Conversion event",
        hint: "Qualified demo booking",
        section: 2,
        max: 500,
    },
    Field {
        key: "trackingPlan",
        name: "Tracking and pre-launch checks",
        hint: "UTMs, form source, CRM stages; test attribution before launch",
        section: 2,
        max: 2000,
    },
    Field {
        key: "owner",
        name: "Campaign owner",
        hint: "Who is accountable for the outcome?",
        section: 3,
        max: 200,
    },
    Field {
        key: "launchDate",
        name: "Launch date",
        hint: "YYYY-MM-DD",
        section: 3,
        max: 10,
    },
    Field {
        key: "reviewDate",
        name: "Review / decision date",
        hint: "YYYY-MM-DD; defines the campaign's decision window",
        section: 3,
        max: 10,
    },
    Field {
        key: "result",
        name: "Observed results and evidence",
        hint: "What happened? Include the period, source and measurement gaps",
        section: 5,
        max: 4000,
    },
    Field {
        key: "learning",
        name: "Learning",
        hint: "What did we learn about the audience, offer, creative or channel?",
        section: 5,
        max: 4000,
    },
    Field {
        key: "nextMove",
        name: "Next move and decision rule",
        hint: "At two weeks stop weak ads; at four weeks scale or rewrite the offer",
        section: 5,
        max: 2000,
    },
];

pub struct TaskEdit {
    id: String,
    pub title: TextEdit,
    pub owner: TextEdit,
    pub due: TextEdit,
    pub note: TextEdit,
    pub channel: String,
    pub status: String,
    original: Value,
}
impl TaskEdit {
    pub(crate) fn new(v: Value) -> Self {
        let text = |k: &str| TextEdit::new(v[k].as_str().unwrap_or(""));
        Self {
            id: v["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(crate::api::uuid),
            title: text("title"),
            owner: text("owner"),
            due: text("due"),
            note: text("note"),
            channel: v["channel"].as_str().unwrap_or("WEBSITE").into(),
            status: v["status"].as_str().unwrap_or("TODO").into(),
            original: v,
        }
    }
    fn value(&self) -> Value {
        let mut v = if self.original.is_object() {
            self.original.clone()
        } else {
            json!({})
        };
        for (k, text) in [
            ("id", self.id.as_str()),
            ("title", &self.title.text),
            ("owner", &self.owner.text),
            ("due", &self.due.text),
            ("note", &self.note.text),
            ("channel", &self.channel),
            ("status", &self.status),
        ] {
            v[k] = json!(text);
        }
        v
    }
}

pub struct Editor {
    pub business: String,
    pub id: String,
    pub revision: i64,
    original: Value,
    pub fields: Vec<TextEdit>,
    pub tasks: Vec<TaskEdit>,
    pub status: String,
    pub decision: String,
    pub motion: String,
    pub funnel: String,
    pub busy: bool,
    pub error: Option<String>,
    initial: Value,
}
impl Editor {
    pub fn new(business: String, saved: Option<&Campaign>) -> Self {
        let original = saved
            .map(|c| c.brief.clone())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let text = |key: &str| original[key].as_str().unwrap_or("").to_string();
        let mut e = Self {
            business,
            id: saved.map(|c| c.id.clone()).unwrap_or_else(crate::api::uuid),
            revision: saved.map(|c| c.revision).unwrap_or(0),
            fields: FIELDS
                .iter()
                .map(|f| {
                    TextEdit::new(if f.section == 2 {
                        original["distribution"][f.key].as_str().unwrap_or("")
                    } else {
                        original[f.key].as_str().unwrap_or("")
                    })
                })
                .collect(),
            tasks: original["tasks"]
                .as_array()
                .map(|a| a.iter().cloned().map(TaskEdit::new).collect())
                .unwrap_or_default(),
            status: if text("status").is_empty() {
                "DRAFT".into()
            } else {
                text("status")
            },
            decision: if text("decision").is_empty() {
                "UNDECIDED".into()
            } else {
                text("decision")
            },
            motion: original["distribution"]["motion"]
                .as_str()
                .unwrap_or("UNSPECIFIED")
                .into(),
            funnel: original["distribution"]["funnelStage"]
                .as_str()
                .unwrap_or("UNSPECIFIED")
                .into(),
            original,
            busy: false,
            error: None,
            initial: Value::Null,
        };
        e.initial = e.value();
        e
    }
    pub fn value(&self) -> Value {
        let mut v = self.original.clone();
        let has_distribution = self.original.get("distribution").is_some()
            || self.motion != "UNSPECIFIED"
            || self.funnel != "UNSPECIFIED"
            || FIELDS
                .iter()
                .enumerate()
                .any(|(i, f)| f.section == 2 && !self.fields[i].text.is_empty());
        if has_distribution && !v["distribution"].is_object() {
            v["distribution"] = json!({});
        }
        for (i, f) in FIELDS.iter().enumerate() {
            if f.section == 2 {
                if has_distribution {
                    v["distribution"][f.key] = json!(self.fields[i].text);
                }
            } else {
                v[f.key] = json!(self.fields[i].text);
            }
        }
        if has_distribution {
            v["distribution"]["motion"] = json!(self.motion);
            v["distribution"]["funnelStage"] = json!(self.funnel);
        }
        v["status"] = json!(self.status);
        v["decision"] = json!(self.decision);
        v["tasks"] = Value::Array(self.tasks.iter().map(TaskEdit::value).collect());
        v
    }
    pub fn dirty(&self) -> bool {
        self.value() != self.initial
    }
    pub fn validate(&self) -> Result<Value, String> {
        let v = self.value();
        if v["title"].as_str().unwrap_or("").trim().is_empty() {
            return Err("Give this campaign a name in Goal & audience.".into());
        }
        for (i, f) in FIELDS.iter().enumerate() {
            // The API schema counts UTF-16 code units.
            if self.fields[i].text.encode_utf16().count() > f.max {
                return Err(format!("{} must be at most {} characters.", f.name, f.max));
            }
        }
        for t in &self.tasks {
            if t.title.text.trim().is_empty() {
                return Err(
                    "Give each deliverable a title, or remove the empty deliverable.".into(),
                );
            }
            if t.title.text.encode_utf16().count() > 300
                || t.owner.text.encode_utf16().count() > 200
                || t.note.text.encode_utf16().count() > 2000
            {
                return Err("A deliverable exceeds its title (300), owner (200) or notes (2000) character limit.".into());
            }
        }
        for d in [
            v["launchDate"].as_str().unwrap_or(""),
            v["reviewDate"].as_str().unwrap_or(""),
        ]
        .into_iter()
        .chain(self.tasks.iter().map(|t| t.due.text.as_str()))
        {
            if !valid_date(d) {
                return Err("Use a real calendar date in YYYY-MM-DD format for launch, review and deliverable dates.".into());
            }
        }
        if !v["launchDate"].as_str().unwrap_or("").is_empty()
            && !v["reviewDate"].as_str().unwrap_or("").is_empty()
            && v["reviewDate"].as_str() < v["launchDate"].as_str()
        {
            return Err("The review date must be on or after launch.".into());
        }
        Ok(v)
    }
}
fn valid_date(d: &str) -> bool {
    if d.is_empty() {
        return true;
    }
    if d.len() != 10
        || d.as_bytes()[4] != b'-'
        || d.as_bytes()[7] != b'-'
        || !d
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let y = d[..4].parse::<u32>().unwrap_or(0);
    let m = d[5..7].parse::<u32>().unwrap_or(0);
    let day = d[8..].parse::<u32>().unwrap_or(0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    y > 0 && day > 0 && day <= days
}
pub fn save_error(e: &ApiError) -> String {
    match e {
        ApiError::Status(409, _) => "This campaign changed, or an earlier save already completed. Your edits are retained. Copy anything you need, then discard this edit and refresh before editing the latest revision.".into(),
        ApiError::Status(422, _) => "The server refused this brief. Active campaigns need all required brief fields and completed deliverables. Closing requires results, a decision, learning and a next move. Check the fields and dates.".into(),
        _ => e.message(),
    }
}
impl App {
    pub fn edit_campaign(&mut self, saved: Option<Campaign>) {
        if self.campaign_editor.is_some() {
            self.open_campaign_document();
            return;
        }
        if let Some(b) = self.active.clone() {
            self.campaign_editor = Some(Editor::new(b, saved.as_ref()));
            self.open_campaign_document();
        }
    }
    pub fn save_campaign_brief(&mut self) {
        let Some(e) = &mut self.campaign_editor else {
            return;
        };
        if e.busy || self.active.as_deref() != Some(e.business.as_str()) {
            return;
        }
        match e.validate() {
            Ok(brief) => {
                e.busy = true;
                e.error = None;
                self.net
                    .save_campaign(e.business.clone(), e.id.clone(), e.revision, brief);
            }
            Err(error) => e.error = Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn brief_round_trip_preserves_distribution_tasks_and_unknown_fields() {
        let raw = json!({"title":"Demo campaign","status":"DRAFT","tasks":[{"id":"a","title":"Page","owner":"Maya","due":"2026-11-20","channel":"WEBSITE","status":"TODO","note":"Needs approval","futureField":42}],"distribution":{"motion":"HYBRID","funnelStage":"CONVERSION","primaryChannel":"Email + ads","futureField":"keep"},"futureField":{"keep":true}});
        let c = Campaign {
            id: "cp1".into(),
            revision: 7,
            brief: raw,
            ..Default::default()
        };
        let mut e = Editor::new("business".into(), Some(&c));
        assert!(!e.dirty());
        e.fields[0].replace_text("Changed title");
        let v = e.validate().unwrap();
        assert_eq!(v["title"], "Changed title");
        assert_eq!(v["distribution"]["futureField"], "keep");
        assert_eq!(v["tasks"][0]["futureField"], 42);
        assert_eq!(v["futureField"]["keep"], true);
        assert!(e.dirty());
        assert_eq!(e.revision, 7);
    }
    #[test]
    fn draft_can_be_incomplete_but_not_unnamed_or_have_invalid_dates() {
        let mut e = Editor::new("business".into(), None);
        assert!(e.validate().is_err());
        e.fields[0].replace_text("New campaign");
        assert!(e.validate().is_ok());
        assert!(e.value().get("distribution").is_none());
        let due = FIELDS.iter().position(|f| f.key == "reviewDate").unwrap();
        e.fields[due].replace_text("2026-02-30");
        assert!(e.validate().is_err());
        e.fields[due].replace_text("2028-02-29");
        assert!(e.validate().is_ok());
    }
    #[test]
    fn unsaved_brief_stays_open_when_switching_businesses() {
        let mut app = App::with_net(crate::net::Net::new(None));
        app.active = Some("business-a".into());
        app.edit_campaign(None);
        app.campaign_editor.as_mut().unwrap().fields[0].replace_text("Unsaved campaign");
        app.select_business("business-b");
        assert_eq!(app.active.as_deref(), Some("business-a"));
        assert!(app.campaign_editor.as_ref().unwrap().error.is_some());
        assert_eq!(
            app.campaign_editor.as_ref().unwrap().fields[0].text,
            "Unsaved campaign"
        );
    }

    #[test]
    fn brief_opens_beside_the_page_and_protects_unsaved_edits() {
        let mut app = App::with_net(crate::net::Net::new(None));
        app.screen = crate::state::Screen::Workspace;
        app.view = crate::state::View::Workspace;
        app.active = Some("business-a".into());
        app.page = crate::state::Page::Campaigns;
        app.edit_campaign(None);
        assert!(app.side_shown());
        assert_eq!(app.side_tab(), crate::side::SideTab::CampaignBrief);
        assert_eq!(app.view, crate::state::View::Workspace);
        app.campaign_editor.as_mut().unwrap().fields[0].replace_text("My brief");
        app.close_tab(&crate::side::SideTab::CampaignBrief);
        assert!(app.side_shown());
        assert_eq!(app.campaign_editor.as_ref().unwrap().fields[0].text, "My brief");
        assert!(app.campaign_editor.as_ref().unwrap().error.is_some());
        app.campaign_editor = None;
        app.close_tab(&crate::side::SideTab::CampaignBrief);
        assert!(!app.side_shown());
    }

    #[test]
    fn task_ids_survive_retries_and_edits() {
        let mut e = Editor::new("business".into(), None);
        e.fields[0].replace_text("Campaign");
        e.tasks.push(TaskEdit::new(json!({})));
        assert!(e.validate().is_err());
        e.tasks[0].title.replace_text("Landing page");
        let first = e.validate().unwrap();
        let second = e.validate().unwrap();
        assert_eq!(first["tasks"][0]["id"], second["tasks"][0]["id"]);
        assert_eq!(first["status"], "DRAFT");
        assert_eq!(first["decision"], "UNDECIDED");
    }
}
