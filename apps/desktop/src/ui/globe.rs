//! A dotted globe for Realtime: land as a grid of dots on an orthographic
//! projection that turns slowly, and the countries people are visiting from as
//! soft periwinkle points sized by how many are there now. Pure drawing: the
//! turn comes from the clock, so the page only has to redraw.

use rune::{Color, El, LineCap, Shape, canvas};

use crate::theme::Theme;
use crate::ui::globe_land::LAND;

/// Where a country sits on the globe (its rough centre), by ISO code.
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

/// The globe, `size` points square, turned to `spin` degrees of longitude.
pub fn view(t: &Theme, size: f32, spin: f32, places: &[(String, f64)]) -> El {
    let (r, c) = (size / 2.0 - 6.0, size / 2.0);
    let tilt = 16f32.to_radians();
    // Orthographic projection: x, y on screen and how far the point faces us (1 at the centre, 0 at the edge).
    let project = |lat: f32, lon: f32| {
        let (phi, lam) = (lat.to_radians(), (lon + spin).to_radians());
        let facing = tilt.sin() * phi.sin() + tilt.cos() * phi.cos() * lam.cos();
        let x = r * phi.cos() * lam.sin();
        let y = r * (tilt.cos() * phi.sin() - tilt.sin() * phi.cos() * lam.cos());
        ([c + x, c - y], facing)
    };
    let disc = |cx: f32, cy: f32, rad: f32, color: Color, sh: Shape| {
        let pts: Vec<[f32; 2]> = (0..24).map(|k| {
            let a = k as f32 / 24.0 * std::f32::consts::TAU;
            [cx + rad * a.cos(), cy + rad * a.sin()]
        }).collect();
        sh.fill(pts, color)
    };
    let ink = if t.dark { Color::WHITE } else { Color::BLACK };
    // The sphere: a whisper of colour and a hairline rim.
    let mut sh = disc(c, c, r, ink.alpha(0.02), Shape::new());
    let circle = |rad: f32| -> Vec<[f32; 2]> { (0..=120).map(|k| { let a = k as f32 / 120.0 * std::f32::consts::TAU; [c + rad * a.cos(), c + rad * a.sin()] }).collect() };
    sh = sh.stroke_with(circle(r), false, 1.0, LineCap::Butt, ink.alpha(0.08));
    // Latitude lines every 30 degrees, only on the side facing us.
    for lat in [-60.0f32, -30.0, 0.0, 30.0, 60.0] {
        let mut run: Vec<[f32; 2]> = Vec::new();
        for k in 0..=144 {
            let (p, facing) = project(lat, -180.0 + k as f32 * 2.5);
            if facing > 0.0 {
                run.push(p);
            } else if run.len() > 1 {
                sh = sh.stroke_with(std::mem::take(&mut run), false, 0.75, LineCap::Butt, ink.alpha(0.04));
            } else {
                run.clear();
            }
        }
        if run.len() > 1 {
            sh = sh.stroke_with(run, false, 0.75, LineCap::Butt, ink.alpha(0.04));
        }
    }
    // Land as fine dots, fading toward the edge.
    for &(lat, lon) in LAND.iter() {
        let (p, facing) = project(lat as f32 / 10.0, lon as f32 / 10.0);
        if facing > 0.03 {
            sh = sh.stroke_with(vec![p, [p[0] + 0.01, p[1]]], false, 1.9, LineCap::Round, ink.alpha(0.05 + 0.17 * facing));
        }
    }
    // Where people are now: a soft halo and a small core, sized by share of the busiest.
    let most = places.iter().map(|p| p.1).fold(1.0, f64::max);
    for (code, users) in places {
        let Some((lat, lon)) = centre(code) else { continue };
        let (p, facing) = project(lat, lon);
        if facing <= 0.08 {
            continue;
        }
        let k = (users / most).sqrt() as f32;
        let fade = facing.min(1.0);
        sh = disc(p[0], p[1], 5.0 + 11.0 * k, t.chart.primary.alpha(0.1 * fade), sh);
        sh = disc(p[0], p[1], 1.8 + 2.4 * k, t.chart.primary.alpha(0.85 * fade), sh);
    }
    canvas(sh.view_box(size, size)).size(size, size).a11y_hidden()
}
