//! Home's backdrop while idle: a picture turned into a dither.
//!
//! The built-in scenes are drawn here (a monochrome glow over a dark wave for
//! Dark, a long-exposure dusk over water for Light). A picture the person
//! chooses in Settings is copied into the app's support folder and goes through
//! the same steps: shrunk to a grid of cells, its tones stretched, then Atkinson
//! dithered into two inks that follow the theme. The work runs on a thread and
//! lands in a shared `Pixels`, so the view never waits on it.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rune::Pixels;
use serde::{Deserialize, Serialize};

/// What Home shows behind the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HomeBackground {
    #[default]
    Default,
    Custom,
    Off,
}

/// Cells across: each becomes one dot of the dither.
const CELLS: u32 = 900;
/// Largest picture accepted, before it is copied.
const MAX_BYTES: u64 = 40 * 1024 * 1024;

/// Two inks per theme: shade and light.
fn inks(dark: bool) -> ([u8; 3], [u8; 3]) {
    if dark { ([12, 12, 12], [196, 196, 196]) } else { ([120, 104, 92], [246, 241, 234]) }
}

#[derive(Clone, PartialEq)]
struct Key {
    dark: bool,
    choice: HomeBackground,
    stamp: Option<std::time::SystemTime>,
}

struct Slot {
    pixels: Pixels,
    key: Option<Key>,
}

thread_local! {
    static SLOT: RefCell<Slot> = RefCell::new(Slot { pixels: Pixels::new(), key: None });
}

/// The last picture that could not be read, for Settings to show.
static ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn error() -> Option<String> {
    ERROR.lock().ok().and_then(|e| e.clone())
}

fn set_error(e: Option<String>) {
    if let Ok(mut slot) = ERROR.lock() {
        *slot = e;
    }
}

/// Where a chosen picture is kept.
pub fn custom_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/OpenRecord/home-background"))
}

pub fn has_custom() -> bool {
    custom_path().is_some_and(|p| p.is_file())
}

/// Copies a picture the person chose. Reading it happens when Home next draws.
pub fn store(from: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(from).map_err(|e| format!("Couldn't open that picture: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err("That picture is larger than 40 MB. Choose a smaller one.".into());
    }
    let to = custom_path().ok_or("Couldn't find the app's support folder.")?;
    let _ = std::fs::create_dir_all(to.parent().unwrap_or(&to));
    std::fs::copy(from, &to).map_err(|e| format!("Couldn't save that picture: {e}"))?;
    set_error(None);
    Ok(())
}

pub fn remove() {
    if let Some(p) = custom_path() {
        let _ = std::fs::remove_file(p);
    }
    set_error(None);
}

/// The backdrop for this theme and choice, starting the work when either changed.
/// `None` when Home shows no backdrop.
pub fn current(choice: HomeBackground, dark: bool) -> Option<Pixels> {
    let choice = if choice == HomeBackground::Custom && !has_custom() { HomeBackground::Default } else { choice };
    if choice == HomeBackground::Off {
        return None;
    }
    let stamp = (choice == HomeBackground::Custom)
        .then(|| custom_path().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok()))
        .flatten();
    let key = Key { dark, choice, stamp };
    SLOT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.key.as_ref() != Some(&key) {
            slot.key = Some(key);
            let pixels = slot.pixels.clone();
            std::thread::spawn(move || {
                let tone = match choice {
                    HomeBackground::Custom => match custom_path().ok_or_else(|| "missing".to_string()).and_then(|p| read(&p)) {
                        Ok(t) => {
                            set_error(None);
                            t
                        }
                        Err(e) => {
                            set_error(Some(e));
                            scene(dark)
                        }
                    },
                    _ => scene(dark),
                };
                let (w, h, rgba) = dither(&tone, dark);
                pixels.set(w, h, rgba);
            });
        }
        Some(slot.pixels.clone())
    })
}

/// Luminance in 0..1, row by row.
struct Tone {
    w: u32,
    h: u32,
    l: Vec<f32>,
}

fn read(path: &Path) -> Result<Tone, String> {
    let img = image::ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| format!("Couldn't open that picture: {e}"))?
        .decode()
        .map_err(|_| "That file isn't a picture this app can read. Choose a PNG or JPEG.".to_string())?;
    let (w0, h0) = (img.width().max(1), img.height().max(1));
    let w = CELLS.min(w0.max(1));
    let h = ((h0 as f32 * w as f32 / w0 as f32).round() as u32).max(1);
    let small = img.resize_exact(w, h, image::imageops::FilterType::Triangle).into_luma8();
    let mut l: Vec<f32> = small.as_raw().iter().map(|v| *v as f32 / 255.0).collect();
    stretch(&mut l);
    Ok(Tone { w, h, l })
}

