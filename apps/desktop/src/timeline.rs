//! Positions of user turns in the current transcript, for its compact navigation rail.
use std::collections::BTreeMap;

#[derive(Default)]
pub struct State {
    owner: String,
    pub top: f32,
    positions: BTreeMap<usize, f32>,
}

impl State {
    pub fn mark(&mut self, owner: &str, index: usize, top: f32) {
        if self.owner != owner { self.owner = owner.into(); self.positions.clear(); }
        self.positions.insert(index, top);
    }

    pub fn active(&self, owner: &str, indices: &[usize]) -> Option<usize> {
        if self.owner != owner { return indices.first().copied(); }
        indices.iter().rev().copied().find(|index| self.positions.get(index).is_some_and(|y| *y <= self.top + 32.0))
            .or_else(|| indices.first().copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_the_visible_turn_and_discards_positions_from_other_chats() {
        let mut s = State::default();
        s.top = 50.0;
        s.mark("a", 0, -200.0);
        s.mark("a", 2, 60.0);
        s.mark("a", 4, 500.0);
        assert_eq!(s.active("a", &[0, 2, 4]), Some(2));
        s.mark("a", 4, 70.0);
        assert_eq!(s.active("a", &[0, 2, 4]), Some(4));
        s.mark("b", 0, 200.0);
        assert_eq!(s.active("b", &[0, 2]), Some(0));
        assert_eq!(s.active("b", &[]), None);
    }
}
