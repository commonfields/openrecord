//! Pierre markdown on desktop: rune-kit's native renderer (same family as `@pierre/words`
//! on web) with built-in syntax highlighting.

use rune_kit::syntax::Highlighter;
use rune_kit::Kit;

pub fn highlighter(_k: &Kit) -> Highlighter {
    Highlighter::builtin()
}