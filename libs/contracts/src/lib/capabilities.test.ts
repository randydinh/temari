import assert from 'node:assert/strict';
import test from 'node:test';

import {
  missingOrUnprovenCapabilities,
  provenCapabilities,
  type HostCapabilityReport,
} from './capabilities.js';

test('distinguishes declared capabilities from explicitly proven capabilities', () => {
  const report: HostCapabilityReport = {
    host: 'migration-fixture',
    available: ['parallelism', 'forge'],
    missing: [],
    notes: {},
    provenance: {
      parallelism: {
        status: 'unproven',
        source: 'declared adapter capability',
      },
      forge: {
        status: 'proven',
        source: 'clean host journey',
        observedAt: '2026-09-24T00:00:00.000Z',
      },
    },
  };

  assert.deepEqual(provenCapabilities(report), ['forge']);
  assert.deepEqual(
    missingOrUnprovenCapabilities(['parallelism', 'forge'], report),
    ['parallelism'],
  );
});

test('treats a legacy report without provenance as unproven for strict gates', () => {
  const report: HostCapabilityReport = {
    host: 'legacy-fixture',
    available: ['parallelism'],
    missing: [],
    notes: {},
  };

  assert.deepEqual(provenCapabilities(report), []);
  assert.deepEqual(missingOrUnprovenCapabilities(['parallelism'], report), [
    'parallelism',
  ]);
});
