import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { DiscoveryWorkflow } from '../src/workflows/discovery.workflow';

test('POST /workflows/discovery/schedule returns queued run metadata', async () => {
  const app = createApp({
    discovery: {
      run: async () => {
        throw new Error('not expected');
      },
      schedule: async () => ({
        runId: 'run-42',
        status: 'queued' as const,
        queuedAt: '2026-07-01T00:00:00.000Z',
      }),
    } as DiscoveryWorkflow,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/workflows/discovery/schedule',
    payload: {
      role: 'Backend Engineer',
      skills: ['TypeScript'],
      experience: 'junior',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    runId: 'run-42',
    status: 'queued',
    queuedAt: '2026-07-01T00:00:00.000Z',
  });

  await app.close();
});
