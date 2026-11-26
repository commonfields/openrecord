#!/usr/bin/env python3
"""Verify native campaign documents and edit boundaries with offline fixtures."""
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
    output = args.out or Path(tempfile.mkdtemp(prefix='openrecord-campaign-document-'))
    output.mkdir(parents=True, exist_ok=True)

    def render(name, scene, events, size='1280x900'):
        script = output / (name + '.script.json')
        script.write_text(json.dumps(events))
        tree = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            subprocess.run([str(args.binary), '--scene', scene, '--script', str(script), '--at', '2.5',
                            '--size', size, '--scale', '1', '--snap', str(output / (name + '.png')),
                            '--tree', str(tree)], stdout=log, stderr=log, check=True)
        nodes = json.loads(tree.read_text())['elements']
        for node in nodes:
            key = node.get('key', '')
            if node.get('role') != 'button' or not key.startswith(('cp-', 'new-campaign', 'plan-campaign', 'campaigns-failed')):
                continue
            text = next((child for child in nodes if child.get('text') == node.get('label')
                         and child['path'].rsplit('/', 1)[0] == node['path']), None)
            if text:
                assert node['rect'][2] <= text['rect'][2] + 24 * node['scale'] + 1, (name, key, 'Campaign action button stretched beyond its label')
        return nodes, {n.get('key'): n for n in nodes}

    def document(nodes, keys):
        assert '/side-panel/' in keys['campaign-brief-editor']['path'], 'Editor replaced the main page'
        assert 'cp-edit-tab-0' not in keys, 'Old form navigation is still present'
        assert all(k in keys for k in ['cp-describe-box', 'cp-essentials', 'cp-deliverables', 'cp-more-detail']), 'Document lost a part of the brief'
        x, _, width, _ = keys['side-panel']['rect']
        for n in nodes:
            if '/campaign-document/' not in n.get('path', '') or not n.get('key'):
                continue
            left, _, w, _ = n['rect']
            assert left >= x - 1 and left + w <= x + width + 1, (n['key'], 'Document overflows panel')
        for key, n in keys.items():
            if key and key.startswith(('cp-edit-', 'cp-task-')) and key.endswith('-measure'):
                field = keys[key.removesuffix('-measure')]
                assert field['rect'][3] >= n['rect'][3] - 1, 'Editable paragraph is shorter than its wrapped content'

    for size in ['820x900', '1280x900']:
        nodes, keys = render('document-' + size, 'campaign-brief', [], size)
        document(nodes, keys)
        print(size + ': document fits panel', flush=True)
    nodes, keys = render('create', 'campaigns', [{'t': .2, 'key': 'new-campaign'}])
    document(nodes, keys)
    baseline_toolbar = keys['cp-document-toolbar']['rect']
    nodes, keys = render('edit', 'campaign', [{'t': .2, 'key': 'cp-edit'}])
    document(nodes, keys)
    assert keys['cp-edit-title']['text'] == 'Pricing guide launch', 'Existing brief content was lost'
    edits = [{'t': .2, 'key': 'new-campaign'}, {'t': .6, 'key': 'cp-edit-title'},
             {'t': .8, 'paste': 'Quarterly demand campaign'}, {'t': 1.1, 'key': 'side-tab-close-0'}]
    nodes, keys = render('dirty-close', 'campaigns', edits)
    assert keys['cp-edit-title']['text'] == 'Quarterly demand campaign', 'Closing discarded unsaved text'
    assert any('Save or discard' in n.get('text', '') for n in nodes), 'Unsaved close did not explain next action'
    _, keys = render('discard', 'campaigns', edits + [{'t': 1.6, 'key': 'cp-edit-discard'}])
    assert 'campaign-brief-editor' not in keys and 'side-panel' not in keys, 'Discard did not close document'
    nodes, _ = render('validation', 'campaigns', [{'t': .2, 'key': 'new-campaign'}, {'t': .7, 'key': 'cp-edit-save'}])
    assert any('Give this campaign a name' in n.get('text', '') for n in nodes), 'Unnamed brief bypassed validation'
    _, keys = render('scroll', 'campaign-brief', [{'t': .2, 'key': 'brief-more'},
                      {'t': .8, 'type': 'scroll', 'key': 'campaign-document-scroll', 'dy': -1600, 'dur': .3}])
    assert abs(keys['cp-document-toolbar']['rect'][1] - baseline_toolbar[1]) < 1, 'Save toolbar scrolls away'
    assert keys['cp-edit-title']['rect'][1] < baseline_toolbar[1], 'Document did not scroll'
    # Folded detail keeps every other field one press away.
    _, keys = render('more', 'campaign-brief', [{'t': .3, 'key': 'brief-more'}], '1280x1400')
    assert all('cp-edit-' + k in keys for k in ['hypothesis', 'trackingPlan', 'budget', 'nextMove']), 'More detail is missing fields'
    _, keys = render('task-cycle', 'campaign-brief', [{'t': .3, 'key': 'cp-task-1-status'}, {'t': .6, 'key': 'cp-task-1-channel'}, {'t': .9, 'key': 'brief-add-task'}], '1280x1300')
    assert keys['cp-task-1-status']['label'].startswith('In progress') and keys['cp-task-1-channel']['label'].startswith('Social'), 'Deliverable state or channel did not change'
    assert 'cp-edit-task-2' in keys, 'Add deliverable did not add a row'
    _, keys = render('fill-empty', 'campaign-brief', [])
    assert not keys['brief-fill']['focusable'] and keys['brief-fill']['opacity'] < 1, 'Fill offered without a description'
    _, keys = render('detail', 'campaign', [])
    for i in range(6):
        assert keys['cp-phase-action-' + str(i)]['rect'][2] < keys['cp-phase-' + str(i)]['rect'][2] - 40, 'Work-loop button is stretched'
    print('Create, edit, unsaved close, discard, validation, sticky toolbar and compact actions passed', flush=True)
    print('Evidence: ' + str(output))


if __name__ == '__main__':
    main()
