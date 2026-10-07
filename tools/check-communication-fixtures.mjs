import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const digest = (b) => createHash('sha256').update(b).digest('hex');
const need = (v, m) => {
  if (!v) throw Error(m);
};
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const unique = (xs, label) => {
  need(Array.isArray(xs) && xs.length > 0, label + ' empty');
  need(new Set(xs).size === xs.length, label + ' duplicate');
};
export function validateCorpus(fixtures, rubric, responses, expectations) {
  need(
    fixtures.schemaVersion === 1 &&
      rubric.schemaVersion === 1 &&
      responses.schemaVersion === 1,
    'Unsupported schema',
  );
  unique(
    fixtures.cases.map((c) => c.id),
    'cases',
  );
  unique(
    rubric.criteria.map((c) => c.id),
    'criteria',
  );
  unique(
    responses.responses.map((r) => r.id),
    'responses',
  );
  const required = [
    'phase-complete',
    'auth-recovery',
    'partial-evidence',
    'ambiguous-choices',
    'ongoing-authorized',
    'trivial-finished',
    'several-choices',
  ];
  need(
    required.every((k) => fixtures.cases.some((c) => c.situation === k)),
    'Missing required situation',
  );
  need(
    [0, 1, 2].every((n) =>
      fixtures.cases.some((c) => c.feasibleChoices.length === n),
    ) && fixtures.cases.some((c) => c.feasibleChoices.length > 2),
    'Missing variable choice coverage',
  );
  for (const c of fixtures.cases) {
    need(
      ['goal', 'phase', 'request'].every((k) => text(c[k])),
      'Missing goal/phase/request',
    );
    need(
      Array.isArray(c.evidenceFacts) &&
        c.evidenceFacts.length &&
        c.evidenceFacts.every(text),
      'Missing evidence facts',
    );
    need(
      Array.isArray(c.evidenceBounds) &&
        c.evidenceBounds.length &&
        c.evidenceBounds.every(text),
      'Missing evidence bounds',
    );
    need(
      Array.isArray(c.authorizedActions) &&
        c.authorizedActions.every(text) &&
        Array.isArray(c.feasibleChoices) &&
        c.feasibleChoices.every(text),
      'Invalid actions or choices',
    );
    need(
      responses.responses.filter((r) => r.caseId === c.id).length >= 2,
      'Missing varied responses',
    );
  }
  for (const r of responses.responses)
    need(
      fixtures.cases.some((c) => c.id === r.caseId) &&
        text(r.text) &&
        text(r.author),
      'Invalid response',
    );
  for (const c of rubric.criteria)
    need(text(c.requirement), 'Missing criterion requirement');
  if (expectations) {
    need(expectations.schemaVersion === 1, 'Invalid expectations');
    unique(
      expectations.items.map((e) => e.responseId),
      'expectations',
    );
    need(
      expectations.items.length === responses.responses.length,
      'Partial expectations',
    );
    for (const r of responses.responses)
      need(
        expectations.items.some(
          (e) =>
            e.responseId === r.id &&
            ['adequate', 'inadequate'].includes(e.classification) &&
            text(e.reason),
        ),
        'Missing expectation',
      );
  }
  return {
    cases: fixtures.cases.length,
    responses: responses.responses.length,
    criteria: rubric.criteria.length,
    semanticQuality: 'not-assessed',
  };
}
export function validateReview(
  fixtures,
  rubric,
  responses,
  review,
  bindings,
  expectations,
) {
  validateCorpus(fixtures, rubric, responses, expectations);
  need(review.schemaVersion === 1, 'Review schema');
  need(
    review.reviewer?.independent === true &&
      text(review.reviewer.id) &&
      text(review.reviewer.method),
    'Independent reviewer required',
  );
  need(
    !responses.responses.some((r) => r.author === review.reviewer.id),
    'Reviewer is a response author',
  );
  need(
    bindings &&
      ['fixturesSha256', 'rubricSha256', 'responsesSha256'].every(
        (k) => review.bindings?.[k] === bindings[k],
      ),
    'Stale or missing bindings',
  );
  unique(
    review.assessments?.map((a) => a.responseId),
    'assessments',
  );
  need(
    review.assessments.length === responses.responses.length,
    'Partial assessment',
  );
  const disagreements = [];
  for (const r of responses.responses) {
    const a = review.assessments.find((a) => a.responseId === r.id);
    need(
      a && ['adequate', 'inadequate'].includes(a.classification),
      'Missing classification',
    );
    need(
      [
        'happened',
        'means',
        'remaining',
        'actor',
        'nextAction',
        'recommendation',
      ].every((k) => text(a.readerAnswers?.[k])),
      'Missing reader answers',
    );
    unique(
      a.criteria?.map((c) => c.id),
      'assessment criteria',
    );
    need(a.criteria.length === rubric.criteria.length, 'Partial criteria');
    for (const criterion of rubric.criteria) {
      const q = a.criteria.find((c) => c.id === criterion.id);
      need(
        q &&
          Number.isInteger(q.score) &&
          q.score >= 0 &&
          q.score <= 2 &&
          text(q.reason),
        'Invalid criterion judgment',
      );
      need(
        Array.isArray(q.evidence) && q.evidence.length > 0,
        'Missing span evidence',
      );
      for (const e of q.evidence)
        need(
          Number.isInteger(e.start) &&
            Number.isInteger(e.end) &&
            e.start >= 0 &&
            e.end > e.start &&
            e.end <= r.text.length &&
            text(e.quote) &&
            r.text.slice(e.start, e.end) === e.quote,
          'Fabricated or stale evidence span',
        );
    }
    if (expectations) {
      const e = expectations.items.find((e) => e.responseId === r.id);
      if (e.classification !== a.classification)
        disagreements.push({
          responseId: r.id,
          expected: e.classification,
          observed: a.classification,
        });
    }
  }
  return {
    reviewIntegrity: 'passed',
    semanticQuality: 'independent-judgments-retained',
    disagreements,
    limitations: [
      'Reviewer independence is declared, not host-proven.',
      'Span binding proves cited bytes, not judgment correctness.',
      'Authored examples are not generated-output quality evidence.',
    ],
  };
}
export function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  need(
    ['corpus', 'review'].includes(mode),
    'Usage: check-communication-fixtures.mjs corpus | review REVIEW.json',
  );
  const dir = resolve('evaluations/communication'),
    load = (n) => {
      const b = readFileSync(resolve(dir, n));
      return { b, v: JSON.parse(b.toString('utf8')) };
    };
  const f = load('fixtures.json'),
    r = load('rubric.json'),
    s = load('responses.json');
  if (mode === 'corpus') return validateCorpus(f.v, r.v, s.v);
  need(argv.length === 2, 'Review path required');
  const e = load('expectations.json');
  return validateReview(
    f.v,
    r.v,
    s.v,
    JSON.parse(readFileSync(resolve(argv[1]), 'utf8')),
    {
      fixturesSha256: digest(f.b),
      rubricSha256: digest(r.b),
      responsesSha256: digest(s.b),
    },
    e.v,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = main();
    console.log(JSON.stringify(result, null, 2));
    if (result.disagreements?.length) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
