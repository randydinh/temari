import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_CAPABILITIES,
  missingCapabilities,
  missingOrUnprovenCapabilities,
  provenCapabilities,
} from '@temari/contracts';

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

  assert.deepEqual(report.available, []);
  assert.deepEqual(report.missing, HOST_CAPABILITIES);
  assert.deepEqual(provenCapabilities(report), []);
  for (const capability of HOST_CAPABILITIES) {
    assert.equal(report.provenance?.[capability]?.status, 'unproven');
    assert.deepEqual(missingCapabilities([capability], report.available), [
      capability,
    ]);
    assert.deepEqual(missingOrUnprovenCapabilities([capability], report), [
      capability,
    ]);
  }
});

test('Cursor and generic reports permit serial work with no required capability', () => {
  for (const adapter of [cursorAdapter, genericAdapter]) {
    const report = adapter.capabilities();
    assert.deepEqual(missingCapabilities([], report.available), []);
    assert.deepEqual(missingOrUnprovenCapabilities([], report), []);
  }
});
