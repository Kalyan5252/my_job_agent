import { COMPANY_CAREER_SOURCES } from '../src/config/companySources';
import { CompanyCareerSource } from '../src/sources/companyCareer.source';

async function main() {
  const query = {
    role: process.env.COMPANY_SOURCE_TEST_ROLE || 'Software Engineer',
    skills: (process.env.COMPANY_SOURCE_TEST_SKILLS || 'TypeScript,Distributed Systems,Backend')
      .split(',')
      .map((skill) => skill.trim())
      .filter(Boolean),
    maxResults: Number(process.env.COMPANY_SOURCE_TEST_MAX_RESULTS || 10),
  };
  const source = new CompanyCareerSource(COMPANY_CAREER_SOURCES);
  const result = await source.fetchJobs(query);
  let failures = 0;

  console.log(`Checked ${COMPANY_CAREER_SOURCES.length} company career sources`);
  for (const diagnostic of result.diagnostics) {
    const status = diagnostic.error || diagnostic.accepted === 0 ? 'FAIL' : 'OK';
    if (status === 'FAIL') failures += 1;
    console.log(
      `${status} ${diagnostic.company} provider=${diagnostic.provider} fetched=${diagnostic.fetched} accepted=${diagnostic.accepted}${diagnostic.error ? ` error=${diagnostic.error}` : ''}`,
    );
  }

  console.log(`Total accepted jobs: ${result.jobs.length}`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
