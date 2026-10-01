"""Optional local NumPy LSA / Graphify worker, run by an explicitly configured Python.

No downloads, network calls, source traversal or writes. Input is a bounded, already
authorized document projection. Output is discovery evidence, never an answer.
"""
import importlib.metadata
import json
import math
import re
import sys


def terms(text):
    stop = {'the','a','an','is','are','of','and','or','to','in','from','what','how','can','do','does','with','for'}
    result = []
    for word in re.findall(r'[^\W_]+',text.casefold()):
        if word in stop:
            continue
        if word.endswith('ies') and len(word) > 4:
            word = word[:-3] + 'y'
        elif word.endswith(('sses','ches','shes','xes','zes')):
            word = word[:-2]
        elif word.endswith('s') and not word.endswith(('ss','us','is')) and len(word) > 3:
            word = word[:-1]
        result.append(word)
    return result


def run(request):
    versions = {name:importlib.metadata.version(name) for name in ('numpy','graphifyy')}
    if request['operation'] == 'probe':
        return dict(versions=versions)
    if request['operation'] == 'project-knowledge':
        return project_knowledge(request['generation'], versions)
    documents = request['documents']
    if len(documents) > 500:
        raise ValueError('provider corpus limit: at most 500 documents')
    mode = request['mode']
    hits, diagnostics = [], {}
    if mode == 'semantic':
        import numpy as np
        token_rows = [terms(d['text']) for d in documents]
        vocabulary = sorted(set(word for row in token_rows for word in row))
        if len(vocabulary) > 5000:
            raise ValueError('provider vocabulary limit: at most 5000 terms')
        index = {word:i for i,word in enumerate(vocabulary)}
        matrix = np.zeros((len(documents),len(vocabulary)), dtype=float)
        for i,row in enumerate(token_rows):
            for word in row:
                matrix[i,index[word]] += 1
        if matrix.size:
            idf = np.log((1 + len(documents))/(1 + np.count_nonzero(matrix,axis=0))) + 1
            matrix = np.log1p(matrix) * idf
            matrix /= np.maximum(np.linalg.norm(matrix,axis=1,keepdims=True),1e-12)
            query = np.zeros(len(vocabulary))
            for word in terms(request['query']):
                if word in index:
                    query[index[word]] += 1
            query = np.log1p(query) * idf
            diagnostics['out_of_vocabulary'] = sorted(set(terms(request['query'])) - set(vocabulary))
            if np.linalg.norm(query):
                u,s,vt = np.linalg.svd(matrix,full_matrices=False)
                rank = min(8,len(s))
                projected = matrix @ vt[:rank].T
                q = query @ vt[:rank].T
                scores = projected @ q / np.maximum(np.linalg.norm(projected,axis=1)*np.linalg.norm(q),1e-12)
                hits = [dict(id=doc['id'],score=float(score),via=[])
                    for doc,score in zip(documents,scores) if math.isfinite(float(score)) and score >= 0.35]
                diagnostics['latent_dimensions'] = rank
    elif mode == 'relationship':
        import networkx as nx
        from graphify.build import build_from_json
        extraction = dict(nodes=[dict(id=d['id'],label='Document '+d['id'],file_type='document',
            source_file=d['id']+'.md',source_location='whole indexed document',document_id=d['id']) for d in documents],
            edges=[dict(source=a,target=b,relation='requires',confidence='EXTRACTED',
                source_file=a+'.md',source_location='caller evidence map') for a,b in request['edges']])
        graph = build_from_json(extraction,directed=True)
        nodes = {data['document_id']:node for node,data in graph.nodes(data=True) if 'document_id' in data}
        identities = {node:key for key,node in nodes.items()}
        best = {}
        for seed in request['seeds']:
            if seed not in nodes:
                continue
            for target,path in nx.single_source_shortest_path(graph,nodes[seed],cutoff=3).items():
                chain = [identities[n] for n in path]
                row = dict(id=identities[target],score=1/len(chain),via=chain)
                if row['id'] not in best or row['score'] > best[row['id']]['score']:
                    best[row['id']] = row
        hits = list(best.values())
        diagnostics = dict(nodes=len(graph),edges=graph.number_of_edges(),max_hops=3,
            extraction='caller-declared-requires',native_graphify=True)
    else:
        raise ValueError('unsupported provider mode')
    hits.sort(key=lambda row:(-row['score'],row['id']))
    return dict(versions=versions,snapshot=request['snapshot'],mode=mode,hits=hits,diagnostics=diagnostics)


