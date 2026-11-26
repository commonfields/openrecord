#!/usr/bin/env python3
"""Check the native Inbox's card, rows, steps and actions with offline fixtures."""
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
        column = keys['inbox-column']['rect']
        root = keys['inbox']['rect']
        scale = keys['inbox']['scale']
        detail = next(n['rect'] for n in nodes if n.get('key', '').startswith('decision-detail-'))
        assert abs(detail[2] - column[2]) < 1 and column[2] <= 720 * scale + 1, 'The card does not fill the column'
        assert abs((column[0] - root[0]) - (root[0] + root[2] - column[0] - column[2])) < 2, 'The column is off centre'
        for n in nodes:
            # A diagram wider than the card scrolls sideways inside it, so its labels may sit past the edge.
            if n.get('role') == 'text' and '/inbox-column/' in n.get('path', '') and '/diagram/' not in n['path']:
                assert n['rect'][0] >= column[0] - 1 and n['rect'][0] + n['rect'][2] <= column[0] + column[2] + 1, 'Text overflows the column: ' + n.get('text', '')
        assert not any('·' in n.get('text', '') for n in nodes if '/inbox/' in n.get('path', '')), 'Dot separator in the Inbox'
        return keys, nodes

    def key(name):
        return [{'t': .3, 'type': 'key', 'name': name}]

    keys, nodes = render('default')
    texts = [n.get('text', '') for n in nodes]
    assert 'Claude Sonnet 5.5' in texts, 'The sender model is missing'
    assert any(t.startswith('In “Next step for the pricing page') for t in texts), 'The chat it came from is missing'
    assert {'decision-chat', 'approve', 'decline', 'later', 'decision-numbers'} <= set(keys)
    assert keys['inbox-read-GROWTH_OPPORTUNITY:o1']['label'] == 'Read', 'Visible decision not marked read'
    assert keys['inbox-read-WORDPRESS_CHANGE:w1']['label'] == 'Unread', 'Unopened decision already read'
    short = keys['decision-detail-GROWTH_OPPORTUNITY:o1']['rect']
    keys, _ = render('long', scene='inbox-long')
    assert abs(keys['decision-detail-GROWTH_OPPORTUNITY:o1']['rect'][3] - short[3]) < 1, 'A long decision changed the card size'
    assert keys['approve']['rect'][1] + keys['approve']['rect'][3] <= short[1] + short[3], 'The actions left the card'
    render('narrow', size='820x900')
    render('phone', size='640x900')
    keys, _ = render('message', [{'t': .3, 'key': 'decision-message-toggle'}], size='1280x1200')
    assert any(k and k.startswith('decision-message-surface-') for k in keys), 'The generated view is missing from the message'
    tall = '1280x1800'
    keys, _ = render('selection', [{'t': .3, 'key': 'decision-WORDPRESS_CHANGE:w1'}], size=tall)
    assert 'decision-detail-WORDPRESS_CHANGE:w1' in keys, 'Selected decision did not open'
    assert keys['inbox-read-WORDPRESS_CHANGE:w1']['label'] == 'Read', 'Opening did not mark it read'
    keys, _ = render('later', [{'t': .3, 'key': 'later'}], size=tall)
    assert 'decision-detail-WORDPRESS_CHANGE:w1' in keys, 'Later did not open the next decision'
    keys, nodes = render('work', [{'t': .3, 'key': 'work-1'}], size=tall)
    assert 'You approved it' in [n.get('text') for n in nodes], 'Approved work did not fold open'
    keys, _ = render('measurement', scene='inbox-check')
    assert 'model-picker' in keys, 'Measurement model picker missing'
    keys, _ = render('decline', [{'t': .3, 'key': 'decline'}], size=tall)
    assert 'decline-reason' in keys and 'decline-confirm' in keys, 'Decline flow lost'
    keys, _ = render('decline-cancel', [{'t': .3, 'key': 'decline'}, {'t': .7, 'key': 'decline-cancel'}], size=tall)
    assert 'approve' in keys and 'decline-reason' not in keys, 'Cancel decline did not restore actions'
    keys, _ = render('key-down', key('Down'))
    assert 'decision-detail-WORDPRESS_CHANGE:w1' in keys, 'Down did not open the next decision'
    print('12 Inbox layout, selection, steps and action scenarios passed. Evidence: ' + str(output))


if __name__ == '__main__':
    main()
