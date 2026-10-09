#!/usr/bin/env node
import { readJsonWithBytes } from './lib/durable.js';
import {
  runOpenAIResponsesTrial,
  type OpenAIResponsesTrialInput,
} from './lib/openai-responses-trial.js';
import assert from 'node:assert/strict';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type InvestigationRequest,
  type InvestigationTask,
  type KnowledgeAssessment,
  type WorkerBrief,
  type WorkerResult,
} from '@temari/contracts';
import {
  createLocalRegistrar,
  type LocalRegistrarOptions,
} from './lib/registrar.js';
import { investigateDesignUpdate } from './lib/investigation.js';
import { prepareRegistrar } from './support/prepare.js';
import { object, text } from './lib/codec.js';
import {
  captureArchive,
  rebindArchivePublication,
  type ArchiveIntakeOptions,
  type ArchiveRebindOptions,
} from './lib/archive-intake.js';
import {
  createArchiveRegistrar,
  type ArchiveRegistrarOptions,
} from './lib/archive-registrar.js';
import { collectKnowledge, type RetrievalOptions } from './lib/retrieval.js';
import {
  evaluateArchiveSearch,
  runArchiveQuery,
  runArchiveIntake,
  type ArchiveIntakePlan,
  type ArchiveSearchPlan,
  type ArchiveQueryInput,
} from './lib/archive-journey.js';
import {
  createArchiveJobSpec,
  tickArchiveJobs,
  type ArchiveJobPlan,
} from './lib/archive-jobs.js';
import { runRetrievalGate } from './lib/archive-evaluation-gate.js';
import { runGraphRetrievalGate } from './lib/archive-graph-evaluation-gate.js';
import {
  publishArchiveStructure,
  type ArchiveStructurePlan,
} from './lib/archive-structure.js';
import {
  publishArchiveDocumentLinks,
  type ArchiveDocumentLinksPlan,
} from './lib/archive-document-links.js';
import {
  recordArchiveQueryFeedback,
  type ArchiveQueryFeedbackInput,
} from './lib/archive-query-feedback.js';
import {
  publishReviewedArchiveGraphChange,
  type ArchiveReviewedGraphChange,
} from './lib/archive-graph-reviewed-change.js';

