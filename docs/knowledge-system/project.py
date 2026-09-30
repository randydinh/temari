"""Rebuild only the documentation projection; no extraction, models or runtime state."""
from copy import deepcopy
from pathlib import Path
import json

from graphify.build import build_from_json
from graphify.export import to_json

ROOT = Path(__file__).resolve().parent
SOURCE_FILE = 'docs/knowledge-system/evidence.json'


def expected_projection(data):
    nodes = []
    points = {p['id']: p for p in data['points']}
    for kind, records in [('point', data['points']), ('decision', data['decisions']),
                          ('assertion', data['relationships'])]:
        for record in records:
            refs = record.get('source_refs', [])
            if kind == 'decision':
                refs = [ref for pid in record['point_ids'] for ref in points[pid]['source_refs']]
            refs = list({json.dumps(ref, sort_keys=True): ref for ref in refs}.values())
            title = record.get('label') or f"{record['source']} {record['type']} {record['target']}"
            node = deepcopy(record)
            node.update(label=f"{record['id']} | {title}", title=title,
                        record_kind=kind, file_type='concept', source_file=SOURCE_FILE,
                        source_refs=refs,
                        source_location='; '.join(f"{r['locator']} @ {r['revision']} :: {r['span']}" for r in refs))
            nodes.append(node)
    edges = []
    for assertion in data['relationships']:
        for source, target, relation in [(assertion['source'], assertion['id'], 'assertion_subject'),
                                         (assertion['id'], assertion['target'], 'assertion_object')]:
            edges.append(dict(source=source, target=target, relation=relation,
                              assertion_id=assertion['id'], confidence=assertion['confidence'],
                              source_file=SOURCE_FILE, weight=1.0))
    return dict(nodes=nodes, edges=edges)


def main():
    data = json.loads((ROOT / 'evidence.json').read_text())
    extraction = expected_projection(data)
    graph = build_from_json(deepcopy(extraction), directed=True)
    destination = ROOT / 'graphify-out' / 'graph.json'
    destination.parent.mkdir(exist_ok=True)
    if not to_json(graph, {}, str(destination), built_at_commit=data['baseline']):
        raise SystemExit('Graphify refused export; inspect before replacing any existing projection')
    print(json.dumps(dict(projected=True, directed=graph.is_directed(),
                          nodes=graph.number_of_nodes(), edges=graph.number_of_edges())))


if __name__ == '__main__':
    main()
