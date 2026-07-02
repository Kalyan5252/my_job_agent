import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_CAREER_SOURCES, CompanyCareerSourceConfig } from '../src/config/companySources';
import { CompanyCareerSource } from '../src/sources/companyCareer.source';

const query = {
  role: 'Software Engineer',
  skills: ['TypeScript', 'Distributed Systems'],
  maxResults: 10,
};

test('all requested company career sources are configured', () => {
  const companies = COMPANY_CAREER_SOURCES.map((source) => source.company);
  assert.ok(COMPANY_CAREER_SOURCES.filter((source) => source.enabled).length >= 30);
  assert.deepEqual(companies.slice(0, 20), [
    'OpenAI',
    'Anthropic',
    'Stripe',
    'Datadog',
    'Cloudflare',
    'Snowflake',
    'Atlassian',
    'Notion',
    'Canva',
    'Rippling',
    'Rubrik',
    'MongoDB',
    'Redis',
    'Nvidia',
    'Microsoft',
    'Amazon',
    'Google',
    'Meta',
    'Adobe',
    'Oracle',
  ]);
  assert.ok(companies.includes('Palantir'));
  assert.ok(companies.includes('Vercel'));
});

test('Ashby provider normalizes company jobs', async () => {
  const source = config('OpenAI', 'ashby', 'openai');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    [`https://api.ashbyhq.com/posting-api/job-board/${source.boardToken}`]: {
      jobs: [
        {
          id: 'ashby-1',
          title: 'Software Engineer, Backend',
          location: { name: 'San Francisco' },
          applicationUrl: 'https://jobs.ashbyhq.com/openai/ashby-1/application',
          descriptionPlain: 'Build distributed systems with TypeScript.',
        },
      ],
    },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-openai');
  assert.equal(result.jobs[0].externalId, 'openai-ashby-1');
  assert.equal(result.jobs[0].applyUrl, 'https://jobs.ashbyhq.com/openai/ashby-1/application');
  assert.equal(result.diagnostics[0].accepted, 1);
});

test('Greenhouse provider normalizes company jobs', async () => {
  const source = config('Datadog', 'greenhouse', 'datadog');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    [`https://boards-api.greenhouse.io/v1/boards/${source.boardToken}/jobs?content=true`]: {
      jobs: [
        {
          id: 42,
          title: 'Software Engineer - Platform',
          absolute_url: 'https://job-boards.greenhouse.io/datadog/jobs/42',
          location: { name: 'New York' },
          content: '<p>TypeScript and distributed systems.</p>',
        },
      ],
    },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-datadog');
  assert.equal(result.jobs[0].externalId, 'datadog-42');
  assert.equal(result.jobs[0].location, 'New York');
});

test('Lever provider normalizes company jobs', async () => {
  const source = config('Example Lever', 'lever', 'example');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    [`https://api.lever.co/v0/postings/${source.boardToken}?mode=json`]: [
      {
        id: 'lever-1',
        text: 'Backend Software Engineer',
        hostedUrl: 'https://jobs.lever.co/example/lever-1',
        categories: { location: 'Remote' },
        descriptionPlain: 'Work on TypeScript services.',
      },
    ],
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].externalId, 'example-lever-lever-1');
  assert.equal(result.jobs[0].applyUrl, 'https://jobs.lever.co/example/lever-1');
});

test('Workday provider normalizes company jobs', async () => {
  const source = {
    company: 'Nvidia',
    slug: 'nvidia',
    source: 'company-nvidia',
    provider: 'workday' as const,
    careersUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    boardToken: undefined,
    workday: {
      tenant: 'nvidia',
      site: 'NVIDIAExternalCareerSite',
      baseUrl: 'https://nvidia.wd5.myworkdayjobs.com',
    },
    enabled: true,
  };
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs': {
      jobPostings: [
        {
          title: 'Software Engineer, Cloud Platform',
          externalPath: '/NVIDIAExternalCareerSite/job/software-engineer',
          locationsText: 'Santa Clara, CA',
          bulletFields: ['Distributed systems', 'TypeScript'],
        },
      ],
    },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(
    result.jobs[0].applyUrl,
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/software-engineer',
  );
});

