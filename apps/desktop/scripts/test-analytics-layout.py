#!/usr/bin/env python3
"""Replay native Analytics tabs and assert they fit the resizable right panel.

Build first with cargo build. Fixtures make no network or provider calls.
Use --out DIR to keep the screenshots, element trees and renderer logs.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def check_tree(path, section):
    tree = json.loads(path.read_text())
    nodes = tree['elements']
    panel = next(n for n in nodes if n.get('key') == 'side-panel')
    left, _, width, _ = panel['rect']
    right = left + width
    analytics = [n for n in nodes if '/side-analytics/' in n.get('path', '')]
    assert any(n.get('key') == 'overview-' + section for n in analytics), 'Selected section did not open in the panel'
    overflow = []
    for node in analytics:
        # Map pins pan inside the map's clipped viewport; their offscreen bounds are intentional.
        # The original funnel keeps its labels and graphic in a horizontal viewport.
        # Its content can extend past the panel; the viewport itself must still fit.
        if '/funnel-diagram-scroll/' in node.get('path', ''):
            continue
        if not node.get('key') or node['key'].startswith('map-pin-'):
            continue
        x, _, w, _ = node['rect']
        if x < left - 1 or x + w > right + 1:
            overflow.append((node['key'], round(x, 1), round(w, 1), round(right, 1)))
    assert not overflow, f'{path.name}: horizontal overflow {overflow[:12]}'
    if section == 'funnel':
        viewport = next(n for n in analytics if n.get('key') == 'funnel-diagram-scroll')
        diagram = next(n for n in analytics if n.get('key') == 'funnel-diagram')
        assert diagram['rect'][2] >= viewport['rect'][2] - 1, 'Funnel diagram was squeezed inside the viewport'
    metrics = [n for n in analytics if '-kpi-' in n.get('key', '')]
    assert all(n['rect'][2] >= min(80, width - 100) for n in metrics), 'Metric cards were squeezed beyond readability'
    # Every section must remain reachable, even when the tab track wraps.
    tabs = [n for n in analytics if n.get('key', '').startswith('section-') and n.get('role') == 'tab']
    assert len(tabs) == 7, 'Missing Analytics navigation tabs'
    return width


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    desktop = Path(__file__).resolve().parents[1]
    parser.add_argument('--binary', type=Path, default=desktop / 'target/debug/openrecord-desktop')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-analytics-layout-'))
    output.mkdir(parents=True, exist_ok=True)
    sections = ['summary', 'performance', 'revenue', 'funnel', 'events', 'realtime', 'answers']
    cases = [(section, size, None) for size in ['820x900', '1280x900'] for section in sections]
    cases += [('performance', '820x900', 'narrow-panel'), ('performance', '1000x900', 'narrow-panel'), ('funnel', '1000x900', 'expand')]
    for section, size, action in cases:
        name = section + '-' + size + ('-' + action if action else '')
        events = [
            {'t': 0.1, 'type': 'key', 'name': '1', 'cmd': True},
            {'t': 0.3, 'key': 'side-toggle'},
            {'t': 0.6, 'key': 'side-launch-analytics'},
            {'t': 0.9, 'key': 'section-' + section},
        ]
        if action == 'narrow-panel':
            events.append({'t': 1.1, 'type': 'drag', 'key': 'side-edge', 'dx': 160, 'dy': 0, 'dur': 0.2})
        elif action == 'expand':
            events.append({'t': 1.1, 'key': 'side-wide'})
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events))
        tree = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', 'overview', '--script', str(script), '--at', '2', '--size', size,
                            '--scale', '1', '--snap', str(output / (name + '.png')), '--tree', str(tree)],
                           stdout=log, stderr=log, check=True)
        width = check_tree(tree, section)
        print(f'{name}: fits panel width {width:.0f}', flush=True)
    print(f'{len(cases)} Analytics layout scenarios passed. Evidence: {output}')


if __name__ == '__main__':
    main()
