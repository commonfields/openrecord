#!/usr/bin/env python3
"""Check native Inbox insets, clean rows, resizing and selection with offline fixtures."""
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
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-inbox-layout-'))
    output.mkdir(parents=True, exist_ok=True)

    def render(name, events=None, size='1280x900', scene='inbox'):
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events or []))
        tree = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--at', '2',
                            '--size', size, '--scale', '1', '--snap', str(output / (name + '.png')),
                            '--tree', str(tree)], stdout=log, stderr=log, check=True)
        nodes = json.loads(tree.read_text())['elements']
        keys = {n.get('key'): n for n in nodes}
        root = keys['inbox']['rect']
        sidebar = keys['inbox-list']['rect']
        detail = next(n['rect'] for n in nodes if n.get('key', '').startswith('decision-detail-'))
        scale = keys['inbox']['scale']
        left = sidebar[0] - root[0]
        right = root[0] + root[2] - detail[0] - detail[2]
        bottom = root[1] + root[3] - detail[1] - detail[3]
        assert max(abs(left - 12 * scale), abs(right - left), abs(bottom - left)) < 1, 'Inbox outer insets differ'
        assert abs(sidebar[1] - root[1]) < 1, 'Inbox top inset is too wide'
        if 'inbox-edge' in keys:
            assert abs(detail[1] - sidebar[1]) < 1, 'Inbox panes have different top insets'
        for n in nodes:
            if n.get('role') != 'button' or '/decision-list/' not in n.get('path', ''):
                continue
            texts = [c['text'] for c in nodes if c.get('text') and c['path'].startswith(n['path'] + '/')]
            assert len(texts) == 2 and texts[1] == n['label'], 'Inbox row is not business and subject only'
            assert ' · ' not in texts[0], 'Inbox row still has dot-separated metadata'
        if 'inbox-edge' in keys:
            assert abs(detail[0] - sidebar[0] - sidebar[2] - 6 * scale) < 1, 'Inbox list/content gap is too wide'
            assert detail[2] >= 280 * scale, 'Resizing squeezed the message content'
        else:
            assert detail[1] > sidebar[1] + sidebar[3], 'Narrow Inbox did not stack cleanly'
        assert not any(n.get('text', '').endswith(' waiting') for n in nodes if '/inbox-list/' in n.get('path', '')), 'Waiting count remains'
        document = keys['decision-document']['rect']
        assert document[2] <= 840 * scale + 1, 'Message paragraphs are too wide'
        assert keys['decision-paragraphs']['fill'] == '#00000000', 'Message still has a nested card'
        for n in nodes:
            # A diagram wider than the pane scrolls sideways inside it, so its labels may sit past the edge.
            if n.get('role') == 'text' and '/decision-document/' in n.get('path', '') and '/diagram/' not in n['path']:
                assert n['rect'][0] >= detail[0] - 1 and n['rect'][0] + n['rect'][2] <= detail[0] + detail[2] + 1, 'Message text overflows content pane'
        head, foot, scroll = keys['decision-header']['rect'], keys['decision-footer']['rect'], keys['decision-scroll']['rect']
        assert head[1] + head[3] <= scroll[1] + 1 and foot[1] >= scroll[1] + scroll[3] - 1, 'Sender line and actions should frame the scrolling message'
        assert foot[1] + foot[3] <= detail[1] + detail[3] + 1, 'Actions leave the message pane'
        return keys, sidebar[2]

    keys, baseline = render('default')
    texts = [n.get('text', '') for n in json.loads((output / 'default.json').read_text())['elements']]
    assert 'Claude Sonnet 5.5' in texts, 'The sender model is missing from the message header'
    assert any(t.startswith('In \u201cNext step for the pricing page') for t in texts), 'The chat the message came from is missing'
    assert any(k and k.startswith('decision-message-surface-') for k in keys), 'The generated view is missing from the message'
    assert 'decision-chat' in keys and 'approve' in keys and 'decline' in keys
    assert keys['inbox-read-GROWTH_OPPORTUNITY:o1']['label'] == 'Read', 'Visible message not marked read'
    assert keys['inbox-read-WORDPRESS_CHANGE:w1']['label'] == 'Unread', 'Unopened message already read'
    assert abs(baseline - 320 * keys['inbox']['scale']) < 1, 'Inbox did not use its wider default'
    render('narrow', size='820x900')
    render('stacked', size='640x900')
    drag = {'t': .3, 'type': 'drag', 'key': 'inbox-edge', 'dx': 100, 'dy': 0, 'dur': .3}
    _, widened = render('widen', [drag])
    assert abs(widened - baseline - 100) < 2, 'Inbox drag did not follow the pointer'
    keys, minimum = render('minimum', [{**drag, 'dx': -1000}])
    assert abs(minimum - 240 * keys['inbox']['scale']) < 1, 'Inbox minimum width failed'
    keys, maximum = render('maximum', [{**drag, 'dx': 1000}])
    assert abs(maximum - 520 * keys['inbox']['scale']) < 1, 'Inbox maximum width failed'
    _, reset = render('reset', [drag, {'t': 1, 'type': 'double-click', 'key': 'inbox-edge'}])
    assert abs(reset - baseline) < 1, 'Inbox double-click did not reset its width'
    keys, nudged = render('keyboard', [{'t': .3, 'key': 'inbox-edge'}, {'t': .7, 'type': 'key', 'name': 'Right'}])
    assert abs(nudged - baseline - 16 * keys['inbox']['scale']) < 1, 'Keyboard resize failed'
    keys, _ = render('selection', [{'t': .3, 'key': 'decision-WORDPRESS_CHANGE:w1'}])
    assert 'decision-detail-WORDPRESS_CHANGE:w1' in keys, 'Selected message did not open'
    assert keys['inbox-read-WORDPRESS_CHANGE:w1']['label'] == 'Read', 'Opening message did not mark it read'
    assert keys['inbox-read-GROWTH_OPPORTUNITY:o1']['label'] == 'Read', 'Previous message lost read state'
    keys, _ = render('measurement', scene='inbox-check')
    assert 'model-picker' in keys, 'Measurement model picker missing'
    keys, _ = render('decline', [{'t': .3, 'key': 'decline'}])
    assert 'decline-reason' in keys and 'decline-confirm' in keys, 'Decline flow lost'
    keys, _ = render('decline-cancel', [{'t': .3, 'key': 'decline'}, {'t': .7, 'key': 'decline-cancel'}])
    assert 'approve' in keys and 'decline-reason' not in keys, 'Cancel decline did not restore actions'
    print('12 Inbox layout, resize, keyboard, reset and selection scenarios passed. Evidence: ' + str(output))


if __name__ == '__main__':
    main()
