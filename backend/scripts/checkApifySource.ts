import { ApifySource } from '../src/sources/apify.source';

async function main() {
  const source = new ApifySource();
  if (!source.isEnabled()) {
    console.log(
      'SKIPPED Apify source check: set APIFY_ENABLED=true, APIFY_TOKEN, and APIFY_ACTORS.',
    );
    return;
  }

  const result = await source.fetchJobs({
    role: process.env.APIFY_SOURCE_TEST_ROLE || 'Backend Engineer',
    skills: (process.env.APIFY_SOURCE_TEST_SKILLS || 'TypeScript,Node.js,Redis')
      .split(',')
      .map((skill) => skill.trim())
      .filter(Boolean),
    location: process.env.APIFY_SOURCE_TEST_LOCATION || 'Remote',
    maxResults: Number(process.env.APIFY_SOURCE_TEST_MAX_RESULTS || 20),
  });

  let failures = 0;
  for (const diagnostic of result.diagnostics) {
    const status = diagnostic.error || diagnostic.accepted === 0 ? 'FAIL' : 'OK';
    if (status === 'FAIL') failures += 1;
    console.log(
      `${status} actor=${diagnostic.actorId} fetched=${diagnostic.fetched} accepted=${diagnostic.accepted}${diagnostic.error ? ` error=${diagnostic.error}` : ''}`,
    );
  }
  console.log(`Total Apify accepted jobs: ${result.jobs.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
