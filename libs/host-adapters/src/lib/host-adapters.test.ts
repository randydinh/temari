import assert from 'node:assert/strict';
import test from 'node:test';

import { provenCapabilities } from '@temari/contracts';

import { adapterFor, cursorAdapter, genericAdapter } from './host-adapters.js';

test('unknown hosts use the honest serial fallback', () => {
  const adapter = adapterFor('unknown-host');
  const report = adapter.capabilities();

  assert.equal(adapter, genericAdapter);
  assert.equal(report.host, 'generic');
  assert.deepEqual(report.available, []);
  assert.ok(report.missing.includes('subagents'));
  assert.match(report.notes.subagents ?? '', /serial/i);
});

test('records adapter declarations as unproven until a host journey supplies evidence', () => {
  const report = cursorAdapter.capabilities();

  assert.deepEqual(provenCapabilities(report), []);
  assert.equal(report.provenance?.parallelism?.status, 'unproven');
});
