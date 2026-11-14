//! The agent's thinking mark: a Rubik's cube in glossy black metal, tilted
//! toward the viewer and spinning about its vertical axis.
//!
//! Every face of an all-black cube looks alike, so a quarter turn loops
//! seamlessly. The quarter turn is drawn once as a flipbook of frames, each its
//! own canvas, and Rune's render clock shows one frame at a time (an opacity
//! cycle per frame, phased one slot apart). No view rebuilds while it spins.

use rune::{Color, Cycle, El, LineCap, LoopSpec, Shape, canvas, el};

use crate::theme::Theme;

/// Frames in a quarter turn, and how long a quarter turn takes.
const FRAMES: usize = 24;
const QUARTER: f32 = 1.4;
/// Each frame shows for its slot of the cycle, then hides (`Cycle::stops`).
const SLOT: [(f32, f32); 4] = [(0.0, 1.0), (1.0 / FRAMES as f32, 1.0), (1.0 / FRAMES as f32 + 0.0001, 0.0), (1.0, 0.0)];

type V = [f32; 3];

fn rotate(p: V, yaw: f32, pitch: f32) -> V {
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    // About the vertical axis, then tipped toward the viewer.
    let x = p[0] * cy + p[2] * sy;
    let z = -p[0] * sy + p[2] * cy;
    let y = p[1] * cp - z * sp;
    let z2 = p[1] * sp + z * cp;
    [x, y, z2]
}

fn dot(a: V, b: V) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: V) -> V {
    let l = dot(a, a).sqrt().max(1e-6);
    [a[0] / l, a[1] / l, a[2] / l]
}

fn mix(a: Color, b: Color, k: f32) -> Color {
    a.mix(b, k.clamp(0.0, 1.0))
}

/// One frame: the cube turned `yaw` radians, in a 100 by 100 view box.
fn frame(yaw: f32) -> Shape {
    let pitch = 0.5;
    let light = norm([-0.55, 0.75, 0.6]);
    let view = [0.0, 0.0, 1.0];
    let half = norm([light[0] + view[0], light[1] + view[1], light[2] + view[2]]);
    let scale = 30.0;
    let project = |p: V| [50.0 + p[0] * scale, 52.0 - p[1] * scale];
    // The six faces as (normal, right, up) in the cube's own frame.
    let faces: [(V, V, V); 6] = [
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    ];
    let body = Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
    let metal = Color { r: 0.003, g: 0.003, b: 0.0035, a: 1.0 };
    let shine = Color { r: 0.62, g: 0.64, b: 0.72, a: 1.0 };
    let mut visible: Vec<(f32, V, V, V)> = faces
        .iter()
        .map(|(n, r, u)| (rotate(*n, yaw, pitch), rotate(*r, yaw, pitch), rotate(*u, yaw, pitch)))
        .filter(|(n, _, _)| n[2] > 0.02)
        .map(|(n, r, u)| (n[2], n, r, u))
        .collect();
    visible.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut sh = Shape::new();
    for (_, n, r, u) in visible {
        let at = |a: f32, b: f32| -> V { [n[0] + r[0] * a + u[0] * b, n[1] + r[1] * a + u[1] * b, n[2] + r[2] * a + u[2] * b] };
        // The face itself, the dark plastic between the stickers.
        let corners = [at(-1.0, -1.0), at(1.0, -1.0), at(1.0, 1.0), at(-1.0, 1.0)];
        sh = sh.fill(corners.iter().map(|p| project(*p)).collect::<Vec<[f32; 2]>>(), body);
        let lambert = dot(n, light).max(0.0);
        // Nine stickers, inset, each lit by where it sits so the sheen sweeps across the face.
        for i in 0..3 {
            for j in 0..3 {
                let (a0, b0) = (-1.0 + i as f32 * 2.0 / 3.0, -1.0 + j as f32 * 2.0 / 3.0);
                let g = 0.07;
                let (a1, b1, a2, b2) = (a0 + g, b0 + g, a0 + 2.0 / 3.0 - g, b0 + 2.0 / 3.0 - g);
                let centre = at((a1 + a2) / 2.0, (b1 + b2) / 2.0);
                // A gently curved normal across the face fakes the reflection of a broad light.
                let bent = norm([n[0] + (centre[0] - n[0]) * 0.35, n[1] + (centre[1] - n[1]) * 0.35, n[2] + (centre[2] - n[2]) * 0.35]);
                let spec = dot(bent, half).max(0.0).powf(24.0);
                let ink = mix(mix(metal, Color { r: 0.03, g: 0.03, b: 0.034, a: 1.0 }, lambert), shine, spec * 0.8);
                let quad: Vec<[f32; 2]> = [at(a1, b1), at(a2, b1), at(a2, b2), at(a1, b2)].iter().map(|p| project(*p)).collect();
                sh = sh.fill(quad.clone(), ink);
                // A bright rim along the sticker's lit edge, as polished metal catches it.
                let rim = mix(Color { r: 0.08, g: 0.08, b: 0.09, a: 1.0 }, shine, spec).alpha(0.3 + 0.5 * lambert);
                sh = sh.stroke_with(vec![quad[3], quad[2]], false, 0.9, LineCap::Round, rim);
            }
        }
    }
    sh.view_box(100.0, 100.0)
}

/// The cube, `size` points square; it spins when `spinning`, and rests on its
/// first frame otherwise (or under Reduce Motion).
pub fn view(t: &Theme, key: &str, size: f32, spinning: bool) -> El {
    let _ = t;
    let mut stack = el().key(key.to_string()).size(size, size).a11y_hidden();
    if !spinning {
        return stack.child(canvas(frame(0.55)).size(size, size));
    }
    for k in 0..FRAMES {
        let yaw = 0.55 + std::f32::consts::FRAC_PI_2 * k as f32 / FRAMES as f32;
        let cycle = Cycle { period: QUARTER, phase: k as f32 / FRAMES as f32, stops: &SLOT, still: if k == 0 { 1.0 } else { 0.0 }, fps: 30.0 };
        // A flipbook: each frame steps in and out on purpose, as a film does.
        stack = stack.child(canvas(frame(yaw)).size(size, size).absolute(0.0, 0.0).key(format!("{key}-f{k}")).looping(LoopSpec::cycle(cycle)).motion_intent(rune::MotionIntent::STEP));
    }
    stack
}
