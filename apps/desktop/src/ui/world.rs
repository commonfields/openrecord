//! The Realtime world map: country shapes on a Miller projection, the places
//! people are as dots sized by how many are there, and zoom: the + and −
//! buttons, a pinch or ⌘ and scroll toward the pointer, a double-click, and a
//! drag to pan. Plain scrolling still scrolls the page.

use std::f32::consts::PI;

use rune::{Color, Cursor, El, LineCap, Shape, canvas, col, el, row};

use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{ico, label};
use crate::ui::world_land::{POINTS, RINGS};

/// Where a country sits on the map (its rough centre), by ISO code.
pub fn centre(code: &str) -> Option<(f32, f32)> {
    Some(match code {
        "US" => (39.8, -98.6), "CA" => (56.1, -106.3), "MX" => (23.6, -102.6), "BR" => (-14.2, -51.9), "AR" => (-38.4, -63.6), "CL" => (-35.7, -71.5),
        "CO" => (4.6, -74.3), "PE" => (-9.2, -75.0), "GB" => (54.0, -2.0), "IE" => (53.4, -8.2), "FR" => (46.2, 2.2), "DE" => (51.2, 10.4),
        "NL" => (52.1, 5.3), "BE" => (50.5, 4.5), "ES" => (40.5, -3.7), "PT" => (39.4, -8.2), "IT" => (41.9, 12.6), "CH" => (46.8, 8.2),
        "AT" => (47.5, 14.6), "SE" => (60.1, 18.6), "NO" => (60.5, 8.5), "DK" => (56.3, 9.5), "FI" => (61.9, 25.7), "PL" => (51.9, 19.1),
        "CZ" => (49.8, 15.5), "UA" => (48.4, 31.2), "RO" => (45.9, 25.0), "GR" => (39.1, 21.8), "TR" => (39.0, 35.2), "RU" => (61.5, 105.3),
        "IL" => (31.0, 34.9), "AE" => (23.4, 53.8), "SA" => (23.9, 45.1), "EG" => (26.8, 30.8), "NG" => (9.1, 8.7), "KE" => (-0.0, 37.9),
        "ZA" => (-30.6, 22.9), "MA" => (31.8, -7.1), "IN" => (20.6, 79.0), "PK" => (30.4, 69.3), "BD" => (23.7, 90.4), "CN" => (35.9, 104.2),
        "JP" => (36.2, 138.3), "KR" => (35.9, 127.8), "TW" => (23.7, 121.0), "HK" => (22.3, 114.2), "SG" => (1.35, 103.8), "MY" => (4.2, 102.0),
        "TH" => (15.9, 100.9), "VN" => (14.1, 108.3), "PH" => (12.9, 121.8), "ID" => (-0.8, 113.9), "AU" => (-25.3, 133.8), "NZ" => (-40.9, 174.9),
        _ => return None,
    })
}

const TOP: f32 = 84.0;
const BOTTOM: f32 = -58.0;
pub const MAX_ZOOM: f32 = 8.0;
/// The view a reset returns to: the whole map.
pub const HOME: (f32, f32) = (10.0, 20.0);

/// Miller's y for a latitude, in the same units as x in radians.
fn miller(lat: f32) -> f32 {
    1.25 * (PI / 4.0 + 0.4 * lat.to_radians()).tan().ln()
}

fn latitude(y: f32) -> f32 {
    (2.5 * (y / 1.25).exp().atan() - 0.625 * PI).to_degrees()
}

/// Where the map is looked at from: its scale in points per radian and the
/// centre, in projected units, kept inside the map's edges.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub scale: f32,
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
}

impl Camera {
    pub fn new(zoom: f32, center: (f32, f32), w: f32, h: f32) -> Camera {
        let (top, bottom) = (miller(TOP), miller(BOTTOM));
        // At zoom 1 the map covers the frame; zooming in only ever narrows it.
        let base = (w / (2.0 * PI)).max(h / (top - bottom));
        let scale = base * zoom.clamp(1.0, MAX_ZOOM);
        let (hw, hh) = (w / 2.0 / scale, h / 2.0 / scale);
        let clamp = |v: f32, lo: f32, hi: f32| if lo > hi { (lo + hi) / 2.0 } else { v.clamp(lo, hi) };
        Camera { scale, cx: clamp(center.0.to_radians(), -PI + hw, PI - hw), cy: clamp(miller(center.1.clamp(BOTTOM, TOP)), bottom + hh, top - hh), w, h }
    }

