import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import {
  retainProcessDiagnostic,
  type CapturedProcessDiagnostic,
} from '../libs/host-adapters/src/index.js';
import {
  streamEvidenceFile,
  verifyEvidenceFile,
  type EvidenceStore,
  type WorkerEvidenceReference,
} from '../libs/runtime/src/index.js';

export interface DashboardDiagnostic {
  readonly source: CapturedProcessDiagnostic;
  readonly reference: WorkerEvidenceReference | null;
  readonly summary: string;
  readonly archiveStatus: 'retained' | 'archive-failed';
  readonly archiveFailure?: {
    readonly source: CapturedProcessDiagnostic;
    readonly reference: WorkerEvidenceReference | null;
  };
}
export async function retainDashboardDiagnostic(
  store: EvidenceStore,
  runId: string,
  revision: string,
  path: string,
  category: CapturedProcessDiagnostic['category'],
  cause: unknown,
): Promise<DashboardDiagnostic> {
  const source = await retainProcessDiagnostic(path, category, cause);
  let reference: WorkerEvidenceReference | null = null;
  let verified = false;
  let archiveFailure: DashboardDiagnostic['archiveFailure'];
  try {
    assert(
      store.putStream && store.verifyPortable,
      'Streaming diagnostic ports are unavailable.',
    );
    const { path: _path, ...portable } = await store.putStream({
      runId,
      revision,
      kind: 'other',
      content: streamEvidenceFile(source.path, dirname(path)),
    });
    reference = portable;
    await store.verifyPortable(reference);
    verified = true;
  } catch (cause) {
    const secondary = await retainProcessDiagnostic(
      `${path}.archive-failure.log`,
      'archive',
      cause,
    );
    let secondaryReference: WorkerEvidenceReference | null = null;
    try {
      assert(store.putStream && store.verifyPortable);
      const { path: _path, ...portable } = await store.putStream({
        runId,
        revision,
        kind: 'other',
        content: streamEvidenceFile(secondary.path, dirname(path)),
      });
      secondaryReference = portable;
      await store.verifyPortable(portable);
    } catch {}
    archiveFailure = { source: secondary, reference: secondaryReference };
  }
  return {
    source,
    reference,
    archiveStatus:
      source.status === 'complete' && verified ? 'retained' : 'archive-failed',
    ...(archiveFailure === undefined ? {} : { archiveFailure }),
    summary: `${category} failed; diagnostic ${source.status === 'complete' && verified ? 'retained' : 'archive failed'}; sha256=${source.sha256}.`,
  };
}
export async function verifyDashboardDiagnostics(
  store: EvidenceStore,
  runId: string,
  revision: string,
  diagnostics: readonly DashboardDiagnostic[],
  ownedRoot: string,
): Promise<void> {
  assert(store.verifyPortable, 'Streaming verification is unavailable.');
  for (const diagnostic of diagnostics) {
    assert(
      diagnostic.archiveStatus === 'retained' ||
        diagnostic.archiveStatus === 'archive-failed',
      'Diagnostic archive status is invalid.',
    );
    if (diagnostic.archiveStatus === 'retained') {
      assert.equal(diagnostic.source.status, 'complete');
      assert(
        diagnostic.reference,
        'Retained diagnostic portable evidence is missing.',
      );
    }
    for (const value of [
      diagnostic,
      ...(diagnostic.archiveFailure ? [diagnostic.archiveFailure] : []),
    ]) {
      const expected: WorkerEvidenceReference = {
        schema: 1,
        runId,
        revision,
        kind: 'other',
        sha256: value.source.sha256,
        bytes: value.source.bytes,
      };
      await verifyEvidenceFile(value.source.path, ownedRoot, expected);
      if (!value.reference) continue;
      assert.deepEqual(
        value.reference,
        expected,
        'Diagnostic source and portable identity changed.',
      );
      await store.verifyPortable(value.reference);
    }
  }
}
