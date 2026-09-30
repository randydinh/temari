"""Readback integrity and bounded navigation check for the design artifacts only."""
from pathlib import Path
import hashlib
import json
import re

from graphify.build import build_from_json
from project import expected_projection

ROOT = Path(__file__).resolve().parent


def unique(records):
    result = {row['id']: row for row in records}
    assert len(result) == len(records), 'duplicate identity'
    return result


def main():
    evidence_bytes = (ROOT / 'evidence.json').read_bytes()
    data = json.loads(evidence_bytes)
    sources, points, decisions, assertions = [unique(data[k]) for k in
                                              ('sources', 'points', 'decisions', 'relationships')]
    assert len(sources) >= 8 and len(points) >= 12 and len(decisions) >= 4 and len(assertions) >= 8
    assert len(set(points) | set(decisions) | set(assertions)) == len(points) + len(decisions) + len(assertions)
    for source in sources.values():
        assert all(source.get(k) for k in ('locator', 'revision', 'reading_status', 'intended_influence'))
    for point in points.values():
        assert all(point.get(k) for k in ('label', 'topic', 'source_refs', 'evidence_type', 'conditions',
                                         'confidence_basis', 'limits', 'benefit', 'risk', 'status', 'tags'))
    for record in [*points.values(), *assertions.values()]:
        for ref in record['source_refs']:
            source = sources[ref['source_id']]
            assert ref['locator'] == source['locator'] and ref['revision'] == source['revision']
            assert ref['span']
    for decision in decisions.values():
        assert decision['label'] and decision['rationale'] and decision['status']
        assert decision['point_ids'] and set(decision['point_ids']) <= points.keys()
    for assertion in assertions.values():
        assert assertion['source'] in points.keys() | decisions.keys()
        assert assertion['target'] in points.keys() | decisions.keys()
        assert assertion['type'] and assertion['basis']
        assert assertion['confidence'] in ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')
    expected = expected_projection(data)
    graph_bytes = (ROOT / 'graphify-out' / 'graph.json').read_bytes()
    raw = json.loads(graph_bytes)
    assert raw['directed'] is True and not raw.get('multigraph', False)
    actual_nodes = unique(raw['nodes'])
    expected_nodes = unique(expected['nodes'])
    assert actual_nodes.keys() == expected_nodes.keys(), 'identity mismatch'
    for nid, node in expected_nodes.items():
        for key, value in node.items():
            assert actual_nodes[nid].get(key) == value, (nid, key, 'attribute changed')
    links = raw.get('links', raw.get('edges', []))
    actual_edges = {(e['source'], e['target']): e for e in links}
    expected_edges = {(e['source'], e['target']): e for e in expected['edges']}
    assert len(actual_edges) == len(links) == len(expected_edges)
    assert actual_edges.keys() == expected_edges.keys(), 'topology mismatch'
    for pair, edge in expected_edges.items():
        for key, value in edge.items():
            assert actual_edges[pair].get(key) == value, (pair, key, 'connector changed')
    # Deserialize exported data through the actual API again, not a hand-written graph.
    graph = build_from_json(dict(nodes=raw['nodes'], edges=links), directed=True)
    assert set(graph.nodes) == set(expected_nodes)
    assert set(graph.edges) == set(expected_edges)
    for nid in expected_nodes:
        for key, value in expected_nodes[nid].items():
            if key != 'id':
                assert graph.nodes[nid].get(key) == value, (nid, key, 'readback changed')
    # Regression witness: same source/target with different assertion IDs must survive.
    parallel = [a for a in assertions.values() if a['source'] == 'P-graphify' and a['target'] == 'D-projection']
    assert len(parallel) == 2 and len({a['id'] for a in parallel}) == 2
    assert all(graph.has_edge('P-graphify', a['id']) and graph.has_edge(a['id'], 'D-projection') for a in parallel)
    # Representative query expands only to words present in labels. Keep evidence
    # navigation read-only: results do not become new graph facts or usage weights.
    vocabulary = {w.lower() for n in raw['nodes'] for w in re.findall(r'[A-Za-z]{3,}', n['label'])}
    terms = ['jev', 'skillopt', 'gate']
    assert set(terms) <= vocabulary
    starts = ['P-jev', 'P-skill-gate', 'P-model-fork']
    visited = set(starts)
    frontier = set(starts)
    for _ in range(2):
        frontier = {v for u in frontier for v in graph.successors(u)} - visited
        visited |= frontier
    assert {'D-models', 'D-evolution', 'P-skill-platform'} <= visited
    result = dict(question='Why can Jev not replace SkillOpt editing, and what gates are required?',
                  expanded_terms=terms, method='directed successor BFS; explicit topic seed IDs; depth 2',
                  seeds=starts, nodes=sorted(visited),
                  edges=sorted([list(e) for e in graph.edges if e[0] in visited and e[1] in visited]),
                  answer='Jev supplies typed judgments but cannot generate skill prose. SkillOpt needs a generative optimizer, real tool replay and a stronger held-out gate. The only-Jev scope remains open.',
                  citation_points=['P-jev', 'P-skill-gate', 'P-model-fork'],
                  limits='Scoped design navigation only; no semantic validation, model call or runtime evaluation.')
    report = dict(verified=True, sources=len(sources), points=len(points), decisions=len(decisions),
                  relationships=len(assertions), graph_nodes=len(actual_nodes), graph_edges=len(links),
                  exact_attributes=True, exact_topology=True, repeated_endpoints=True,
                  evidence_sha256=hashlib.sha256(evidence_bytes).hexdigest(),
                  graph_sha256=hashlib.sha256(graph_bytes).hexdigest(), query=result)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
