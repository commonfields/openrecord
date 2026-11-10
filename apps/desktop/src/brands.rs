//! Provider brands and model series, as the web names and colours them
//! (`components/provider-logo.tsx`, `modelSeries` in `components/charts.tsx`).
//! A model keeps one colour slot on every page and in every period.

use rune::{Color, El, Icon, TextStyle, icon, row, text};

use crate::brand_marks as m;
use crate::theme::{Theme, hex};

/// How a brand is drawn: its mark on a white tile, a mark on a coloured tile,
/// or a letter on a coloured tile.
#[derive(Clone, Copy, Debug)]
pub enum Mark {
    Icon(&'static Icon),
    /// The OpenAI blossom on a tile that inverts with the theme.
    Inverted(&'static Icon),
    Glyph(&'static str, Tile),
    None,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tile {
    Teal,
    Navy,
    Dashed,
    Ink,
}

#[derive(Clone, Copy, Debug)]
pub struct Brand {
    pub label: &'static str,
    pub mark: Mark,
}

const fn b(label: &'static str, mark: Mark) -> Brand {
    Brand { label, mark }
}

fn known(provider: &str) -> Option<Brand> {
    use Mark::*;
    Some(match provider {
        "anthropic" => b("Claude", Icon(&m::ANTHROPIC)),
        "claude" => b("Claude", Icon(&m::CLAUDE)),
        "claude-code" => b("Claude Code", Icon(&m::CLAUDE_CODE)),
        "opencode" => b("OpenCode", Icon(&m::OPENCODE)),
        "nvidia" => b("NVIDIA", Icon(&m::NVIDIA)),
        "cursor" => b("Cursor", Icon(&m::CURSOR)),
        "codex" => b("Codex", Inverted(&m::OPENAI)),
        "perplexity" => b("Perplexity", Icon(&m::PERPLEXITY)),
        "deepseek" => b("DeepSeek", Icon(&m::DEEPSEEK)),
        "qwen" => b("Qwen", Icon(&m::QWEN)),
        "gemini" => b("Gemini", Icon(&m::GEMINI)),
        "google" => b("Google", Icon(&m::GOOGLE)),
        "googlesearch" | "google-search" => b("Google Search", Icon(&m::GOOGLE)),
        "openai" | "gpt" => b("OpenAI", Inverted(&m::OPENAI)),
        "chatgpt" => b("ChatGPT", Inverted(&m::OPENAI)),
        "bing" | "microsoft" => b("Bing", Glyph("B", Tile::Teal)),
        "grok" => b("Grok", Icon(&m::X)),
        "xai" => b("xAI", Icon(&m::X)),
        "mistral" => b("Mistral", Icon(&m::MISTRAL)),
        "meta" => b("Meta", Icon(&m::META)),
        "metaai" => b("Meta AI", Icon(&m::META)),
        "llama" => b("Llama", Icon(&m::META)),
        "kimi" => b("Kimi", Icon(&m::KIMI)),
        "moonshot" => b("Moonshot", Icon(&m::KIMI)),
        "ollama" => b("Ollama", Icon(&m::OLLAMA)),
        "openrouter" => b("OpenRouter", Icon(&m::OPENROUTER)),
        "cliproxy" => b("CLIProxyAPI", Glyph("CP", Tile::Navy)),
        "mock" => b("Mock", Glyph("M", Tile::Dashed)),
        "9router" => b("9Router", Glyph("9", Tile::Ink)),
        _ => return Option::None,
    })
}

/// The brand a provider key names; an unknown one keeps its own name and
/// draws its first letter.
pub fn brand(provider: &str) -> (String, Mark) {
    match known(&provider.to_lowercase()) {
        Some(b) => (b.label.to_string(), b.mark),
        None => (provider.to_string(), Mark::None),
    }
}

/// The brand of the model itself, apart from the harness carrying it.
#[allow(dead_code)] // The agent's model picker uses it next.
pub fn model_brand(model: &str, fallback: &str) -> String {
    let name = model.to_lowercase();
    if name.starts_with("nvidia/") {
        return "nvidia".into();
    }
    if ["claude", "sonnet", "haiku", "opus"].iter().any(|k| name.contains(k)) {
        return "claude".into();
    }
    if name.contains("gemini") {
        return "gemini".into();
    }
    let o_series = name.split(['/', '-']).any(|p| matches!(p, "o1" | "o3" | "o4"));
    if name.contains("gpt") || name.contains("codex") || o_series {
        return "openai".into();
    }
    for brand in ["deepseek", "qwen", "kimi", "llama", "grok", "mistral"] {
        if name.contains(brand) {
            return brand.into();
        }
    }
    fallback.into()
}

/// A provider's mark on its small rounded tile, `size` points square.
pub fn logo(t: &Theme, provider: &str, size: f32) -> El {
    let (name, mark) = brand(provider);
    let near_black = hex("#171717");
    let tile = |fill: Color, ring: Color| row().size(size, size).radius(size * 0.25).center().fill(fill).border(1.0, ring).help(name.clone());
    let glyph = |g: &str, ink: Color| text(g.to_string()).font(TextStyle::new(size * if g.len() > 1 { 0.42 } else { 0.58 }, 700.0).lh(size)).color(ink);
    match mark {
        // The tile stays white in both themes, so black marks stay black.
        Mark::Icon(i) => tile(Color::WHITE, t.border).child(icon(i, size * 0.7).color(near_black)),
        Mark::Inverted(i) => {
            let (fill, ink) = if t.dark { (Color::WHITE, near_black) } else { (near_black, Color::WHITE) };
            tile(fill, fill).child(icon(i, size * 0.75).color(ink))
        }
        Mark::Glyph(g, kind) => {
            let (fill, ring, ink) = match kind {
                Tile::Teal => (hex("#0e7c86"), hex("#0e7c86"), Color::WHITE),
                Tile::Navy => if t.dark { (hex("#7096f9"), hex("#7096f9"), Color::WHITE) } else { (hex("#020c44"), hex("#020c44"), Color::WHITE) },
                Tile::Dashed => (Color::TRANSPARENT, t.border, t.muted_foreground),
                Tile::Ink => (t.primary_ink.alpha(0.15), t.primary_ink.alpha(0.3), t.primary_ink),
            };
            tile(fill, ring).child(glyph(g, ink))
        }
        Mark::None => {
            let first = name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
            tile(Color::WHITE, t.border).child(glyph(&first, near_black))
        }
    }
}

// ---- Model series -----------------------------------------------------------

const SLOTS: usize = 12;
const KNOWN_SLOTS: [&str; SLOTS] = ["openai", "claude", "gemini", "perplexity", "deepseek", "qwen", "googlesearch", "bing", "grok", "mistral", "meta", "kimi"];
pub const OTHER: &str = "__other";

fn canonical(p: &str) -> String {
    let p = p.to_lowercase();
    match p.as_str() {
        "anthropic" => "claude",
        "chatgpt" | "gpt" => "openai",
        "google-search" | "google" => "googlesearch",
        "microsoft" => "bing",
        "xai" => "grok",
        "llama" | "metaai" => "meta",
        "moonshot" => "kimi",
        _ => return p,
    }
    .to_string()
}

/// One line in a per-model chart: the providers it stands for and its colour slot.
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub key: String,
    pub label: String,
    /// The colour slot, or `None` for "Other".
    pub slot: Option<usize>,
    pub members: Vec<String>,
}

impl Series {
    pub fn color(&self, t: &Theme) -> Color {
        self.slot.map(|i| t.chart.series[i]).unwrap_or(t.muted_foreground)
    }
}

/// Known models keep a fixed slot; unknown ones take the free slots in name
/// order, and past the last slot they fold into "Other".
pub fn model_series<'a>(providers: impl IntoIterator<Item = &'a str>) -> Vec<Series> {
    let mut slots: Vec<Option<Vec<String>>> = vec![None; SLOTS];
    let mut unknown: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in providers {
        if !seen.insert(p.to_string()) {
            continue;
        }
        match KNOWN_SLOTS.iter().position(|k| *k == canonical(p)) {
            Some(i) => slots[i].get_or_insert_with(Vec::new).push(p.to_string()),
            None => unknown.push(p.to_string()),
        }
    }
    unknown.sort();
    let mut other = Vec::new();
    for p in unknown {
        match slots.iter().position(Option::is_none) {
            Some(i) => slots[i] = Some(vec![p]),
            None => other.push(p),
        }
    }
    let mut out: Vec<Series> = slots
        .into_iter()
        .enumerate()
        .filter_map(|(i, m)| m.map(|members| Series { key: members[0].clone(), label: brand(&members[0]).0, slot: Some(i), members }))
        .collect();
    if !other.is_empty() {
        out.push(Series { key: OTHER.into(), label: "Other".into(), slot: None, members: other });
    }
    out
}

/// A series' mark: the provider's logo, or "+n" for the folded rest.
pub fn series_logo(t: &Theme, s: &Series, size: f32) -> El {
    if s.key == OTHER {
        return row()
            .size(size, size)
            .radius(size * 0.25)
            .center()
            .fill(t.accent)
            .border(1.0, t.border)
            .child(text(format!("+{}", s.members.len())).font(TextStyle::new(size * 0.45, 600.0).lh(size)).color(t.muted_foreground));
    }
    logo(t, &s.key, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_models_keep_their_slot() {
        let s = model_series(["mock", "claude", "anthropic", "openai"]);
        let slot = |k: &str| s.iter().find(|x| x.key == k).and_then(|x| x.slot);
        assert_eq!(slot("openai"), Some(0));
        assert_eq!(slot("claude"), Some(1));
        assert_eq!(s.iter().find(|x| x.key == "claude").unwrap().members, ["claude", "anthropic"]);
        // The first free slot after the known ones taken.
        assert_eq!(slot("mock"), Some(2));
        assert_eq!(s[0].label, "OpenAI");
    }

    #[test]
    fn past_the_last_slot_folds_into_other() {
        let names: Vec<String> = (0..14).map(|i| format!("p{i:02}")).collect();
        let s = model_series(names.iter().map(String::as_str));
        assert_eq!(s.len(), 13);
        assert_eq!(s.last().unwrap().key, OTHER);
        assert_eq!(s.last().unwrap().members.len(), 2);
    }

    #[test]
    fn model_brands() {
        assert_eq!(model_brand("claude-sonnet-5-5", "9router"), "claude");
        assert_eq!(model_brand("gpt-5", "9router"), "openai");
        assert_eq!(model_brand("openai/o3-mini", "x"), "openai");
        assert_eq!(model_brand("nvidia/llama", "x"), "nvidia");
        assert_eq!(model_brand("something", "9router"), "9router");
    }
}
