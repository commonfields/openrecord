#!/usr/bin/env python3
"""Replay page-to-chat actions in the native renderer without sending a message."""
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
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-agent-page-'))
    output.mkdir(parents=True, exist_ok=True)
    cases = [('overview-agent', size, 'overview', False) for size in ['820x900', '1280x900']]
    cases += [('campaigns', size, 'campaigns', False) for size in ['820x900', '1280x900']]
    cases += [('campaigns', '1280x900', 'campaigns', True), ('campaign', '1280x900', 'campaigns', False)]
    for scene, size, page, close in cases:
        name = ('campaign-detail' if scene == 'campaign' else page) + '-' + size + ('-close' if close else '')
        events = [{'t': .2, 'key': 'cp-review' if scene == 'campaign' else 'plan-campaign'}] if page == 'campaigns' else []
        if page == 'overview':
            events.append({'t': .4, 'key': 'section-revenue'})
        if close:
            events.append({'t': .6, 'key': 'side-tab-close-1'})
            events.append({'t': .9, 'key': 'side-tab-close-0'})
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events))
        tree = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--chrome', '--at', '2', '--size', size, '--scale', '1', '--snap', str(output / (name + '.png')), '--tree', str(tree)], stdout=log, stderr=log, check=True)
        nodes = json.loads(tree.read_text())['elements']
        keys = {n.get('key') for n in nodes}
        assert 'starters' not in keys, 'Home animation rendered in a task session'
        assert 'agent-pane' not in keys and 'pane-full' not in keys, 'Legacy left agent pane rendered'
        agent = next(n for n in nodes if n.get('key') == 'agent')
        assert '/panel/header/' not in agent['path'] and '/panel/' in agent['path'], 'Chat is outside the main panel'
        assert 'composer-input' in keys, 'Main chat composer missing'
        assert any(n.get('key') == 'send' for n in nodes), 'Prepared request was lost before the next frame'
        # Campaigns in the right panel carries the same chat under it (#205).
        assert scene != 'overview-agent' or 'side-composer-input' not in keys, 'A second composer rendered'
        if close:
            assert 'side-panel' not in keys, 'Closing the source tab did not fold the panel'
        else:
            assert 'side-panel' in keys and 'side-tab-0' in keys, 'Source page tab missing'
            if scene == 'campaigns':
                document = next(n for n in nodes if n.get('key') == 'campaign-brief-editor')
                assert '/side-panel/' in document['path'], 'Campaign brief is not in the right panel'
                assert 'side-tab-1' in keys and 'cp-edit-title' in keys, 'Brief document tab missing'
            else:
                source = next(n for n in nodes if n.get('key') == ('side-analytics' if page == 'overview' else 'page-' + page))
                assert '/side-panel/' in source['path'], 'Source page is not in the right panel'
                assert ('revenue-hero' in keys) if page == 'overview' else ('cp-back' in keys)
        print(name + ': main chat with source page tab verified', flush=True)
    print('6 native page-to-chat scenarios passed. Evidence: ' + str(output))


if __name__ == '__main__':
    main()
