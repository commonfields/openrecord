//! Native account setup. Credentials stay in secure, transient fields and are
//! sent only to the authenticated API; provider authorization uses the OS sheet.
use crate::api::{ApiResult, Client, enc};
use crate::state::{App, Load};
use rune::TextEdit;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Google,
    GoogleAds,
    GoogleBusiness,
    Meta,
    Stripe,
    WordPress,
}
impl Kind {
    pub fn from_key(key: &str) -> Option<Self> {
        Some(match key {
            "google" => Self::Google,
            "google_ads" => Self::GoogleAds,
            "google_business" => Self::GoogleBusiness,
            "meta" => Self::Meta,
            "revenue" => Self::Stripe,
            "wordpress" => Self::WordPress,
            _ => return None,
        })
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::GoogleAds => "google_ads",
            Self::GoogleBusiness => "google_business",
            Self::Meta => "meta",
            Self::Stripe => "revenue",
            Self::WordPress => "wordpress",
        }
    }
    pub fn path(self, business: &str) -> String {
        let b = enc(business);
        match self {
            Self::Google => format!("/api/growth/clients/{b}/search-console"),
            Self::Stripe => format!("/api/revenue/clients/{b}"),
            Self::WordPress => format!("/api/businesses/{b}/wordpress"),
            _ => format!("/api/ads/clients/{b}"),
        }
    }
    pub fn keyed(self) -> bool {
        matches!(self, Self::Stripe | Self::WordPress)
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub connection: String,
    pub id: String,
    pub title: String,
    pub bound: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Detail {
    pub configured: bool,
    pub connected: bool,
    pub choices: Vec<Choice>,
    pub warning: Option<String>,
}
pub struct Setup {
    pub generation: u64,
    pub business: String,
    pub kind: Kind,
    pub loaded: Load<Detail>,
    pub site: TextEdit,
    pub username: TextEdit,
    pub secret: TextEdit,
    pub busy: bool,
    pub authorizing: bool,
    pub error: Option<String>,
    pub confirming_disconnect: bool,
}
// Never derive Debug: a command may temporarily contain an application password.
pub enum Action {
    Save {
        site: String,
        username: String,
        secret: String,
    },
    Bind(Choice),
    Unbind(Choice),
    Disconnect,
    Authorize,
}
fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
impl Client {
    pub fn channel_detail(&self, business: &str, kind: Kind) -> ApiResult<Detail> {
        let path = kind.path(business);
        let status: Value = self.get(&path)?;
        let configured = if kind.keyed() || kind == Kind::Google {
            status["configured"].as_bool().unwrap_or(false)
        } else {
            status["providers"][kind.key()]["configured"]
                .as_bool()
                .unwrap_or(false)
        };
        let mut choices = Vec::new();
        let mut warning = None;
        let connected = if kind.keyed() {
            status["connection"]["status"] == "ACTIVE"
        } else if kind == Kind::Google {
            status["binding"].is_object()
        } else {
            items(&status, "bindings")
                .iter()
                .any(|b| b["provider"] == kind.key())
        };
        if kind == Kind::Google {
            if status["binding"].is_object() {
                let b = &status["binding"];
                choices.push(Choice {
                    connection: text(b, "connectionId"),
                    id: text(b, "siteUrl"),
                    title: text(b, "siteUrl"),
                    bound: true,
                });
            }
        } else if !kind.keyed() {
            for b in items(&status, "bindings")
                .iter()
                .filter(|b| b["provider"] == kind.key())
            {
                choices.push(Choice {
                    connection: text(b, "connectionId"),
                    id: text(b, "id"),
                    title: text(b, "name"),
                    bound: true,
                });
            }
        }
        if !kind.keyed() && configured {
            for c in items(&status, "connections").iter().filter(|c| {
                c["status"] == "ACTIVE"
                    && if kind == Kind::Google {
                        c["searchConsole"] == true
                    } else {
                        c["provider"] == kind.key()
                    }
            }) {
                let connection = text(c, "id");
                let result: ApiResult<Value> = if kind == Kind::Google {
                    self.get(&format!("{path}/sites?connectionId={}", enc(&connection)))
                } else {
                    self.get(&format!(
                        "/api/ads/connections/{}/accounts",
                        enc(&connection)
                    ))
                };
                match result {
                    Ok(result) => {
                        for item in items(
                            &result,
                            if kind == Kind::Google {
                                "sites"
                            } else {
                                "accounts"
                            },
                        ) {
                            if kind != Kind::Google && item["active"] == false {
                                continue;
                            }
                            let id = text(
                                item,
                                if kind == Kind::Google {
                                    "siteUrl"
                                } else {
                                    "externalId"
                                },
                            );
                            let title = if kind == Kind::Google {
                                id.clone()
                            } else {
                                text(item, "name")
                            };
                            choices.push(Choice {
                                connection: connection.clone(),
                                id,
                                title: format!(
                                    "{title} · {}",
                                    text(
                                        c,
                                        if kind == Kind::Google {
                                            "googleEmail"
                                        } else {
                                            "displayName"
                                        }
                                    )
                                ),
                                bound: false,
                            });
                        }
                    }
                    Err(crate::api::ApiError::Unauthorized) => {
                        return Err(crate::api::ApiError::Unauthorized);
                    }
                    Err(_) => {
                        warning = Some(
                            "Some accounts could not be listed. Check again or reconnect.".into(),
                        )
                    }
                }
            }
        }
        Ok(Detail {
            configured,
            connected,
            choices,
            warning,
        })
    }
    pub fn channel_action(
        &self,
        business: &str,
        kind: Kind,
        action: Action,
    ) -> ApiResult<Option<String>> {
        let base = kind.path(business);
        let response: Value = match action {
            Action::Authorize => {
                let (path, body) = if kind == Kind::Google {
                    (
                        "/api/growth/ga4/connect",
                        json!({ "businessId": business, "connectionId": null, "returnTo": "CHANNELS" }),
                    )
                } else {
                    (
                        "/api/ads/connect",
                        json!({ "provider": kind.key(), "businessId": business }),
                    )
                };
                return self.desktop_authorization(path, body).map(Some);
            }
            Action::Save {
                site,
                username,
                secret,
            } if kind == Kind::WordPress => self.post(
                &base,
                json!({ "siteUrl": site, "username": username, "appPassword": secret }),
            )?,
            Action::Save { secret, .. } if kind == Kind::Stripe => {
                self.post(&format!("{base}/stripe"), json!({ "key": secret }))?
            }
            Action::Bind(c) => self.post(
                &format!(
                    "{base}/{}",
                    if kind == Kind::Google {
                        "binding"
                    } else {
                        "bindings"
                    }
                ),
                if kind == Kind::Google {
                    json!({ "connectionId": c.connection, "siteUrl": c.id })
                } else {
                    json!({ "connectionId": c.connection, "externalId": c.id })
                },
            )?,
            Action::Unbind(c) => self.post(
                &if kind == Kind::Google {
                    format!("{base}/binding/end")
                } else {
                    format!("{base}/bindings/{}/end", enc(&c.id))
                },
                json!({}),
            )?,
            Action::Disconnect if kind == Kind::WordPress => self.call("DELETE", &base, None)?,
            Action::Disconnect if kind == Kind::Stripe => {
                self.post(&format!("{base}/stripe/disconnect"), json!({}))?
            }
            _ => return Ok(None),
        };
        let _ = response;
        Ok(None)
    }
}
impl App {
    pub fn open_channel(&mut self, key: &str) {
        let (Some(kind), Some(business)) = (Kind::from_key(key), self.active.clone()) else {
            return;
        };
        self.close_channel();
        self.channel_generation += 1;
        let generation = self.channel_generation;
        self.channel_setup = Some(Setup {
            generation,
            business: business.clone(),
            kind,
            loaded: Load::Loading,
            site: TextEdit::new(""),
            username: TextEdit::new(""),
            secret: TextEdit::new("").secure(),
            busy: false,
            authorizing: false,
            error: None,
            confirming_disconnect: false,
        });
        self.net.channel_detail(generation, business, kind);
    }
    pub fn close_channel(&mut self) {
        self.channel_setup = None;
        crate::native_preview::cancel_authorization();
    }
    pub fn channel_action(&mut self, action: Action) {
        let Some(p) = &mut self.channel_setup else {
            return;
        };
        if p.busy {
            return;
        }
        p.busy = true;
        p.error = None;
        self.net
            .channel_action(p.generation, p.business.clone(), p.kind, action);
    }
    pub fn save_channel(&mut self) {
        let Some(p) = &self.channel_setup else { return };
        let action = Action::Save {
            site: p.site.text.clone(),
            username: p.username.text.clone(),
            secret: p.secret.text.clone(),
        };
        self.channel_action(action);
    }
    pub fn reload_channel(&mut self) {
        let Some(p) = &mut self.channel_setup else {
            return;
        };
        p.loaded = Load::Loading;
        self.net
            .channel_detail(p.generation, p.business.clone(), p.kind);
    }
}

/// Provider responses may contain private details. Show only known local copy.
pub fn error_message(error: &crate::api::ApiError) -> String {
    if let crate::api::ApiError::Status(_, body) = error {
        let reason = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string));
        let copy = match reason.as_deref() {
            Some("SecretKeyRefused" | "NotARestrictedKey") => Some(
                "Use a Stripe restricted read-only key beginning with rk_live_ or rk_test_. Full secret keys are refused.",
            ),
            Some("KeyInvalid" | "RevenueKeyRefused") => {
                Some("Stripe refused this key. Check the key or create a replacement.")
            }
            Some("KeyCannotReadCharges") => Some(
                "This key cannot read charges. Give the restricted key read-only access to Charges in Stripe.",
            ),
            Some("SiteAUTH") => Some(
                "WordPress refused the username or application password. Check them and try again.",
            ),
            Some("CannotPublish") => {
                Some("This WordPress user must be allowed to publish and edit pages and posts.")
            }
            Some("SiteREST_UNAVAILABLE") => {
                Some("The WordPress REST API is not available at this website.")
            }
            Some("ProviderQuota") => {
                Some("The provider's rate limit was reached. Try again later.")
            }
            Some("ProviderUnavailable") => {
                Some("The provider did not answer. Check the connection and try again.")
            }
            Some("AdsReauthorizationRequired" | "Ga4ReauthorizationRequired") => {
                Some("This sign-in expired. Sign in with the provider again.")
            }
            _ => None,
        };
        if let Some(copy) = copy {
            return copy.into();
        }
    }
    error.message()
}
#[cfg(test)]
mod tests {
    #[test]
    fn provider_errors_do_not_expose_their_raw_body() {
        let e = crate::api::ApiError::Status(
            409,
            r#"{"reason":"unknown","key":"private-provider-detail"}"#.into(),
        );
        assert!(!super::error_message(&e).contains("private-provider-detail"));
        let e = crate::api::ApiError::Status(409, r#"{"reason":"SecretKeyRefused"}"#.into());
        assert!(super::error_message(&e).contains("restricted read-only"));
    }
}