    pub fn project(&self, lon: f32, lat: f32) -> [f32; 2] {
        [(lon.to_radians() - self.cx) * self.scale + self.w / 2.0, (self.cy - miller(lat.clamp(BOTTOM - 10.0, TOP + 5.0))) * self.scale + self.h / 2.0]
    }

    /// The longitude and latitude under a point of the frame.
    pub fn unproject(&self, x: f32, y: f32) -> (f32, f32) {
        (((x - self.w / 2.0) / self.scale + self.cx).to_degrees(), latitude(self.cy - (y - self.h / 2.0) / self.scale))
    }

    /// The centre as longitude and latitude.
    pub fn center(&self) -> (f32, f32) {
        (self.cx.to_degrees(), latitude(self.cy))
    }
}

/// Zooms by `factor`, keeping the place under (`x`, `y`) of the frame where it is.
pub fn zoom_at(s: &mut App, factor: f32, x: f32, y: f32, w: f32, h: f32) {
    let cam = Camera::new(s.map_zoom, s.map_center, w, h);
    let (lon, lat) = cam.unproject(x, y);
    let zoom = (s.map_zoom * factor).clamp(1.0, MAX_ZOOM);
    let scale = Camera::new(zoom, s.map_center, w, h).scale;
    // The centre that puts (lon, lat) back under the pointer at the new scale.
    let cx = lon.to_radians() - (x - w / 2.0) / scale;
    let cy = miller(lat) + (y - h / 2.0) / scale;
    s.map_zoom = zoom;
    s.map_center = Camera::new(zoom, (cx.to_degrees(), latitude(cy)), w, h).center();
}