test('custom HTML provider extracts relevant job links', async () => {
  const source = config('Amazon', 'custom-html');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    [source.careersUrl]:
      '<html><body><a href="/en/jobs/123/software-engineer">Software Engineer, Backend</a></body></html>',
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-amazon');
  assert.equal(result.jobs[0].applyUrl, 'https://careers.example/en/jobs/123/software-engineer');
});

test('SmartRecruiters provider normalizes company jobs', async () => {
  const source = config('Canva', 'smartrecruiters', 'Canva');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    [`https://api.smartrecruiters.com/v1/companies/${source.boardToken}/postings?limit=10&q=Software%20Engineer`]:
      {
        content: [
          {
            id: 'sr-1',
            name: 'Software Engineer, Platform',
            postingUrl: 'https://jobs.smartrecruiters.com/Canva/sr-1',
            location: { fullLocation: 'Sydney, Australia' },
            department: { label: 'Engineering' },
          },
        ],
      },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-canva');
  assert.equal(result.jobs[0].externalId, 'canva-sr-1');
});

test('Amazon Jobs provider normalizes company jobs', async () => {
  const source = config('Amazon', 'amazon-jobs');
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    'https://www.amazon.jobs/en/search.json?offset=0&result_limit=10&sort=relevant&base_query=Software%20Engineer':
      {
        jobs: [
          {
            id: 'amzn-1',
            title: 'Software Development Engineer',
            job_path: '/en/jobs/amzn-1/software-development-engineer',
            location: 'Seattle, WA',
            basic_qualifications: 'TypeScript distributed systems',
          },
        ],
      },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-amazon');
  assert.equal(result.jobs[0].externalId, 'amazon-amzn-1');
});

test('Oracle Cloud provider normalizes company jobs', async () => {
  const source: CompanyCareerSourceConfig = {
    company: 'Oracle',
    slug: 'oracle',
    source: 'company-oracle',
    provider: 'oracle-cloud',
    careersUrl: 'https://careers.oracle.com/jobs/',
    oracleCloud: {
      baseUrl: 'https://eeho.fa.us2.oraclecloud.com',
      siteNumber: 'CX_45001',
    },
    enabled: true,
  };
  const careerSource = new CompanyCareerSource([source], fakeFetch({
    'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_45001,keyword=Software%20Engineer,limit=10':
      {
        items: [
          {
            requisitionList: [
              {
                Id: '337447',
                Title: 'Software Developer 3',
                PrimaryLocation: 'India',
                ShortDescription: 'Distributed systems engineering',
              },
            ],
          },
        ],
      },
  }));

  const result = await careerSource.fetchJobs(query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, 'company-oracle');
  assert.equal(result.jobs[0].externalId, 'oracle-337447');
});

test('configured company source fixtures all produce at least one normalized job', async () => {
  const fixtures = Object.fromEntries(
    COMPANY_CAREER_SOURCES.map((source) => [source.company, fixtureFor(source)]),
  );

  for (const source of COMPANY_CAREER_SOURCES) {
    const careerSource = new CompanyCareerSource([source], fakeFetch(fixtures[source.company]));
    const result = await careerSource.fetchJobs(query);
    assert.equal(result.jobs.length, 1, `${source.company} should produce one job`);
    assert.equal(result.jobs[0].company, source.company);
    assert.equal(result.jobs[0].source, source.source);
    assert.ok(result.jobs[0].externalId);
    assert.ok(result.jobs[0].applyUrl);
  }
});

function config(
  company: string,
  provider: CompanyCareerSourceConfig['provider'],
  boardToken?: string,
): CompanyCareerSourceConfig {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    company,
    slug,
    source: `company-${slug}`,
    provider,
    boardToken,
    careersUrl: 'https://careers.example/jobs',
    enabled: true,
  };
}