/// Stretches the tones so the darkest and lightest few percent reach the inks.
fn stretch(l: &mut [f32]) {
    if l.is_empty() {
        return;
    }
    let mut sorted = l.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let lo = sorted[sorted.len() * 2 / 100];
    let hi = sorted[(sorted.len() * 98 / 100).min(sorted.len() - 1)];
    let span = (hi - lo).max(0.05);
    for v in l.iter_mut() {
        *v = ((*v - lo) / span).clamp(0.0, 1.0);
    }
}

fn smooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn blob(u: f32, v: f32, cx: f32, cy: f32, rx: f32, ry: f32) -> f32 {
    (-(((u - cx) / rx).powi(2) + ((v - cy) / ry).powi(2))).exp()
}

/// The built-in scenes, 16:10.
fn scene(dark: bool) -> Tone {
    let (w, h) = (CELLS, CELLS * 10 / 16);
    let mut l = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        for x in 0..w {
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            l.push(if dark { night(u, v) } else { dusk(u, v) });
        }
    }
    Tone { w, h, l }
}

/// Light falling from the top onto a dark wave that rises on the right.
fn night(u: f32, v: f32) -> f32 {
    let mut l = 0.1 + 0.9 * blob(u, v, 0.55, -0.08, 0.6, 0.55);
    // The wave: an ellipse from the lower right with a soft rim.
    let d = (((u - 1.05) / 0.62).powi(2) + ((v - 1.15) / 0.86).powi(2)).sqrt();
    l *= 0.12 + 0.88 * smooth(0.9, 1.06, d);
    l *= 1.0 - 0.9 * blob(u, v, 0.0, 0.45, 0.22, 0.38);
    l += 0.22 * blob(u, v, 0.12, 1.08, 0.35, 0.2);
    l.clamp(0.0, 1.0)
}

/// A long-exposure dusk: pale sky streaks, a dark horizon, glinting water, a shaded shore.
fn dusk(u: f32, v: f32) -> f32 {
    let stops = [(0.0, 0.72), (0.18, 0.78), (0.3, 0.86), (0.4, 0.76), (0.45, 0.42), (0.49, 0.58), (0.56, 0.8), (0.68, 0.74), (0.82, 0.62), (1.0, 0.5)];
    let mut l = stops[stops.len() - 1].1;
    for pair in stops.windows(2) {
        let ((a, la), (b, lb)) = (pair[0], pair[1]);
        if v >= a && v <= b {
            l = la + (lb - la) * smooth(a, b, v);
            break;
        }
    }
    // Streaks drawn out sideways, as a slow shutter makes them.
    let wobble = 0.012 * (u * 5.0).sin() + 0.008 * (u * 11.0 + 1.3).sin();
    l += 0.05 * ((v + wobble) * 70.0).sin() * (1.0 - smooth(0.4, 0.5, v)) * 0.8;
    l += 0.035 * ((v - wobble) * 52.0 + 0.7).sin() * smooth(0.5, 0.6, v);
    l += 0.12 * blob(u, v, 0.6, 0.2, 0.55, 0.06) + 0.1 * blob(u, v, 0.85, 0.3, 0.4, 0.05);
    l += 0.1 * blob(u, v, 0.6, 0.6, 0.5, 0.05);
    l -= 0.35 * blob(u, v, 0.05, 0.8, 0.45, 0.18);
    l.clamp(0.0, 1.0)
}

/// Atkinson dithering into the theme's two inks.
fn dither(tone: &Tone, dark: bool) -> (u32, u32, Vec<u8>) {
    let (w, h) = (tone.w as usize, tone.h as usize);
    let mut l = tone.l.clone();
    let (shade, light) = inks(dark);
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let old = l[i];
            let on = old >= 0.5;
            let err = (old - if on { 1.0 } else { 0.0 }) / 8.0;
            for (dx, dy) in [(1isize, 0usize), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)] {
                let (nx, ny) = (x as isize + dx, y + dy);
                if nx >= 0 && (nx as usize) < w && ny < h {
                    l[ny * w + nx as usize] += err;
                }
            }
            let c = if on { light } else { shade };
            out[i * 4..i * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }
    (tone.w, tone.h, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenes_dither_to_two_inks() {
        for dark in [false, true] {
            let (w, h, rgba) = dither(&scene(dark), dark);
            assert_eq!(rgba.len(), (w * h * 4) as usize);
            let (a, b) = inks(dark);
            assert!(rgba.chunks(4).all(|p| p[..3] == a || p[..3] == b));
        }
    }
}
