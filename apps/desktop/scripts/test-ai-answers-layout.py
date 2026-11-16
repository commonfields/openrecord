#!/usr/bin/env python3
"""Verify native AI answer actions, list height, filtering and navigation offline."""
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
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-ai-answers-'))
    output.mkdir(parents=True, exist_ok=True)

    def render(name, size='1280x1000', events=None, scene='ai-answers'):
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events or []))
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--at', '2',
                            '--size', size, '--scale', '1', '--snap', str(output / (name + '.png')),
                            '--tree', str(output / (name + '.json'))], stdout=log, stderr=log, check=True)
        nodes = json.loads((output / (name + '.json')).read_text())['elements']
        assert not any('verdict' in n.get('text', '').lower() for n in nodes), 'Old verdict copy remains visible'
        return nodes, {n.get('key'): n for n in nodes}

    for name, size in [('default', '1280x1000'), ('tall', '1280x1400'), ('narrow', '820x1000')]:
        nodes, keys = render(name, size)
        root, panel = keys['page-ai-answers']['rect'], keys['issue-panel']['rect']
        assert abs(root[1] + root[3] - panel[1] - panel[3]) < 1, 'List card stops before the bottom of the page'
        assert keys['issue-list-scroll']['rect'][3] > 80, 'List has no scrollable space'
        actions = [n for n in nodes if n.get('key', '').startswith('issue-open-')]
        assert len(actions) == 4, 'An answer group lost its action'
        for action in actions:
            assert action['label'] == 'View answer', 'Action still has a count or arrow'
            assert abs(action['rect'][2] - 112 * action['scale']) < 1, 'Action widths differ'
            assert action['rect'][0] + action['rect'][2] <= panel[0] + panel[2] + 1, 'Action overflows the card'
            children = [n for n in nodes if n['path'].rsplit('/', 1)[0] == action['path']]
            assert len(children) == 1 and children[0].get('text') == 'View answer', 'Action still has an icon or count'
        assert keys['issue-start-review']['label'] == 'Start reviewing'
        print(name + ': equal actions and full-height list passed', flush=True)
    _, keys = render('filtered', events=[{'t': .2, 'key': 'issue-search'}, {'t': .4, 'paste': 'no matching answer'}])
    assert 'issues-none' in keys and 'issue-panel' in keys, 'Empty filter state missing'
    _, keys = render('every-answer', events=[{'t': .2, 'key': 'issue-view-answers'}])
    assert 'answer-i1' in keys, 'Every answer view is broken'
    _, keys = render('open-answer', events=[{'t': .2, 'key': 'issue-open-i4'}])
    assert 'answer-dialog' in keys and 'issue-panel' in keys, 'View answer did not open the popup over the list'
    render('review-copy', scene='ai-answer-review')
    print('7 native AI answer layout, filter, navigation and copy checks passed. Evidence: ' + str(output))


if __name__ == '__main__':
    main()
