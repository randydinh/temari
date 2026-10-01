"""Explicit local provider adapters with source/version receipts and invalidated cache."""
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

from knowledge_agent.knowledge import _hash
from knowledge_agent.knowledge_cache import ArtifactCache, canonical
from knowledge_agent.knowledge_projection import generation_to_dict

WORKER = Path(__file__).with_name('provider_worker.py')


def invoke(config, request):
    raw = canonical(request)
    if len(raw) > 16777216:
        raise ValueError('provider-input-budget')
    try:
        result = subprocess.run([config['python'],'-I',str(WORKER)],input=raw,capture_output=True,timeout=30,
            env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'})
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise ValueError('provider-unavailable') from exc
    if result.returncode or len(result.stdout) > 1048576:
        raise ValueError('provider-failed-or-output-budget')
    try:
        value = json.loads(result.stdout)
    except (ValueError,UnicodeError) as exc:
        raise ValueError('provider-invalid-response') from exc
    if not isinstance(value,dict):
        raise ValueError('provider-invalid-response')
    return value


def _validate(config):
    if (not isinstance(config,dict) or set(config) != {'python','versions'}
            or not isinstance(config['python'],str) or not Path(config['python']).is_absolute()
            or not isinstance(config['versions'],dict) or set(config['versions']) != {'numpy','graphifyy'}
            or any(not isinstance(v,str) or not v for v in config['versions'].values())):
        raise ValueError('provider config requires an absolute Python and explicit numpy/graphifyy versions')


def configuration(registry):
    path = registry.workspace/'retrieval-provider.json'
    if path.is_symlink():
        raise ValueError('provider configuration symlinks are not admitted')
    if not path.exists():
        return None,None
    if path.stat().st_size > 8192:
        raise ValueError('provider configuration too large')
    raw = path.read_bytes()
    config = json.loads(raw)
    _validate(config)
    return config,_hash(raw)


def configure(registry, config):
    _validate(config)
    observed = invoke(config,dict(operation='probe'))
    if observed.get('versions') != config['versions']:
        raise ValueError('provider-version-mismatch')
    with registry._writer():
        configuration(registry)
        raw = canonical(config)
        fd,temporary = tempfile.mkstemp(dir=registry.workspace,prefix='.provider-')
        try:
            with os.fdopen(fd,'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary,registry.workspace/'retrieval-provider.json')
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return dict(status='complete',versions=observed['versions'],config_sha256=_hash(raw),
                default='exact',profiles=['semantic','relationship'])


def project_knowledge(registry, generation_id):
    """Build one immutable Registrar generation and verify every decoded record."""
    generation = registry.knowledge_generation(generation_id)
    config, config_hash = configuration(registry)
    if config is None:
        raise ValueError('provider-not-configured')
    if invoke(config, dict(operation='probe')).get('versions') != config['versions']:
        raise ValueError('provider-version-mismatch')
    response = invoke(config, dict(operation='project-knowledge', generation=generation_to_dict(generation)))
    if (response.get('versions') != config['versions'] or response.get('generation_id') != generation.id
            or response.get('native_graphify') is not True or not isinstance(response.get('records'), dict)
            or not isinstance(response.get('connector_edges'), list)):
        raise ValueError('provider-invalid-projection')
    expected = {}
    for row in generation.concepts:
        expected[row.id] = dict(registrar_kind='concept',registrar_id=row.id,
            projection_generation_id=generation.id,source_id=row.anchor.source_id,
            path=row.anchor.path,source_file=f'{row.anchor.source_id}/{row.anchor.path}',
            source_sha256=row.anchor.source_sha256,text_start=row.anchor.text_start,
            text_end=row.anchor.text_end,line_start=row.anchor.line_start,line_end=row.anchor.line_end,
            extractor_revision=generation.extractor_revision,provenance_class=row.provenance.value,
            title=row.title,concept_type=row.concept_type)
    for row in generation.relationships:
        expected[row.id] = dict(registrar_kind='relationship',registrar_id=row.id,
            projection_generation_id=generation.id,source_id=row.anchor.source_id,
            path=row.anchor.path,source_file=f'{row.anchor.source_id}/{row.anchor.path}',
            source_sha256=row.anchor.source_sha256,text_start=row.anchor.text_start,
            text_end=row.anchor.text_end,line_start=row.anchor.line_start,line_end=row.anchor.line_end,
            extractor_revision=generation.extractor_revision,provenance_class=row.provenance.value,
            relationship_type=row.relationship_type,subject_id=row.subject_id,object_id=row.object_id)
    expected_edges = sorted(
        (row.id, 'registrar_subject', generation.id, row.subject_id, row.id) for row in generation.relationships)
    expected_edges += sorted(
        (row.id, 'registrar_object', generation.id, row.id, row.object_id) for row in generation.relationships)
    expected_edges.sort()
    actual_edges = sorted((row.get('relationship_id'),row.get('role'),row.get('generation_id'),
                           row.get('source_record_id'),row.get('target_record_id'))
                          for row in response['connector_edges'])
    if response['records'] != expected or actual_edges != expected_edges:
        raise ValueError('provider-projection-evidence-mismatch')
    if configuration(registry) != (config, config_hash):
        raise ValueError('provider-changed-during-projection')
    return response


def rank(registry, documents, query, mode, snapshot):
    from knowledge_agent.evidence import policy_state
    from knowledge_agent.source_registry import _tokens
    config, config_hash = configuration(registry)
    if config is None:
        return [],dict(reason='provider-not-configured'),None
    if len(documents) > 500:
        return [],dict(reason='provider-corpus-limit-500-documents'),None
    mapping = {_hash(canonical(list(key))):doc for key,doc in documents.items()}
    inverse = {(d['source_id'],d['path']):identity for identity,d in mapping.items()}
    policy, policy_hash = policy_state(registry)
    edges, excluded_edges, stale_policies = [],0,0
    for row in policy['documents']:
        key = (row['source_id'],row['path'])
        if key not in inverse:
            continue
        if row['sha256'] != documents[key]['sha256']:
            stale_policies += 1
            continue
        for target in row.get('requires',[]):
            other = (target['source_id'],target['path'])
            if other in inverse:
                edges.append([inverse[key],inverse[other]])
            else:
                excluded_edges += 1
    request = dict(operation='rank',mode=mode,query=query,snapshot=snapshot,
        documents=[dict(id=identity,text=doc.get('text',' '.join(b for b,_ in doc['chunks'])) + '\n' + doc['path'])
                   for identity,doc in sorted(mapping.items())],edges=edges,
        seeds=sorted(identity for identity,doc in mapping.items() if _tokens(query) & doc['words']))
    key = dict(source_snapshot=snapshot,config_sha256=config_hash,versions=config['versions'],
        worker_sha256=_hash(WORKER.read_bytes()),request_sha256=_hash(canonical(request)),policy_sha256=policy_hash)
    def validate(value):
        if (not isinstance(value,dict) or value.get('snapshot') != snapshot or value.get('mode') != mode
                or value.get('versions') != config['versions'] or not isinstance(value.get('hits'),list)
                or len(value['hits']) > len(mapping)):
            raise ValueError('provider-invalid-response')
        seen = set()
        for hit in value['hits']:
            if (not isinstance(hit,dict) or hit.get('id') not in mapping or hit['id'] in seen
                    or type(hit.get('score')) not in (int,float) or not math.isfinite(hit['score'])
                    or not isinstance(hit.get('via'),list) or any(node not in mapping for node in hit['via'])):
                raise ValueError('provider-invalid-response')
            seen.add(hit['id'])
            if mode == 'relationship' and (not hit['via'] or hit['via'][0] not in request['seeds']
                    or hit['via'][-1] != hit['id'] or len(hit['via']) > 4
                    or any([a,b] not in edges for a,b in zip(hit['via'],hit['via'][1:]))):
                raise ValueError('provider-invalid-relationship')
    cache = ArtifactCache(registry.workspace,'cache')
    try:
        # Probe even on a cache hit: installed provider changes cannot reuse old results.
        if invoke(config,dict(operation='probe')).get('versions') != config['versions']:
            raise ValueError('provider-version-mismatch')
        value = cache.get('retrieval-provider',key,validate)
        reused = value is not None
        if value is None:
            value = invoke(config,request)
            validate(value)
            cache.put('retrieval-provider',key,value)
        if configuration(registry)[1] != config_hash or _hash(WORKER.read_bytes()) != key['worker_sha256']:
            raise ValueError('provider-changed-during-lookup')
    except ValueError as exc:
        return [],dict(reason=str(exc)),key
    hits = []
    for hit in value['hits']:
        doc = mapping[hit['id']]
        hits.append(dict(source_id=doc['source_id'],path=doc['path'],score=hit['score'],
            via=[dict(source_id=mapping[node]['source_id'],path=mapping[node]['path'],sha256=mapping[node]['sha256']) for node in hit['via']]))
    receipt = dict(key,cache_reused=reused,diagnostics=value.get('diagnostics',{}),excluded_dependencies=excluded_edges,
        stale_policies=stale_policies)
    gap = dict(reason='provider-dependencies-incomplete',count=excluded_edges+stale_policies) if excluded_edges or stale_policies else None
    return hits,gap,receipt