/// The map, `height` points tall, filling its width; `places` are (country code, name, people).
pub fn view(s: &App, t: &Theme, height: f32, places: &[(String, String, f64)]) -> El {
    let w = if s.map_w > 0.0 { s.map_w } else { 900.0 };
    let h = height;
    let cam = Camera::new(s.map_zoom, s.map_center, w, h);
    let ink = if t.dark { Color::WHITE } else { Color::BLACK };
    let mut sh = Shape::new();
    let line = (0.6 + 0.15 * s.map_zoom.min(4.0)).min(1.2);
    for &(start, len) in RINGS.iter() {
        let pts: Vec<[f32; 2]> = POINTS[start as usize..(start + len) as usize].iter().map(|&(lon, lat)| cam.project(lon as f32 / 10.0, lat as f32 / 10.0)).collect();
        // Skip shapes wholly off the frame.
        let (minx, maxx) = pts.iter().fold((f32::MAX, f32::MIN), |a, p| (a.0.min(p[0]), a.1.max(p[0])));
        let (miny, maxy) = pts.iter().fold((f32::MAX, f32::MIN), |a, p| (a.0.min(p[1]), a.1.max(p[1])));
        if maxx < 0.0 || minx > w || maxy < 0.0 || miny > h {
            continue;
        }
        sh = sh.fill(pts.clone(), ink.alpha(if t.dark { 0.075 } else { 0.06 }));
        sh = sh.stroke_with(pts, true, line, LineCap::Round, ink.alpha(if t.dark { 0.13 } else { 0.16 }));
    }
    // Where people are: a soft halo and a core, sized by share of the busiest place.
    let most = places.iter().map(|p| p.2).fold(1.0, f64::max);
    let disc = |sh: Shape, c: [f32; 2], r: f32, color: Color| {
        let pts: Vec<[f32; 2]> = (0..28).map(|k| {
            let a = k as f32 / 28.0 * std::f32::consts::TAU;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        }).collect();
        sh.fill(pts, color)
    };
    let mut pins = Vec::new();
    for (code, name, users) in places {
        let Some((lat, lon)) = centre(code) else { continue };
        let p = cam.project(lon, lat);
        if p[0] < -20.0 || p[0] > w + 20.0 || p[1] < -20.0 || p[1] > h + 20.0 {
            continue;
        }
        let k = (users / most).sqrt() as f32;
        let r = 3.5 + 4.5 * k;
        sh = disc(sh, p, r * 2.4, t.chart.primary.alpha(0.14));
        sh = disc(sh, p, r, t.chart.primary.alpha(0.95));
        // A hover target over the dot with the place and its count.
        pins.push(el().key(format!("map-pin-{code}")).absolute(p[0] - r - 3.0, p[1] - r - 3.0).size(2.0 * r + 6.0, 2.0 * r + 6.0).radius(r + 3.0).help(format!("{name}: {} online", crate::insights::int(*users))));
    }
    let map = canvas(sh.view_box(w, h)).size(w, h).a11y_hidden();

    let control = |key: &str, icon: &'static rune::Icon, name: &str| {
        row().key(key.to_string()).size(28.0, 28.0).radius(6.0).center().role("button").label(name.to_string()).help(name.to_string()).focusable(true).cursor(Cursor::Pointer).hover(t.hover_tint).child(ico(icon, 14.0, t.muted_foreground))
    };
    let controls = shadows(
        col()
            .key("map-controls")
            .pin(None, Some(12.0), Some(12.0), None)
            .padding(2.0)
            .gap(2.0)
            .radius(8.0)
            .fill(t.popover)
            .child(control("map-home", &crate::icons::GLOBE, "Show the whole map").on_press(|s: &mut App| {
                s.map_zoom = 1.0;
                s.map_center = HOME;
            }))
            .child(control("map-in", &crate::icons::PLUS, "Zoom in").disabled(s.map_zoom >= MAX_ZOOM).on_press(move |s: &mut App| zoom_at(s, 1.6, w / 2.0, h / 2.0, w, h)))
            .child(control("map-out", &crate::icons::MINUS, "Zoom out").disabled(s.map_zoom <= 1.0).on_press(move |s: &mut App| zoom_at(s, 1.0 / 1.6, w / 2.0, h / 2.0, w, h))),
        &t.float_shadow,
    );
    let scale_note = label(format!("{:.1}×", s.map_zoom), type_::XS11.features("'tnum' 1"), t.muted_foreground).pin(Some(14.0), None, None, Some(10.0));
    col()
        .key("world-map")
        .w_full()
        .h(h)
        .clip_rounded(10.0)
        .cursor(if s.map_drag.is_some() { Cursor::Grabbing } else { Cursor::Grab })
        .on_layout(|s: &mut App, r: [f32; 4]| s.map_w = r[2])
        .on_drag(move |s: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            match d.phase {
                rune::Phase::Down => s.map_drag = Some(Camera::new(s.map_zoom, s.map_center, w, h).center()),
                rune::Phase::Move => {
                    if let Some(from) = s.map_drag {
                        let cam = Camera::new(s.map_zoom, from, w, h);
                        s.map_center = cam.unproject(w / 2.0 - d.dx, h / 2.0 - d.dy);
                    }
                }
                rune::Phase::Up => {
                    if d.cancelled() {
                        if let Some(from) = s.map_drag {
                            s.map_center = from;
                        }
                    }
                    s.map_drag = None;
                }
            }
        })
        .on_double_press(move |s: &mut App| zoom_at(s, 2.0, w / 2.0, h / 2.0, w, h))
        .on_magnify(move |s: &mut App, e: rune::MagnifyEvent, _tx: &mut rune::Tx| {
            zoom_at(s, 1.0 + e.delta, e.x, e.y, w, h);
            true
        })
        .on_wheel(move |s: &mut App, e: rune::WheelEvent, _tx: &mut rune::Tx| {
            // ⌘ and scroll zooms; a plain scroll is the page's.
            if !e.mods.cmd {
                return false;
            }
            zoom_at(s, (1.0 + e.dy / 300.0).clamp(0.5, 2.0), e.x, e.y, w, h);
            true
        })
        .child(map)
        .children(pins)
        .child(controls)
        .child(scale_note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_and_back() {
        let cam = Camera::new(2.0, (10.0, 40.0), 900.0, 480.0);
        let p = cam.project(2.35, 48.85);
        let (lon, lat) = cam.unproject(p[0], p[1]);
        assert!((lon - 2.35).abs() < 0.01 && (lat - 48.85).abs() < 0.01);
    }

    #[test]
    fn the_whole_map_stays_in_frame() {
        // At zoom 1 the centre is pulled in so no edge of the world shows past the frame.
        let cam = Camera::new(1.0, (170.0, 80.0), 900.0, 480.0);
        assert!(cam.project(-180.0, 0.0)[0] <= 0.5);
        assert!(cam.project(180.0, 0.0)[0] >= 899.5);
    }
}
