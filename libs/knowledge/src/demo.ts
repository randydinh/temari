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

const help = `Knowledge demo (explicit local files; no model or semantic approval):
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
  assert.equal(command, 'collect', 'Expected prepare or collect');
  const input = JSON.parse(await readFile(arg('--input'), 'utf8')) as {
    config: LocalRegistrarOptions;
    task: InvestigationTask;
    brief: WorkerBrief;
    request: InvestigationRequest;
  };
  const provider = await createLocalRegistrar(input.config);
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