def project_knowledge(generation, versions):
    from graphify.build import build_from_json
    generation_id = generation['id']
    nodes, edges = [], []
    for row in generation['concepts']:
        anchor = row['anchor']
        nodes.append(dict(id='registrar_concept_'+row['id'].split(':',1)[1],
            label=f"{row['title']} [{row['id']}]", title=row['title'], file_type='concept',
            source_file=f"{anchor['source_id']}/{anchor['path']}",
            source_location=f"chars {anchor['text_start']}:{anchor['text_end']}",
            registrar_kind='concept',registrar_id=row['id'],projection_generation_id=generation_id,
            concept_type=row['concept_type'],source_id=anchor['source_id'],
            path=anchor['path'],source_sha256=anchor['source_sha256'],text_start=anchor['text_start'],
            text_end=anchor['text_end'],line_start=anchor['line_start'],line_end=anchor['line_end'],
            extractor_revision=generation['extractor_revision'],provenance_class=row['provenance']))
    for row in generation['relationships']:
        anchor = row['anchor']
        relation_node = 'registrar_relationship_'+row['id'].split(':',1)[1]
        nodes.append(dict(id=relation_node,label=f"{row['relationship_type']} [{row['id']}]",
            file_type='concept',source_file=f"{anchor['source_id']}/{anchor['path']}",
            source_location=f"chars {anchor['text_start']}:{anchor['text_end']}",
            registrar_kind='relationship',registrar_id=row['id'],projection_generation_id=generation_id,
            relationship_type=row['relationship_type'],subject_id=row['subject_id'],object_id=row['object_id'],
            source_id=anchor['source_id'],path=anchor['path'],source_sha256=anchor['source_sha256'],
            text_start=anchor['text_start'],text_end=anchor['text_end'],line_start=anchor['line_start'],
            line_end=anchor['line_end'],extractor_revision=generation['extractor_revision'],
            provenance_class=row['provenance']))
        confidence = {'extracted':('EXTRACTED',1.0),'inferred':('INFERRED',0.75),
                      'ambiguous':('AMBIGUOUS',0.2)}[row['provenance']]
        subject = 'registrar_concept_'+row['subject_id'].split(':',1)[1]
        object_ = 'registrar_concept_'+row['object_id'].split(':',1)[1]
        common = dict(confidence=confidence[0],confidence_score=confidence[1],
            source_file=f"{anchor['source_id']}/{anchor['path']}",
            source_location=f"chars {anchor['text_start']}:{anchor['text_end']}",
            registrar_relationship_id=row['id'],projection_generation_id=generation_id)
        edges.append(dict(source=subject,target=relation_node,relation='registrar_subject',**common))
        edges.append(dict(source=relation_node,target=object_,relation='registrar_object',**common))
    graph = build_from_json(dict(nodes=nodes,edges=edges,hyperedges=[]),directed=True)
    records = {}
    for _,data in graph.nodes(data=True):
        identity = data.get('registrar_id')
        if identity is None:
            continue
        if identity in records:
            raise ValueError('graphify duplicated Registrar identity')
        records[identity] = {key:data[key] for key in (
            'registrar_kind','registrar_id','projection_generation_id','source_id','path','source_file','source_sha256',
            'text_start','text_end','line_start','line_end','extractor_revision','provenance_class')}
        if data['registrar_kind'] == 'concept':
            records[identity].update(title=data['title'],concept_type=data['concept_type'])
        else:
            records[identity].update(relationship_type=data['relationship_type'],
                subject_id=data['subject_id'],object_id=data['object_id'])
    node_identities = {node:data.get('registrar_id') for node,data in graph.nodes(data=True)}
    connector_edges = []
    for source,target,data in graph.edges(data=True):
        identity = data.get('registrar_relationship_id')
        if identity is not None:
            connector_edges.append(dict(relationship_id=identity,role=data['relation'],
                generation_id=data['projection_generation_id'],source_record_id=node_identities.get(source),
                target_record_id=node_identities.get(target)))
    connector_edges.sort(key=lambda row:(row['relationship_id'],row['role']))
    return dict(versions=versions,generation_id=generation_id,native_graphify=True,
                records=records,connector_edges=connector_edges)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16777217)
        if len(raw) > 16777216:
            raise ValueError('provider input exceeds sixteen MiB')
        print(json.dumps(run(json.loads(raw)),allow_nan=False))
    except (ValueError,KeyError,ImportError,importlib.metadata.PackageNotFoundError) as exc:
        print(json.dumps(dict(error=str(exc))))
        raise SystemExit(2)
