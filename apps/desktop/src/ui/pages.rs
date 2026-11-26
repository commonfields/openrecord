//! The workspace pages the sidebar opens: Inbox, Overview, Campaigns,
//! AI answers and Channels, read from the same endpoints the web pages use.

use rune::{Cursor, El, col, row};

use crate::api::Decision;
use crate::state::{App, Load, Page};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, label};

pub fn view(s: &App, t: &Theme) -> El {
    view_page(s, t, s.page)
}

pub fn view_page(s: &App, t: &Theme, page: Page) -> El {
    let body = match page {
        Page::Inbox => inbox(s, t),
        Page::Overview => crate::ui::overview::view(s, t, false),
        Page::Campaigns => crate::ui::campaigns::view(s, t),
        Page::AiAnswers => ai_answers(s, t),
        Page::Channels => crate::ui::channels::view(s, t),
        Page::Usage => crate::ui::account_pages::usage(s, t),
        Page::Businesses => crate::ui::account_pages::businesses(s, t),
        Page::Clients => crate::ui::account_pages::clients(s, t),
    };
    body.key(format!("page-{}", page.key()))
}


/// Opens the agent with a request typed in the composer, ready to send.
pub fn ask(request: &'static str) -> impl Fn(&mut App) + 'static {
    move |s: &mut App| {
        s.ask_agent(request);
    }
}

/// The inbox on its own page, or as a tab of the right panel.
pub fn inbox(s: &App, t: &Theme) -> El {
    crate::ui::inbox::view(s, t, false)
}

pub fn inbox_panel(s: &App, t: &Theme) -> El {
    crate::ui::inbox::view(s, t, true)
}

/// Who sent a decision: the agent message that saved it, else the chat it came
/// from in the chat list. Provider, model and the chat's title, any of which may be missing.
struct From {
    provider: Option<String>,
    model: Option<String>,
    session: Option<String>,
}

/// The logo of the provider that asked for a decision, `size` points square, if it is known.
pub fn sender_logo(s: &App, t: &Theme, d: &Decision, size: f32) -> Option<El> {
    let f = sender(s, d)?;
    let provider = f.provider.clone().unwrap_or_default();
    if provider.is_empty() && f.model.is_none() {
        return None;
    }
    let brand = crate::brands::model_brand(f.model.as_deref().unwrap_or_default(), &provider);
    Some(crate::brands::mark(t, &brand, size))
}

fn sender(s: &App, d: &Decision) -> Option<From> {
    let chat = d.conversation_id.as_deref().and_then(|id| s.chats.iter().find(|c| c.id == id));
    let from_chat = chat.map(|c| From { provider: c.providers.last().cloned(), model: None, session: c.title.clone().filter(|t| !t.is_empty()) });
    match (&d.agent, from_chat) {
        (Some(a), chat) => Some(From {
            provider: a.provider.clone().or_else(|| chat.as_ref().and_then(|c| c.provider.clone())),
            model: a.model.clone(),
            session: a.session.clone().or_else(|| chat.and_then(|c| c.session)),
        }),
        (None, chat) => chat,
    }
}

/// A model id as people say it: the catalog's name when it lists the model,
/// else its words capitalised with version numbers joined ("claude-sonnet-5-5" as "Claude Sonnet 5.5").
fn model_name(s: &App, model: &str) -> String {
    if let Load::Ready(list) = &s.catalog {
        if let Some(o) = list.iter().find(|o| o.value == model || o.value.ends_with(&format!(":{model}"))) {
            return o.name.clone();
        }
    }
    let bare = model.rsplit('/').next().unwrap_or(model);
    let mut words: Vec<String> = Vec::new();
    for part in bare.split(['-', '_']).filter(|p| !p.is_empty()) {
        let numeric = part.chars().all(|c| c.is_ascii_digit() || c == '.');
        match words.last_mut() {
            Some(last) if numeric && last.chars().all(|c| c.is_ascii_digit() || c == '.') => {
                last.push('.');
                last.push_str(part);
            }
            _ if part.eq_ignore_ascii_case("gpt") => words.push("GPT".into()),
            _ => {
                let mut c = part.chars();
                words.push(c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default());
            }
        }
    }
    words.join(" ")
}

/// Who asked for a decision, and the chat it came from with when.
pub fn sender_words(s: &App, d: &Decision, when: &str) -> (String, String) {
    let Some(f) = sender(s, d) else {
        return ("OpenRecord".into(), format!("{}, {when}", d.business_name));
    };
    let provider = f.provider.clone().unwrap_or_default();
    // The model's name says the brand already ("Claude Sonnet 5.5"); the brand alone when the model is unknown.
    let brand = crate::brands::brand(&crate::brands::model_brand(f.model.as_deref().unwrap_or_default(), &provider)).0;
    let name = match f.model.as_deref().map(|m| model_name(s, m)) {
        // A bare family name ("sonnet") reads better with its maker in front.
        Some(n) if !n.chars().any(|c| c.is_ascii_digit()) && !n.to_lowercase().contains(&brand.to_lowercase()) => format!("{brand} {n}"),
        Some(n) => n,
        None => brand,
    };
    let about = match &f.session {
        Some(title) => format!("In \u{201c}{title}\u{201d}, {when}"),
        None => format!("From a chat, {when}"),
    };
    (name, about)
}

pub fn model_picker(s: &App, t: &Theme) -> El {
    let head = label("Measurement model", type_::XS_MEDIUM, t.muted_foreground);
    let body = match &s.models {
        Load::Ready(list) if list.is_empty() => {
            label("No supported measurement model is configured. This re-check can't run here.", type_::SM_13, t.muted_foreground).wrap()
        }
        Load::Ready(list) => {
            let mut r = row().w_full().gap(6.0).flex_wrap();
            for m in list {
                let on = s.model.as_deref() == Some(m.as_str());
                let name = m.clone();
                let chip = row()
                    .key(format!("model-{m}"))
                    .h(28.0)
                    .px(10.0)
                    .radius(14.0)
                    .center()
                    .role("radio")
                    .label(m.clone())
                    .focusable(true)
                    .cursor(Cursor::Pointer)
                    .hover(t.hover_tint)
                    .motion(CONTROL)
                    .fill(if on { t.primary } else { t.control })
                    .on_press(move |s: &mut App| s.choose_model(&name))
                    .child(label(m.clone(), type_::XS_MEDIUM, if on { t.primary_foreground } else { t.foreground }));
                r = r.child(if on { chip } else { shadows(chip, &t.control_shadow) });
            }
            r
        }
        Load::Failed(e) => label(e.clone(), type_::SM_13, t.wrong).wrap(),
        _ => label("Loading models…", type_::SM_13, t.muted_foreground),
    };
    col().key("model-picker").w_full().gap(8.0).child(head).child(body)
}

fn ai_answers(s: &App, t: &Theme) -> El {
    crate::ui::issues::view(s, t)
}
