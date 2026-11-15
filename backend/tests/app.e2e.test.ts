import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { AuthService, hashPassword } from '../src/auth/auth.service';
import { DiscoveryWorkflow } from '../src/workflows/discovery.workflow';

const API_KEY = 'test-api-key-0123456789abcdef';
const auth = new AuthService({
  disabled: false,
  apiKeys: [API_KEY],
  adminUsername: 'admin',
  adminPasswordHash: hashPassword('correct horse battery staple'),
  tokenSecret: 'x'.repeat(48),
  tokenTtlSeconds: 3600,
});

const discovery = {
  run: async () => {
    throw new Error('not expected');
  },
  schedule: async () => ({
    runId: 'run-42',
    status: 'queued' as const,
    queuedAt: '2026-07-01T00:00:00.000Z',
  }),
} as unknown as DiscoveryWorkflow;

function buildApp() {
  return createApp({
    auth,
    discovery,
    readiness: async () => ({ mongo: 'ok', postgres: 'ok', redis: 'disabled' }),
  });
}

test('POST /workflows/discovery/schedule returns queued run metadata', async () => {
  const app = buildApp();
  const response = await app.inject({
    method: 'POST',
    url: '/workflows/discovery/schedule',
    headers: { authorization: `Bearer ${API_KEY}` },
    payload: { role: 'Backend Engineer', skills: ['TypeScript'], experience: 'junior' },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    runId: 'run-42',
    status: 'queued',
    queuedAt: '2026-07-01T00:00:00.000Z',
  });
  await app.close();
});

test('protected routes reject missing or wrong credentials', async () => {
  const app = buildApp();
  const missing = await app.inject({ method: 'GET', url: '/profile' });
  assert.equal(missing.statusCode, 401);

  const wrong = await app.inject({
    method: 'GET',
    url: '/profile',
    headers: { 'x-api-key': 'nope' },
  });
  assert.equal(wrong.statusCode, 401);
  await app.close();
});

test('public routes work without credentials', async () => {
  const app = buildApp();
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);

  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().ok, true);
  await app.close();
});

test('login issues a token that authenticates requests', async () => {
  const app = buildApp();
  const bad = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'admin', password: 'wrong' },
  });
  assert.equal(bad.statusCode, 401);

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'admin', password: 'correct horse battery staple' },
  });
  assert.equal(login.statusCode, 200);
  const { accessToken, tokenType } = login.json();
  assert.equal(tokenType, 'Bearer');

  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().principal.type, 'user');

  const tampered = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken.slice(0, -2)}xx` },
  });
  assert.equal(tampered.statusCode, 401);
  await app.close();
});

test('invalid request bodies return 400 with issues', async () => {
  const app = buildApp();
  const response = await app.inject({
    method: 'POST',
    url: '/workflows/application/run',
    headers: { 'x-api-key': API_KEY },
    payload: { job: { applyUrl: 'javascript:alert(1)' } },
  });
  assert.equal(response.statusCode, 400);
  assert.ok(Array.isArray(response.json().issues));
  await app.close();
});

test('unknown session provider returns 404', async () => {
  const app = buildApp();
  const response = await app.inject({
    method: 'GET',
    url: '/sessions/facebook',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});
