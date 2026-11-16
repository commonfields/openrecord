#!/usr/bin/env python3
"""Check native inbox-stack motion and hover interactions without network calls."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path(__file__).resolve().parents[1] / 'target/debug/openrecord-desktop')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-notices-motion-'))
    output.mkdir(parents=True, exist_ok=True)
    front = 'notice-GROWTH_OPPORTUNITY:o1'
    enter = {'t': 1, 'type': 'move', 'key': front}
    leave = {'t': 2.2, 'type': 'move', 'x': 300, 'y': 100}

    def render(name, events, at=3, scene='campaigns', size='1280x900'):
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events))
        tree = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--at', str(at),
                            '--size', size, '--scale', '1', '--snap', str(output / (name + '.png')),
                            '--tree', str(tree)], stdout=log, stderr=log, check=True)
        return {n.get('key'): n for n in json.loads(tree.read_text())['elements']}

    frames = [render('frame-' + str(at), [enter, leave], at) for at in [.99, 1.02, 1.1, 1.25, 1.7, 2.22, 2.35, 2.9]]
    anchor = frames[0][front]['rect']
    assert frames[0]['notices-trigger']['focusable'] and not frames[0]['notices-trigger']['inert'], 'Collapsed notifications lost keyboard access'
    for frame in frames:
        assert max(abs(a - b) for a, b in zip(anchor, frame[front]['rect'])) < 1, 'Front notification jumps during hover'
    assert frames[4]['notices-head']['opacity'] > .99, 'Stack did not expand'
    assert frames[-1]['notices-head']['opacity'] < .01, 'Stack did not collapse'
    print('Opening and closing keep the front card anchored', flush=True)

    blank = render('blank-hover', [{'t': 1, 'type': 'move', 'key': 'notices-head'}])
    assert blank['notices-head']['opacity'] < .01, 'Invisible area above the collapsed stack intercepts hover'
    clicked = render('inbox-click', [enter, {'t': 1.6, 'key': front}])
    assert 'page-inbox' in clicked and 'notices' not in clicked, 'Notification does not open Inbox'
    reentered = render('reenter', [enter, leave, {'t': 2.5, 'type': 'move', 'key': front}])
    assert reentered['notices-head']['opacity'] > .99, 'Hover cannot reopen the stack'
    top = render('top-hover', [enter], scene='agent-empty', size='820x900')
    assert top['notices-head']['opacity'] > .99, 'Top-right stack cannot expand'
    print('Blank-area hover, Inbox click, re-entry and top-right placement passed', flush=True)
    print('Evidence: ' + str(output))


if __name__ == '__main__':
    main()
