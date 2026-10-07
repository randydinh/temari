import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateCorpus,
  validateReview,
  digest,
  main,
} from './check-communication-fixtures.mjs';
const load = (n) => {
  const b = readFileSync('evaluations/communication/' + n + '.json');
  return { b, v: JSON.parse(b) };
};
const f = load('fixtures'),
  r = load('rubric'),
  s = load('responses'),
  e = load('expectations');
const bindings = {
  fixturesSha256: digest(f.b),
  rubricSha256: digest(r.b),
  responsesSha256: digest(s.b),
};
const clone = (x) => structuredClone(x);
// Synthetic assessment exercises validation only; not retained independent quality evidence.
function assessment() {
  return {
    schemaVersion: 1,
    reviewer: {
      id: 'synthetic-validation-actor',
      independent: true,
      method: 'Synthetic integrity fixture, not a semantic review',
    },
    bindings: { ...bindings },
    assessments: s.v.responses.map((response) => ({
      responseId: response.id,
      classification: e.v.items.find((x) => x.responseId === response.id)
        .classification,
      readerAnswers: Object.fromEntries(
        [
          'happened',
          'means',
          'remaining',
          'actor',
          'nextAction',
          'recommendation',
        ].map((k) => [k, 'Synthetic validator field']),
      ),
      criteria: r.v.criteria.map((c) => ({
        id: c.id,
        score: 1,
        reason: 'Synthetic validator reason',
        evidence: [
          { start: 0, end: response.text.length, quote: response.text },
        ],
      })),
    })),
  };
}
const check = (q) => validateReview(f.v, r.v, s.v, q, bindings, e.v);
test('corpus integrity does not claim semantic success', () =>
  assert.equal(validateCorpus(f.v, r.v, s.v).semanticQuality, 'not-assessed'));
test('complete bound assessment passes integrity only', () => {
  const result = check(assessment());
  assert.equal(result.reviewIntegrity, 'passed');
  assert.equal(result.disagreements.length, 0);
  assert.ok(result.limitations.length);
});
test('missing review cannot succeed', () =>
  assert.throws(() => main(['review']), /required/));
test('stale input digest rejected', () => {
  const q = assessment();
  q.bindings.responsesSha256 = '0'.repeat(64);
  assert.throws(() => check(q), /bindings/);
});
test('missing input binding rejected', () => {
  const q = assessment();
  delete q.bindings.rubricSha256;
  assert.throws(() => check(q), /bindings/);
});
test('partial case assessment rejected', () => {
  const q = assessment();
  q.assessments.pop();
  assert.throws(() => check(q), /Partial/);
});
test('duplicate case assessment rejected', () => {
  const q = assessment();
  q.assessments[1] = clone(q.assessments[0]);
  assert.throws(() => check(q), /duplicate/);
});
test('partial criterion assessment rejected', () => {
  const q = assessment();
  q.assessments[0].criteria.pop();
  assert.throws(() => check(q), /Partial/);
});
test('invalid score rejected', () => {
  const q = assessment();
  q.assessments[0].criteria[0].score = 3;
  assert.throws(() => check(q), /judgment/);
});
test('fabricated response span rejected', () => {
  const q = assessment();
  q.assessments[0].criteria[0].evidence[0].quote = 'Invented evidence';
  assert.throws(() => check(q), /Fabricated/);
});
test('out-of-range response span rejected', () => {
  const q = assessment();
  q.assessments[0].criteria[0].evidence[0].end = 999999;
  assert.throws(() => check(q), /Fabricated/);
});
test('missing span evidence rejected', () => {
  const q = assessment();
  q.assessments[0].criteria[0].evidence = [];
  assert.throws(() => check(q), /span/);
});
test('missing novice reader answer rejected', () => {
  const q = assessment();
  delete q.assessments[0].readerAnswers.actor;
  assert.throws(() => check(q), /reader/);
});
test('response author cannot self-declare independent review', () => {
  const q = assessment();
  q.reviewer.id = 'fixture-author';
  assert.throws(() => check(q), /author/);
});
test('undeclared independence rejected', () => {
  const q = assessment();
  q.reviewer.independent = false;
  assert.throws(() => check(q), /Independent/);
});
test('classification disagreement remains visible', () => {
  const q = assessment();
  q.assessments[0].classification =
    q.assessments[0].classification === 'adequate' ? 'inadequate' : 'adequate';
  assert.equal(check(q).disagreements.length, 1);
});
test('there is no fixed display-option cap', () => {
  const fixture = clone(f.v);
  fixture.cases.find((c) => c.situation === 'several-choices').feasibleChoices =
    Array.from({ length: 9 }, (_, i) => 'Feasible synthetic format ' + i);
  assert.equal(validateCorpus(fixture, r.v, s.v).cases, 7);
});
test('wording can change without phrase snapshots', () => {
  const responses = clone(s.v);
  responses.responses[0].text =
    'An independently assessable alternative expression.';
  assert.equal(
    validateCorpus(f.v, r.v, responses).semanticQuality,
    'not-assessed',
  );
  const q = assessment();
  assert.throws(
    () =>
      validateReview(
        f.v,
        r.v,
        responses,
        q,
        { ...bindings, responsesSha256: 'new' },
        e.v,
      ),
    /bindings/,
  );
});
