//! The weekly brief schedule, read without creating a schedule or starting a brief.
use serde::Deserialize;
use crate::{api::{ApiResult, Client, enc}, state::{App, Load}};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub enabled: bool,
    pub next_run_at: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

pub struct State {
    pub value: Load<Option<Schedule>>,
    pub generation: u64,
    pub saving: bool,
    pub error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        Self { value: Load::Idle, generation: 0, saving: false, error: None }
    }
}

impl Client {
    pub fn change_brief_schedule(&self, business: &str, enabled: bool, conversation: crate::api::Conversation, selection: Option<serde_json::Value>) -> ApiResult<Control> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Request { request_id: String }
        #[derive(Deserialize)]
        struct Response { schedule: Schedule, request: Request, message: String }
        let mut notify = serde_json::json!({ "conversationId": conversation.id, "revision": conversation.revision, "requestId": crate::api::uuid() });
        if let Some(selection) = selection { notify["selection"] = selection; }
        let response: Response = self.post(&format!("/api/businesses/{}/brief/schedule", enc(business)), serde_json::json!({ "enabled": enabled, "notify": notify }))?;
        Ok(Control { schedule: response.schedule, request: response.request.request_id, conversation, message: response.message })
    }
    pub fn brief_schedule(&self, business: &str, enabled: Option<bool>) -> ApiResult<Option<Schedule>> {
        #[derive(Deserialize)]
        struct Response { schedule: Option<Schedule> }
        let path = format!("/api/businesses/{}/brief/schedule", enc(business));
        let response: Response = match enabled {
            Some(enabled) => self.post(&path, serde_json::json!({ "enabled": enabled }))?,
            None => self.get(&path)?,
        };
        Ok(response.schedule)
    }
}

pub struct Control {
    pub schedule: Schedule,
    pub request: String,
    pub conversation: crate::api::Conversation,
    pub message: String,
}

impl App {
    pub fn refresh_brief_schedule(&mut self) {
        if self.brief_schedule.saving { return; }
        let Some(business) = self.active.clone().filter(|_| !self.general) else { return };
        self.brief_schedule.generation += 1;
        if self.brief_schedule.value.ready().is_none() { self.brief_schedule.value = Load::Loading; }
        self.net.brief_schedule(business, self.brief_schedule.generation, None);
    }

    pub fn brief_schedule_here(&self) -> bool {
        !self.general && self.chat_id.as_ref().is_some_and(|chat| self.brief_schedule.value.ready()
            .and_then(Option::as_ref).is_some_and(|schedule| schedule.enabled && schedule.conversation_id.as_ref() == Some(chat)))
    }

    pub fn toggle_brief_schedule(&mut self) {
        if self.brief_schedule.saving || self.general || !matches!(self.turn, crate::state::Turn::Idle) { return; }
        let Some(business) = self.active.clone() else { return };
        if !matches!(self.brief_schedule.value, Load::Ready(_)) { self.refresh_brief_schedule(); return; }
        let enabled = !self.brief_schedule_here();
        self.brief_schedule.generation += 1;
        self.brief_schedule.saving = true;
        self.brief_schedule.error = None;
        self.chat_actions = false;
        self.net.brief_schedule_control(business, self.brief_schedule.generation, self.chat_id.clone(), enabled, self.turn_selection());
    }

    pub fn brief_schedule_loaded(&mut self, business: &str, generation: u64, changed: bool, result: Result<Option<Schedule>, String>) {
        if self.active.as_deref() != Some(business) || self.brief_schedule.generation != generation { return; }
        if changed { self.brief_schedule.saving = false; }
        match result {
            Ok(value) => {
                self.brief_schedule.value = Load::Ready(value);
                self.brief_schedule.error = None;
            }
            Err(error) => {
                self.brief_schedule.error = Some(error.clone());
                if self.brief_schedule.value.ready().is_none() { self.brief_schedule.value = Load::Failed(error); }
                // A missing response can follow a successful write. Read before offering another toggle.
                if changed { self.brief_schedule.value = Load::Loading; self.refresh_brief_schedule(); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> App {
        let mut s = App::new();
        crate::fixtures::agent(&mut s);
        s.brief_schedule.value = Load::Ready(Some(Schedule { enabled: true, next_run_at: "2026-11-23T09:00:00Z".into(), conversation_id: Some("c1".into()) }));
        s
    }
    #[test]
    fn toggle_waits_for_confirmation_and_ignores_duplicate_clicks_and_stale_reads() {
        let mut s = app();
        let b = s.active.clone().unwrap();
        s.toggle_brief_schedule();
        let generation = s.brief_schedule.generation;
        assert!(s.brief_schedule.saving);
        assert!(s.brief_schedule.value.ready().unwrap().as_ref().unwrap().enabled);
        s.toggle_brief_schedule();
        assert_eq!(s.brief_schedule.generation, generation);
        s.brief_schedule_loaded(&b, generation - 1, false, Ok(None));
        assert!(s.brief_schedule.saving);
        s.brief_schedule_loaded(&b, generation, true, Ok(Some(Schedule { enabled: false, next_run_at: "2026-11-23T09:00:00Z".into(), conversation_id: Some("c1".into()) })));
        assert!(!s.brief_schedule.saving);
        assert!(!s.brief_schedule.value.ready().unwrap().as_ref().unwrap().enabled);
    }
    #[test]
    fn another_business_and_general_chat_cannot_toggle_this_policy() {
        let mut s = app();
        s.brief_schedule_loaded("other-business", 0, true, Ok(None));
        assert!(s.brief_schedule.value.ready().unwrap().is_some());
        s.general = true;
        s.toggle_brief_schedule();
        assert!(!s.brief_schedule.saving);
    }
    #[test]
    fn lost_write_response_reads_status_before_offering_another_toggle() {
        let mut s = app();
        let b = s.active.clone().unwrap();
        s.toggle_brief_schedule();
        let generation = s.brief_schedule.generation;
        s.brief_schedule_loaded(&b, generation, true, Err("Could not confirm schedule".into()));
        assert!(!s.brief_schedule.saving);
        assert!(matches!(s.brief_schedule.value, Load::Loading));
        assert_eq!(s.brief_schedule.generation, generation + 1);
        s.toggle_brief_schedule();
        assert!(!s.brief_schedule.saving);
    }
    #[test]
    fn the_floating_control_requires_an_enabled_policy_bound_to_this_chat() {
        let mut s = app();
        assert!(s.brief_schedule_here());
        s.chat_id = Some("other-session".into());
        assert!(!s.brief_schedule_here());
        s.chat_id = None;
        assert!(!s.brief_schedule_here());
        s.chat_id = Some("c1".into());
        if let Load::Ready(Some(schedule)) = &mut s.brief_schedule.value { schedule.enabled = false; }
        assert!(!s.brief_schedule_here());
    }

}
