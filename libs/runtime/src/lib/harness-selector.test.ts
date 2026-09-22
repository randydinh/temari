import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionHarness } from '@temari/contracts';
import { selectExecutionHarness } from './harness-selector.js';

function harness(id: string): ExecutionHarness {
  return {
    id,
    version: '1.0.0',
    async start() {
      throw new Error('not exercised');
    },
    async status() {
      throw new Error('not exercised');
    },
    async resume() {
      throw new Error('not exercised');
    },
  };
}

test('host-provided execution harness can replace configured Archon', () => {
  const selected = selectExecutionHarness({
    hostHarness: harness('codex'),
    configuredHarness: harness('other'),
    managedDefault: harness('archon'),
  });
  assert.equal(selected.id, 'codex');
});

test('an explicitly configured alternative replaces the managed default', () => {
  const selected = selectExecutionHarness({
    hostHarness: null,
    configuredHarness: harness('custom'),
    managedDefault: harness('archon'),
  });
  assert.equal(selected.id, 'custom');
});

test('the managed Archon harness is used only as the default', () => {
  const selected = selectExecutionHarness({
    hostHarness: null,
    configuredHarness: null,
    managedDefault: harness('archon'),
  });
  assert.equal(selected.id, 'archon');
});

test('selection fails closed when no implementation is available', () => {
  assert.throws(
    () =>
      selectExecutionHarness({
        hostHarness: null,
        configuredHarness: null,
        managedDefault: null,
      }),
    /No execution harness is available/,
  );
});
