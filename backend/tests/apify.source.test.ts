import test from 'node:test';
import assert from 'node:assert/strict';
import { ApifySource } from '../src/sources/apify.source';

const query = {
  role: 'Backend Engineer',
  skills: ['TypeScript', 'Redis'],
  maxResults: 5,
  location: 'Remote',
};

test('ApifySource stays disabled without env token and actor config', async () => {
  const source = new ApifySource([], async () => {
    throw new Error('fetch should not run');
  });

  const result = await source.fetchJobs(query);
  assert.deepEqual(result, { jobs: [], diagnostics: [] });
});

test('ApifySource runs configured actor and normalizes jobs', async () => {
  const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
  const source = new ApifySource(
    [{ actorId: 'user/job-scraper', source: 'apify-user-job-scraper' }],
    async (url, init) => {
      requested.push({
        url,
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      return Response.json([
        {
          id: 'job-1',
          title: 'Backend Engineer',
          company: 'Example Co',
          location: 'Remote',
          description: 'Build TypeScript services with Redis.',
          applyUrl: 'https://example.com/apply/job-1',
        },
        {
          id: 'job-2',
          title: 'Account Executive',
          company: 'Example Co',
          applyUrl: 'https://example.com/apply/job-2',
        },
      ]);
    },
    { enabled: true, token: 'test-token', timeoutSecs: 30 },
  );

  const result = await source.fetchJobs(query);

  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'apify-user-job-scraper');
  assert.equal(
    result.jobs[0].externalId,
    'apify-user-job-scraper-job-1-example-co-backend-engineer',
  );
  assert.equal(result.jobs[0].applyUrl, 'https://example.com/apply/job-1');
  assert.equal(result.diagnostics[0].fetched, 2);
  assert.equal(result.diagnostics[0].accepted, 1);
  assert.equal(requested.length, 1);
  assert.ok(requested[0].url.includes('/v2/acts/user%2Fjob-scraper/run-sync-get-dataset-items'));
  assert.equal(requested[0].body.query, 'Backend Engineer');
  assert.equal(requested[0].body.location, 'Remote');
});

test('ApifySource reports actor failures as diagnostics', async () => {
  const source = new ApifySource(
    [{ actorId: 'user/failing-actor', source: 'apify-user-failing-actor' }],
    async () => new Response('bad', { status: 500 }),
    { enabled: true, token: 'test-token', timeoutSecs: 30 },
  );

  const result = await source.fetchJobs(query);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].actorId, 'user/failing-actor');
  assert.match(result.diagnostics[0].error || '', /500/);
});