function fixtureFor(source: CompanyCareerSourceConfig): Record<string, unknown> {
  if (source.provider === 'ashby') {
    return {
      [`https://api.ashbyhq.com/posting-api/job-board/${source.boardToken}`]: {
        jobs: [
          {
            id: `${source.slug}-job`,
            title: 'Software Engineer',
            location: { name: 'Remote' },
            applicationUrl: `${source.careersUrl}/apply/software-engineer`,
            descriptionPlain: 'Software engineer working on TypeScript distributed systems.',
          },
        ],
      },
    };
  }

  if (source.provider === 'greenhouse') {
    return {
      [`https://boards-api.greenhouse.io/v1/boards/${source.boardToken}/jobs?content=true`]: {
        jobs: [
          {
            id: 101,
            title: 'Software Engineer',
            absolute_url: `${source.careersUrl}/software-engineer`,
            location: { name: 'Remote' },
            content: 'TypeScript distributed systems',
          },
        ],
      },
    };
  }

  if (source.provider === 'workday' && source.workday) {
    return {
      [`${source.workday.baseUrl}/wday/cxs/${source.workday.tenant}/${source.workday.site}/jobs`]:
        {
          jobPostings: [
            {
              title: 'Software Engineer',
              externalPath: `/${source.workday.site}/job/software-engineer`,
              locationsText: 'Remote',
              bulletFields: ['TypeScript distributed systems'],
            },
          ],
        },
    };
  }

  if (source.provider === 'lever') {
    return {
      [`https://api.lever.co/v0/postings/${source.boardToken}?mode=json`]: [
        {
          id: `${source.slug}-job`,
          text: 'Software Engineer',
          hostedUrl: `${source.careersUrl}/software-engineer`,
          categories: { location: 'Remote' },
          descriptionPlain: 'TypeScript distributed systems',
        },
      ],
    };
  }

  if (source.provider === 'smartrecruiters') {
    return {
      [`https://api.smartrecruiters.com/v1/companies/${source.boardToken}/postings?limit=10&q=Software%20Engineer`]:
        {
          content: [
            {
              id: `${source.slug}-job`,
              name: 'Software Engineer',
              postingUrl: `${source.careersUrl}/software-engineer`,
              location: { fullLocation: 'Remote' },
              department: { label: 'Engineering' },
            },
          ],
        },
    };
  }

  if (source.provider === 'amazon-jobs') {
    return {
      'https://www.amazon.jobs/en/search.json?offset=0&result_limit=10&sort=relevant&base_query=Software%20Engineer':
        {
          jobs: [
            {
              id: `${source.slug}-job`,
              title: 'Software Development Engineer',
              job_path: '/en/jobs/software-development-engineer',
              location: 'Remote',
              basic_qualifications: 'TypeScript distributed systems',
            },
          ],
        },
    };
  }

  if (source.provider === 'oracle-cloud' && source.oracleCloud) {
    return {
      [`${source.oracleCloud.baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${source.oracleCloud.siteNumber},keyword=Software%20Engineer,limit=10`]:
        {
          items: [
            {
              requisitionList: [
                {
                  Id: `${source.slug}-job`,
                  Title: 'Software Engineer',
                  PrimaryLocation: 'Remote',
                  ShortDescription: 'TypeScript distributed systems',
                },
              ],
            },
          ],
        },
    };
  }

  return {
    [source.careersUrl]:
      '<html><body><a href="/jobs/software-engineer">Software Engineer</a></body></html>',
  };
}

function fakeFetch(fixtures: Record<string, unknown>) {
  return async (url: string): Promise<Response> => {
    if (!(url in fixtures)) {
      return new Response('not found', { status: 404 });
    }
    const value = fixtures[url];
    if (typeof value === 'string') {
      return new Response(value, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return Response.json(value);
  };
}
