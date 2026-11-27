//! The artifact page on the move. Its page is a native WebKit view behind the
//! app's drawing: moved with the side panel, it lands a frame after the tabs
//! and lays its text out again at every width, so it trailed its strip and
//! showed the window at its edge. While the panel widens, narrows, folds or
//! comes back, the app draws a picture of the page in its place instead, on
//! the panel's own spring, and hides the page; once the panel rests the page
//! is put back under the picture at its new width and the picture fades off it.
use crate::state::{App, SIDEBAR_SPRING};
use rune::Tx;
use std::time::{Duration, Instant};

/// How long a picture may take before the panel moves without one.
const ASK_LIMIT: Duration = Duration::from_millis(160);
/// After the panel rests: time for WebKit to lay the page out at its new width.
const LAND: Duration = Duration::from_millis(90);
const LAND_LIMIT: Duration = Duration::from_millis(700);
/// The picture's fade off the page.
pub const FADE: rune::Spring = rune::Spring::new(0.18, 0.0);
const TICK: Duration = Duration::from_millis(8);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShotMove {
    /// Widen the panel over the chat, or bring it back.
    Wide,
    /// Fold the panel away to the right.
    Fold,
    /// Bring a folded panel back from the right.
    Open,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShotPhase {
    /// The picture is on its way; nothing has moved yet.
    Asked,
    /// The panel moves with the picture in the page's place.
    Moving,
    /// The panel rests; the page is back under the picture, laying itself out.
    Landing,
    /// The picture fades off the page.
    Fading,
}

pub struct PageShot {
    pub pixels: rune::Pixels,
    /// In points: the picture draws at the size the page had.
    pub size: [f32; 2],
    pub color: rune::Color,
    pub phase: ShotPhase,
    pub what: ShotMove,
    pub at: Instant,
    /// The artifact it shows, so the panel coming back can reuse it.
    pub artifact: String,
}

impl App {
    fn shot_ready(&self) -> bool {
        !self.prefs.reduce_motion && self.preview_visible() && self.page_shot.is_none()
    }

    fn page_color(&self) -> Option<(String, rune::Color)> {
        let p = self.front_artifact()?;
        let a = p.loaded.ready()?;
        let (r, g, b) = crate::native_preview::page_color(&a.preview_html);
        Some((p.id.clone(), crate::theme::hex(&format!("#{r:02x}{g:02x}{b:02x}"))))
    }

    /// Widens the side panel over the chat or brings it back, with the page's picture moving in its place.
    pub fn toggle_wide(&mut self, tx: &mut Tx) {
        if !self.ask_shot(ShotMove::Wide, tx) {
            self.side.wide = !self.side.wide;
        }
    }

    /// Folds the side panel or brings it back (⌥⌘B), with the page's picture moving in its place.
    pub fn toggle_side_smooth(&mut self, tx: &mut Tx) {
        if self.side_shown() {
            if !self.ask_shot(ShotMove::Fold, tx) {
                self.toggle_side();
            }
            return;
        }
        self.toggle_side();
        // Back from the right: the picture it folded with rides in, if it is still the page shown.
        let same = match (&self.last_shot, self.page_color()) {
            (Some(shot), Some((id, _))) => shot.artifact == id,
            _ => false,
        };
        if same && self.preview_visible() && !self.prefs.reduce_motion && self.page_shot.is_none() {
            if let Some(mut shot) = self.last_shot.take() {
                shot.phase = ShotPhase::Moving;
                shot.what = ShotMove::Open;
                shot.at = Instant::now();
                crate::native_preview::conceal(true);
                self.page_shot = Some(shot);
                tx.wake_after(TICK);
            }
        }
    }

    /// Asks for a picture of the page before `what` moves the panel; false when there is no page to picture.
    fn ask_shot(&mut self, what: ShotMove, tx: &mut Tx) -> bool {
        if !self.shot_ready() { return false; }
        let Some((artifact, color)) = self.page_color() else { return false };
        if !crate::native_preview::snapshot() { return false; }
        self.page_shot = Some(PageShot { pixels: rune::Pixels::new(), size: [0.0; 2], color, phase: ShotPhase::Asked, what, at: Instant::now(), artifact });
        tx.wake_after(Duration::ZERO);
        true
    }

    fn apply_move(&mut self, what: ShotMove) {
        match what {
            ShotMove::Wide => self.side.wide = !self.side.wide,
            ShotMove::Fold => self.toggle_side(),
            ShotMove::Open => {}
        }
    }

    /// Steps the picture along; true when the view changed.
    pub fn poll_page_shot(&mut self, tx: &mut Tx) -> bool {
        let Some(shot) = self.page_shot.as_mut() else { return false };
        let elapsed = shot.at.elapsed();
        match shot.phase {
            ShotPhase::Asked => match crate::native_preview::snapshot_take() {
                Ok(Some(pic)) => {
                    shot.pixels.set(pic.px[0], pic.px[1], pic.rgba);
                    shot.size = pic.size;
                    shot.phase = ShotPhase::Moving;
                    shot.at = Instant::now();
                    let what = shot.what;
                    crate::native_preview::conceal(true);
                    self.apply_move(what);
                    tx.wake_after(TICK);
                    true
                }
                Ok(None) if elapsed < ASK_LIMIT => {
                    tx.wake_after(TICK);
                    false
                }
                _ => {
                    // No picture in time: move as before, with the page itself.
                    let what = shot.what;
                    self.page_shot = None;
                    self.apply_move(what);
                    true
                }
            },
            ShotPhase::Moving => {
                if elapsed.as_secs_f32() < SIDEBAR_SPRING.duration * 1.35 {
                    tx.wake_after(TICK);
                    return false;
                }
                if shot.what == ShotMove::Fold {
                    // Folded away: keep the picture for the panel's way back.
                    let mut done = self.page_shot.take();
                    crate::native_preview::conceal(false);
                    if let Some(d) = done.as_mut() { d.phase = ShotPhase::Moving; }
                    self.last_shot = done;
                    return true;
                }
                shot.phase = ShotPhase::Landing;
                shot.at = Instant::now();
                // The page goes back under the picture where its slot now rests.
                crate::native_preview::conceal(false);
                if let Some(r) = self.preview_rect { crate::native_preview::place(r); }
                tx.wake_after(TICK);
                true
            }
            ShotPhase::Landing => {
                if (elapsed >= LAND && crate::native_preview::painted()) || elapsed >= LAND_LIMIT {
                    shot.phase = ShotPhase::Fading;
                    shot.at = Instant::now();
                    tx.wake_after(TICK);
                    return true;
                }
                tx.wake_after(TICK);
                false
            }
            ShotPhase::Fading => {
                if elapsed.as_secs_f32() < FADE.duration * 1.5 {
                    tx.wake_after(TICK);
                    return false;
                }
                self.page_shot = None;
                true
            }
        }
    }

    /// Whether the page's frame belongs to its picture now (`ui::follow_drawn` leaves it alone).
    pub fn page_shot_moving(&self) -> bool {
        self.page_shot.as_ref().is_some_and(|s| s.phase == ShotPhase::Moving)
    }
}