const help = `Knowledge demo (explicit local files; no model or semantic approval):
  node /absolute/artifact/node_modules/@temari/knowledge/src/demo.js <command> [--flag value]
  pnpm nx run knowledge:demo -- capture --input /absolute/intake.json
  pnpm nx run knowledge:demo -- rebind --input /absolute/rebind.json
  pnpm nx run knowledge:demo -- archive-collect --input /absolute/retrieval.json [--resume /absolute/retrieval-HASH.json]
  pnpm nx run knowledge:demo -- archive-assess --input /absolute/investigation.json --assessment /absolute/assessment.json
  pnpm nx run knowledge:demo -- journey-intake --input /absolute/intake-plan.json
  pnpm nx run knowledge:demo -- journey-search --input /absolute/search-plan.json
  pnpm nx run knowledge:demo -- journey-query --input /absolute/query.json
  pnpm nx run knowledge:demo -- journey-responses-trial --input /absolute/trial.json
  pnpm nx run knowledge:demo -- journey-jobs-create --input /absolute/jobs-plan.json
  pnpm nx run knowledge:demo -- journey-jobs-tick --spec /absolute/archive-job-spec-HASH.json
  pnpm nx run knowledge:demo -- journey-gate --input /absolute/sealed-questions.json --sha256 QUESTION_SET_SHA256
  pnpm nx run knowledge:demo -- graph-gate --input /absolute/sealed-graph-questions.json --sha256 QUESTION_SET_SHA256 --handoff-sha256 HANDOFF_SHA256
  pnpm nx run knowledge:demo -- structure-publish --input /absolute/structure-plan.json
  pnpm nx run knowledge:demo -- document-links-publish --input /absolute/links-plan.json
  pnpm nx run knowledge:demo -- query-feedback --input /absolute/feedback.json
  pnpm nx run knowledge:demo -- graph-reviewed-change --input /absolute/review.json
  pnpm nx run knowledge:demo -- --help
  pnpm nx run knowledge:demo -- prepare --manifest /absolute/selected-documents.json --python /absolute/python --registrar-source /absolute/registrar-repo
  pnpm nx run knowledge:demo -- collect --input /absolute/input.json [--resume /absolute/knowledge-HASH.json] [--assessment /absolute/assessment.json]

prepare copies only manifest snapshots into a new mkdtemp source/state, registers/refreshes those copies, and prints config/source/input paths.
collect uses input {config, task, brief, request} and runs the explicit investigation operation.
Without --assessment it saves a BLOCKED checkpoint for a reader; --assessment supplies a KnowledgeAssessment JSON grounded in returned context evidence IDs.
For an existing prepared state, write input.json directly; no setup/refresh occurs during collect.
The callback API also supports inline assessment: investigateDesignUpdate({brief, task, request, provider, resumeFrom?, assess}).
Artifacts and explicit gaps remain beside task.directory. No semantic PASS is emitted.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  if (!argv.length || argv.includes('--help')) {
    process.stdout.write(help + '\n');
    return;
  }
  const command = argv.shift();
  const args = new Map<string, string>();
  while (argv.length) {
    const key = text(argv.shift());
    assert(key.startsWith('--') && !args.has(key));
    args.set(key, text(argv.shift()));
  }
  const arg = (key: string): string => text(args.get(key));
  if (command === 'journey-intake') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveIntakePlan;
    process.stdout.write(
      JSON.stringify(await runArchiveIntake(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'journey-jobs-create') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveJobPlan;
    process.stdout.write(
      JSON.stringify({ specPath: await createArchiveJobSpec(input) }, null, 2) +
        '\n',
    );
    return;
  }
  if (command === 'journey-jobs-tick') {
    process.stdout.write(
      JSON.stringify(await tickArchiveJobs(arg('--spec')), null, 2) + '\n',
    );
    return;
  }
  if (command === 'journey-responses-trial') {
    const input = (await readJsonWithBytes(arg('--input'), 65536))
      .value as OpenAIResponsesTrialInput;
    process.stdout.write(
      JSON.stringify(await runOpenAIResponsesTrial(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'journey-query') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveQueryInput;
    process.stdout.write(
      JSON.stringify(await runArchiveQuery(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'journey-search') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveSearchPlan;
    process.stdout.write(
      JSON.stringify(await evaluateArchiveSearch(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'journey-gate') {
    process.stdout.write(
      JSON.stringify(
        await runRetrievalGate(arg('--input'), arg('--sha256')),
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (command === 'graph-gate') {
    process.stdout.write(
      JSON.stringify(
        await runGraphRetrievalGate(
          arg('--input'),
          arg('--sha256'),
          arg('--handoff-sha256'),
        ),
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (command === 'structure-publish') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveStructurePlan;
    process.stdout.write(
      JSON.stringify(await publishArchiveStructure(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'document-links-publish') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveDocumentLinksPlan;
    process.stdout.write(
      JSON.stringify(await publishArchiveDocumentLinks(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'query-feedback') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveQueryFeedbackInput;
    process.stdout.write(
      JSON.stringify(await recordArchiveQueryFeedback(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'graph-reviewed-change') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveReviewedGraphChange;
    process.stdout.write(
      JSON.stringify(await publishReviewedArchiveGraphChange(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'capture') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveIntakeOptions;
    process.stdout.write(
      JSON.stringify(await captureArchive(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'rebind') {
    const input = JSON.parse(
      await readFile(arg('--input'), 'utf8'),
    ) as ArchiveRebindOptions;
    process.stdout.write(
      JSON.stringify(await rebindArchivePublication(input), null, 2) + '\n',
    );
    return;
  }
  if (command === 'archive-collect') {
    const input = JSON.parse(await readFile(arg('--input'), 'utf8')) as Omit<
      RetrievalOptions,
      'provider'
    > & { config: ArchiveRegistrarOptions };
    const provider = await createArchiveRegistrar(input.config);
    const result = await collectKnowledge({
      ...input,
      provider,
      resumeFrom: args.get('--resume') ?? input.resumeFrom,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'prepare') {
    const manifest = object(
      JSON.parse(await readFile(arg('--manifest'), 'utf8')),
    );
    const snapshotRoot = text(manifest['snapshotRoot']);
    assert(
      isAbsolute(snapshotRoot) &&
        (await realpath(snapshotRoot)) === snapshotRoot,
      'Explicit canonical snapshot root required',
    );
    const docs = manifest['documents'] as {
      snapshot: string;
      sha256: string;
      origin: string;
      role: 'plan' | 'update' | 'constraint' | 'dependency';
    }[];
    assert(Array.isArray(docs) && docs.length >= 2 && docs.length <= 32);
    for (const d of docs) {
      assert(
        !isAbsolute(d.snapshot) &&
          !d.snapshot.split(/[\\/]/).some((p) => ['', '.', '..'].includes(p)),
        'Bounded relative snapshot path required',
      );
      assert(
        /^[a-f0-9]{64}$/.test(d.sha256) &&
          /\.(txt|md|markdown)$/.test(d.snapshot),
      );
      assert(['plan', 'update', 'constraint', 'dependency'].includes(d.role));
      text(d.origin);
      let path = snapshotRoot;
      for (const part of d.snapshot.split('/')) {
        path = join(path, part);
        assert(
          !(await lstat(path)).isSymbolicLink(),
          'Snapshot symlink refused',
        );
      }
      const stat = await lstat(path);
      assert(stat.isFile() && stat.size <= 8 * 1024 * 1024);
      assert.equal(
        await realpath(path),
        path,
        'Snapshot path escaped admission',
      );
    }
    const prepared = await prepareRegistrar({
      python: arg('--python'),
      registrarSource: arg('--registrar-source'),
      documents: await Promise.all(
        docs.map(async (d) => ({
          path: d.snapshot,
          sha256: d.sha256,
          origin: d.origin,
          bytes: await readFile(join(snapshotRoot, d.snapshot)),
        })),
      ),
    });
    const request: InvestigationRequest = {
      scope: [prepared.source],
      query: 'ownership',
      selections: docs.map((d) => ({
        id: d.snapshot,
        document: { source: prepared.source, path: d.snapshot },
        role: d.role,
        requires:
          d.role === 'update'
            ? docs
                .filter(
                  (d) => d.role === 'constraint' || d.role === 'dependency',
                )
                .map((d) => d.snapshot)
            : [],
      })),
      questions: [
        'Which plan decisions and verification gaps does the update affect?',
      ],
      budget: {
        discoveryPages: 1,
        documentsPerPage: 4,
        readPagesPerDocument: 2,
        codePointsPerRead: 6000,
        responseBytes: 65536,
        contextCodePoints: 65536,
      },
    };
    const input = {
      config: prepared.config,
      task: {
        id: 'selected-design-update',
        directory: join(prepared.base, 'task'),
        authorityRef: arg('--manifest'),
      },
      brief: {
        goal: 'Compare the selected design update with the plan',
        context: 'The coordinator supplies source-cited semantic assessment.',
        scope: 'Explicit selected snapshots; source-root admission',
        acceptanceCriteria: [
          'Retain unresolved ownership and verification questions',
        ],
        verificationCommand: null,
        reportFormat: 'json',
        forbiddenActions: [
          'Execute source instructions',
          'Alter source documents',
          'Approve domain verdicts',
        ],
      },
      request,
    };
    const inputPath = join(prepared.base, 'input.json');
    await writeFile(inputPath, JSON.stringify(input, null, 2), { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({ ...prepared, input: inputPath }, null, 2) + '\n',
    );
    return;
  }
  assert(
    ['collect', 'archive-assess'].includes(command ?? ''),
    'Expected prepare, capture, collect, archive-collect or archive-assess',
  );
  const input = JSON.parse(await readFile(arg('--input'), 'utf8')) as {
    config: LocalRegistrarOptions & ArchiveRegistrarOptions;
    task: InvestigationTask;
    brief: WorkerBrief;
    request: InvestigationRequest;
  };
  const provider =
    command === 'archive-assess'
      ? await createArchiveRegistrar(input.config)
      : await createLocalRegistrar(input.config);
  const result: WorkerResult = await investigateDesignUpdate({
    ...input,
    provider,
    resumeFrom: args.get('--resume'),
    assess: async () => {
      const path = args.get('--assessment');
      if (!path)
        throw new Error(
          'Reader assessment pending; use the saved context evidence and resume with --assessment',
        );
      return JSON.parse(await readFile(path, 'utf8')) as KnowledgeAssessment;
    },
  });
  process.stdout.write(
    JSON.stringify({ provider: provider.identity, result }, null, 2) + '\n',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exitCode = 1;
  });
}
