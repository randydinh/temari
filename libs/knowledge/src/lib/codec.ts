import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InvestigationCheckpoint, InvestigationRequest, KnowledgeAssessment, KnowledgeDiscovery, KnowledgeEvidence, KnowledgeGap, KnowledgeSource } from '@temari/contracts';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  assert(typeof value !== 'number' || Number.isFinite(value), 'Non-finite JSON number');
  const result = JSON.stringify(value);
  assert(result !== undefined, 'Non-JSON value');
  return result;
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string { assert(typeof value === 'string' && value.length > 0, 'Expected nonempty string'); return value; }
export function integer(value: unknown, min = 0, max = 1_048_576): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'Invalid integer'); return value;
}
export function list(value: unknown): unknown[] { assert(Array.isArray(value) && value.length <= 2048, 'Invalid array'); return value; }
export function strings(value: unknown): string[] { return list(value).map(text); }
export function digest(value: unknown): string { const result = text(value); assert(/^[a-f0-9]{64}$/.test(result), 'Invalid SHA-256'); return result; }
export function source(value: unknown): void { const r = object(value); text(r['provider']); text(r['id']); text(r['locator']); }
export function document(value: unknown): void { const r = object(value); source(r['source']); text(r['path']); }
export function knowledgeGap(value: unknown): asserts value is KnowledgeGap {
  const r = object(value); assert(['unsupported','scope-refused','changed','unavailable','unknown','pending'].includes(text(r['kind'])));
  text(r['subject']); text(r['detail']);
}
export function discovery(value: unknown, scope?: readonly KnowledgeSource[]): asserts value is KnowledgeDiscovery {
  const r = object(value); text(r['snapshot']);
  const admit = (value: unknown): void => { source(value); if (scope) assert(scope.some(s => canonical(s) === canonical(value)), 'Discovery outside requested scope'); };
  const docs = list(r['documents']);
  for (const entry of docs) { const d = object(entry); document(d['document']); admit(object(d['document'])['source']); digest(d['sha256']); text(d['applicability']); strings(d['conflicts']); }
  for (const entry of list(r['sources'])) { const s = object(entry); admit(s['source']); text(s['generation']); assert(s['scannedAt'] === null || typeof s['scannedAt'] === 'string'); text(s['observation']); }
  const c = object(r['coverage']); integer(c['indexed']); const matched = integer(c['matched']);
  assert.equal(integer(c['returned']), docs.length); const consumed = integer(c['consumed']); const remaining = integer(c['remaining']);
  assert.equal(consumed + remaining, matched); assert(consumed >= docs.length); assert.equal(c['exhausted'], remaining === 0);
  assert.equal(c['semanticRecall'], 'not-evaluated'); list(r['gaps']).forEach(knowledgeGap);
  assert(r['next'] === null || typeof r['next'] === 'string' && r['next'].length > 0);
  assert.equal(r['next'] === null, remaining === 0);
}
export function evidenceId(value: Omit<KnowledgeEvidence, 'id'>): string { return hash(canonical(value)); }
export function evidence(value: unknown): asserts value is KnowledgeEvidence {
  const r = object(value); document(r['document']); digest(r['sha256']);
  const repr = object(r['representation']); text(repr['method']); text(repr['signature']);
  const span = object(r['span']); assert.equal(span['unit'], 'unicode-codepoint');
  const start = integer(span['start'], 0, 8 * 1024 * 1024); const end = integer(span['end'], start + 1, 8 * 1024 * 1024);
  assert.equal(Array.from(text(r['excerpt'])).length, end - start);
  const { id, ...body } = r;
  assert.equal(digest(id), hash(canonical(body)), 'Evidence identity mismatch');
}
export function request(value: unknown): asserts value is InvestigationRequest {
  const r = object(value); const scope = list(r['scope']); assert(scope.length > 0 && scope.length <= 8); scope.forEach(source);
  text(r['query']); assert(strings(r['questions']).length > 0);
  assert.equal(new Set(strings(r['questions'])).size, strings(r['questions']).length, 'Duplicate question');
  const selections = list(r['selections']); assert(selections.length >= 2 && selections.length <= 32);
  const ids = new Set<string>(); const roles = new Set<string>();
  for (const entry of selections) {
    const s = object(entry); const id = text(s['id']); assert(!ids.has(id), 'Duplicate selection'); ids.add(id);
    document(s['document']); const d = object(s['document']);
    assert(scope.some(item => canonical(item) === canonical(d['source'])), 'Selection outside requested scope');
    const role = text(s['role']); assert(['plan', 'update', 'constraint', 'dependency'].includes(role)); roles.add(role);
    strings(s['requires']);
  }
  assert(roles.has('plan') && roles.has('update'), 'Plan and update selections required');
  for (const entry of selections) for (const dependency of strings(object(entry)['requires'])) assert(ids.has(dependency), 'Unknown dependency');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    assert(!visiting.has(id), 'Cyclic declared dependencies'); if (visited.has(id)) return;
    visiting.add(id);
    const entry = object(selections.find(s => object(s)['id'] === id));
    for (const dependency of strings(entry['requires'])) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  ids.forEach(visit);
  const b = object(r['budget']);
  integer(b['discoveryPages'], 1, 10); integer(b['documentsPerPage'], 1, 50);
  integer(b['readPagesPerDocument'], 1, 20); integer(b['codePointsPerRead'], 1, 8000);
  integer(b['responseBytes'], 1024, 65536); integer(b['contextCodePoints'], 256, 65536);
}
export function assessment(value: unknown, items: readonly KnowledgeEvidence[], request?: InvestigationRequest,
  prior?: KnowledgeAssessment | null): asserts value is KnowledgeAssessment {
  const a = object(value); const available = new Set(items.map(e => e.id)); const ids = new Set<string>();
  const references = (v: unknown): void => { for (const id of strings(v)) assert(available.has(id), `Unknown evidence ${id}`); };
  for (const item of list(a['findings'])) {
    const f = object(item); const id = text(f['id']); assert(!ids.has(id), 'Duplicate finding'); ids.add(id); text(f['proposition']);
    assert(['explicit','inferred','unknown'].includes(text(f['basis'])));
    assert(['proposed','accepted','deferred','superseded'].includes(text(f['standing'])));
    references(f['supports']); references(f['contrary']); references(f['authorityEvidence']);
    assert(strings(f['supports']).length + strings(f['contrary']).length > 0, 'Finding requires source citations');
    if (f['standing'] === 'accepted') assert(strings(f['authorityEvidence']).length > 0, 'Accepted interpretation requires authority citations');
    strings(f['affectedDecisions']); strings(f['verificationGaps']);
  }
  strings(a['assessedQuestions']); strings(a['remainingQuestions']); text(a['nextSafeStep']);
  for (const entry of list(a['rejectedAlternatives'])) { const r = object(entry); text(r['idea']); text(r['reason']); }
  const actions = new Set<string>();
  for (const entry of list(a['completedActions'])) { const r = object(entry); const id = text(r['id']); assert(!actions.has(id), 'Duplicate action'); actions.add(id); text(r['description']); references(r['evidenceIds']); }
  if (request) {
    const known = new Set([...request.questions, ...(prior?.assessedQuestions ?? []), ...(prior?.remainingQuestions ?? [])]);
    const assessed = strings(a['assessedQuestions']), remaining = strings(a['remainingQuestions']);
    assert.equal(new Set([...assessed, ...remaining]).size, assessed.length + remaining.length, 'Questions must be accounted for exactly once');
    for (const q of known) assert(assessed.includes(q) || remaining.includes(q), `Known question omitted: ${q}`);
    const roleIds = (role: string): Set<string> => new Set(items.filter(e => request.selections.some(s => s.role === role && canonical(s.document) === canonical(e.document))).map(e => e.id));
    const plans = roleIds('plan'), updates = roleIds('update');
    assert(list(a['findings']).some(entry => { const f = object(entry); const refs = [...strings(f['supports']), ...strings(f['contrary'])];
      return refs.some(id => plans.has(id)) && refs.some(id => updates.has(id)); }), 'Assessment requires a source-cited plan/update comparison');
  }
}
export function checkpoint(value: unknown): asserts value is InvestigationCheckpoint {
  const c = object(value); assert.equal(c['schema'], 1); assert.equal(c['semanticReview'], 'required');
  assert.equal(c['coherence'], 'sequential-checks-not-atomic');
  const t = object(c['task']); text(t['id']); text(t['directory']); text(t['authorityRef']);
  const p = object(c['provider']); text(p['instance']); text(p['implementation']); text(p['configuration']);
  request(c['request']);
  const requested = c['request'];
  const admitDocument = (doc: unknown): void => { document(doc); assert(requested.selections.some(s => canonical(s.document) === canonical(doc)), 'Checkpoint document outside selections'); };
  const b = object(c['trustedBrief']); text(b['goal']); assert(typeof b['context'] === 'string'); text(b['scope']);
  strings(b['acceptanceCriteria']); strings(b['forbiddenActions']);
  assert(b['verificationCommand'] === null || typeof b['verificationCommand'] === 'string'); assert(['json','markdown'].includes(text(b['reportFormat'])));
  assert(typeof c['suppliedContext'] === 'string'); assert(c['prior'] === null || typeof c['prior'] === 'string');
  assert(Array.from(c['suppliedContext']).length <= requested.budget.contextCodePoints, 'Supplied context exceeds budget');
  const items = list(c['evidence']); items.forEach(evidence);
  items.forEach(item => admitDocument((item as KnowledgeEvidence).document));
  assert(new Set(items.map(e => (e as KnowledgeEvidence).id)).size === items.length, 'Duplicate evidence');
  const evidenceIds = new Set(items.map(e => (e as KnowledgeEvidence).id));
  for (const id of strings(c['contextEvidenceIds'])) assert(evidenceIds.has(id));
  assert.equal(new Set(strings(c['contextEvidenceIds'])).size, strings(c['contextEvidenceIds']).length);
  for (const id of strings(c['contextEvidenceIds'])) {
    const item = (items as KnowledgeEvidence[]).find(e => e.id === id)!;
    assert((c['suppliedContext'] as string).includes(canonical(item)), 'Context evidence absent from supplied text');
  }
  for (const entry of list(c['checks'])) { const r = object(entry); assert(evidenceIds.has(text(r['evidenceId']))); assert(['unchanged','changed','unavailable','unknown'].includes(text(r['state']))); text(r['detail']); text(r['checkedAt']); }
  list(c['gaps']).forEach(knowledgeGap);
  for (const entry of list(c['pendingReads'])) { const r = object(entry); admitDocument(r['document']); assert(r['expectedSha256'] === null || digest(r['expectedSha256'])); integer(r['maxCodePoints'], 1, 8000); integer(r['maxBytes'], 1024, 65536); assert(r['continuation'] === null || typeof r['continuation'] === 'string'); }
  assert(typeof c['discoveryStarted'] === 'boolean'); assert(c['discoveryNext'] === null || typeof c['discoveryNext'] === 'string');
  list(c['discovery']).forEach(entry => discovery(entry, requested.scope));
  const actions = strings(c['readActions']); assert.equal(new Set(actions).size, actions.length);
  const assessments = strings(c['completedAssessments']); assessments.forEach(digest); assert.equal(new Set(assessments).size, assessments.length);
  if (c['assessment'] !== null) assessment(c['assessment'], items as KnowledgeEvidence[]);
  const findings = c['assessment'] === null ? [] : list(object(c['assessment'])['findings']).map(f => text(object(f)['id']));
  const validity = list(c['findingValidity']); assert.equal(validity.length, findings.length);
  const validityIds = new Set<string>();
  for (const entry of validity) { const r = object(entry); const id = text(r['id']); assert(findings.includes(id) && !validityIds.has(id)); validityIds.add(id); assert(['stale','blocked','needs-semantic-review'].includes(text(r['state']))); }
}
