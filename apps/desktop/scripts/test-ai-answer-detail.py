#!/usr/bin/env python3
"""Check the AI answer popup offscreen: it sits over the list, header and footer frame the inset, and the correction field grows."""
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
    out = args.out or Path(tempfile.mkdtemp(prefix='openrecord-answer-popup-'))
    out.mkdir(parents=True, exist_ok=True)

    def render(name, scene='ai-answer-review', size='1280x900', events=None):
        script = out / (name + '.script.json')
        script.write_text(json.dumps(events or []))
        with (out / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--at', '2',
                            '--size', size, '--scale', '1', '--tree', str(out / (name + '.json')),
                            '--snap', str(out / (name + '.png'))], stdout=log, stderr=log, check=True)
        nodes = json.loads((out / (name + '.json')).read_text())['elements']
        return {n.get('key'): n for n in nodes}

    def inside(keys, key, box='answer-dialog'):
        d, r = keys[box]['rect'], keys[key]['rect']
        assert r[0] >= d[0] - 1 and r[0] + r[2] <= d[0] + d[2] + 1, key + ' leaves ' + box + ' sideways'
        assert r[1] >= d[1] - 1 and r[1] + r[3] <= d[1] + d[3] + 1, key + ' leaves ' + box

    for size in ['820x600', '1280x900', '1800x1000']:
        keys = render('layout-' + size, size=size)
        assert 'issue-panel' in keys, 'The AI answers list should stay behind the popup'
        assert keys['answer-dialog']['role'] == 'dialog'
        for key in ['answer-header', 'answer-inset', 'answer-review-footer', 'answer-close', 'verdict-record', 'verdict-cancel']:
            inside(keys, key)
        inset, head, foot = keys['answer-inset']['rect'], keys['answer-header']['rect'], keys['answer-review-footer']['rect']
        assert head[1] + head[3] <= inset[1] + 1, 'The header belongs above the inset'
        assert foot[1] >= inset[1] + inset[3] - 1, 'The footer belongs below the inset'
        inside(keys, 'verdict-options', 'answer-inset')
        assert keys['answer-dialog']['rect'][2] <= 800 * keys['answer-dialog']['scale'] + 1, 'Popup is wider than 800'

    text = 'The correct answer.\nAnother line with the facts we checked.\nOne more line.'
    events = [{'t': .2, 'key': 'verdict-notes'}, {'t': .4, 'paste': text},
              {'t': .6, 'type': 'key', 'name': 'Enter'}, {'t': .8, 'paste': 'After Enter.'}]
    keys = render('multiline', events=events)
    assert keys['verdict-notes']['text'] == text + '\nAfter Enter.', 'Enter did not add a line'
    assert 'answer-dialog' in keys, 'Typing closed or saved the popup'
    field, editor = keys['verdict-notes-field']['rect'], keys['verdict-notes']['rect']
    assert editor[1] + editor[3] <= field[1] + field[3] + 1, 'Correction text overflows its field'

    keys = render('rated', scene='ai-answer')
    assert keys['verdict-CONTRADICTED'].get('fill', '#00000000') != '#00000000' and keys['verdict-SUPPORTED'].get('fill', '#00000000') == '#00000000', 'A rated answer should open on its saved rating'
    assert 'source-0' in keys and 'source-1' in keys, 'Cited links are missing'

    keys = render('pick', events=[{'t': .2, 'key': 'verdict-CONTRADICTED'}])
    assert keys['verdict-CONTRADICTED'].get('fill', '#00000000') != '#00000000' and keys['verdict-SUPPORTED'].get('fill', '#00000000') == '#00000000', 'Picking a rating did not select it'

    keys = render('closed', scene='ai-answer', events=[{'t': .2, 'key': 'answer-close'}])
    assert 'answer-dialog' not in keys and 'issue-panel' in keys, 'Close did not return to the list'
    print('7 answer popup layout, inset, correction field, rating and close checks passed. Evidence: ' + str(out))


if __name__ == '__main__':
    main()
