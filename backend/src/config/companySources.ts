export type CompanySourceProvider =
  | 'ashby'
  | 'greenhouse'
  | 'lever'
  | 'smartrecruiters'
  | 'workday'
  | 'oracle-cloud'
  | 'amazon-jobs'
  | 'custom-html';

export interface CompanyCareerSourceConfig {
  company: string;
  slug: string;
  source: string;
  provider: CompanySourceProvider;
  careersUrl: string;
  boardToken?: string;
  workday?: {
    tenant: string;
    site: string;
    baseUrl: string;
  };
  oracleCloud?: {
    baseUrl: string;
    siteNumber: string;
  };
  enabled: boolean;
}

export const COMPANY_CAREER_SOURCES: CompanyCareerSourceConfig[] = [
  {
    company: 'OpenAI',
    slug: 'openai',
    source: 'company-openai',
    provider: 'ashby',
    boardToken: 'openai',
    careersUrl: 'https://openai.com/careers/search/',
    enabled: true,
  },
  {
    company: 'Anthropic',
    slug: 'anthropic',
    source: 'company-anthropic',
    provider: 'greenhouse',
    boardToken: 'anthropic',
    careersUrl: 'https://www.anthropic.com/jobs',
    enabled: true,
  },
  {
    company: 'Stripe',
    slug: 'stripe',
    source: 'company-stripe',
    provider: 'greenhouse',
    boardToken: 'stripe',
    careersUrl: 'https://stripe.com/jobs/search',
    enabled: true,
  },
  {
    company: 'Datadog',
    slug: 'datadog',
    source: 'company-datadog',
    provider: 'greenhouse',
    boardToken: 'datadog',
    careersUrl: 'https://careers.datadoghq.com/',
    enabled: true,
  },
  {
    company: 'Cloudflare',
    slug: 'cloudflare',
    source: 'company-cloudflare',
    provider: 'greenhouse',
    boardToken: 'cloudflare',
    careersUrl: 'https://www.cloudflare.com/careers/jobs/',
    enabled: true,
  },
  {
    company: 'Snowflake',
    slug: 'snowflake',
    source: 'company-snowflake',
    provider: 'custom-html',
    careersUrl: 'https://careers.snowflake.com/us/en/search-results?keywords=Software%20Engineer',
    enabled: true,
  },
  {
    company: 'Atlassian',
    slug: 'atlassian',
    source: 'company-atlassian',
    provider: 'custom-html',
    careersUrl: 'https://www.atlassian.com/company/careers/all-jobs',
    enabled: true,
  },
  {
    company: 'Notion',
    slug: 'notion',
    source: 'company-notion',
    provider: 'ashby',
    boardToken: 'notion',
    careersUrl: 'https://www.notion.com/careers',
    enabled: true,
  },
  {
    company: 'Canva',
    slug: 'canva',
    source: 'company-canva',
    provider: 'smartrecruiters',
    boardToken: 'Canva',
    careersUrl: 'https://www.canva.com/careers/jobs/',
    enabled: true,
  },
  {
    company: 'Rippling',
    slug: 'rippling',
    source: 'company-rippling',
    provider: 'custom-html',
    careersUrl: 'https://www.rippling.com/careers/open-roles',
    enabled: true,
  },
  {
    company: 'Rubrik',
    slug: 'rubrik',
    source: 'company-rubrik',
    provider: 'greenhouse',
    boardToken: 'rubrik',
    careersUrl: 'https://www.rubrik.com/company/careers',
    enabled: true,
  },
  {
    company: 'MongoDB',
    slug: 'mongodb',
    source: 'company-mongodb',
    provider: 'greenhouse',
    boardToken: 'mongodb',
    careersUrl: 'https://www.mongodb.com/company/careers/jobs',
    enabled: true,
  },
  {
    company: 'Redis',
    slug: 'redis',
    source: 'company-redis',
    provider: 'custom-html',
    careersUrl: 'https://redis.io/careers/jobs/',
    enabled: true,
  },
  {
    company: 'Nvidia',
    slug: 'nvidia',
    source: 'company-nvidia',
    provider: 'workday',
    careersUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    workday: {
      tenant: 'nvidia',
      site: 'NVIDIAExternalCareerSite',
      baseUrl: 'https://nvidia.wd5.myworkdayjobs.com',
    },
    enabled: true,
  },
  {
    company: 'Microsoft',
    slug: 'microsoft',
    source: 'company-microsoft',
    provider: 'custom-html',
    careersUrl: 'https://jobs.careers.microsoft.com/global/en/search',
    enabled: true,
  },
  {
    company: 'Amazon',
    slug: 'amazon',
    source: 'company-amazon',
    provider: 'amazon-jobs',
    careersUrl: 'https://www.amazon.jobs/en/search',
    enabled: true,
  },
  {
    company: 'Google',
    slug: 'google',
    source: 'company-google',
    provider: 'custom-html',
    careersUrl: 'https://www.google.com/about/careers/applications/jobs/results',
    enabled: true,
  },
  {
    company: 'Meta',
    slug: 'meta',
    source: 'company-meta',
    provider: 'custom-html',
    careersUrl: 'https://www.metacareers.com/jobs',
    enabled: true,
  },
  {
    company: 'Adobe',
    slug: 'adobe',
    source: 'company-adobe',
    provider: 'workday',
    careersUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced',
    workday: {
      tenant: 'adobe',
      site: 'external_experienced',
      baseUrl: 'https://adobe.wd5.myworkdayjobs.com',
    },
    enabled: true,
  },
  {
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
  },
  {
    company: 'Netflix',
    slug: 'netflix',
    source: 'company-netflix',
    provider: 'custom-html',
    careersUrl: 'https://explore.jobs.netflix.net/careers',
    enabled: true,
  },
  {
    company: 'Uber',
    slug: 'uber',
    source: 'company-uber',
    provider: 'custom-html',
    careersUrl: 'https://www.uber.com/us/en/careers/list/',
    enabled: true,
  },
  {
    company: 'Airbnb',
    slug: 'airbnb',
    source: 'company-airbnb',
    provider: 'greenhouse',
    boardToken: 'airbnb',
    careersUrl: 'https://careers.airbnb.com/positions/',
    enabled: true,
  },
  {
    company: 'Figma',
    slug: 'figma',
    source: 'company-figma',
    provider: 'greenhouse',
    boardToken: 'figma',
    careersUrl: 'https://www.figma.com/careers/',
    enabled: true,
  },
  {
    company: 'GitLab',
    slug: 'gitlab',
    source: 'company-gitlab',
    provider: 'greenhouse',
    boardToken: 'gitlab',
    careersUrl: 'https://about.gitlab.com/jobs/all-jobs/',
    enabled: true,
  },
  {
    company: 'Vercel',
    slug: 'vercel',
    source: 'company-vercel',
    provider: 'ashby',
    boardToken: 'vercel',
    careersUrl: 'https://vercel.com/careers',
    enabled: true,
  },
  {
    company: 'Linear',
    slug: 'linear',
    source: 'company-linear',
    provider: 'ashby',
    boardToken: 'linear',
    careersUrl: 'https://linear.app/careers',
    enabled: true,
  },
  {
    company: 'Brex',
    slug: 'brex',
    source: 'company-brex',
    provider: 'greenhouse',
    boardToken: 'brex',
    careersUrl: 'https://www.brex.com/careers',
    enabled: true,
  },
  {
    company: 'Coinbase',
    slug: 'coinbase',
    source: 'company-coinbase',
    provider: 'greenhouse',
    boardToken: 'coinbase',
    careersUrl: 'https://www.coinbase.com/careers/positions',
    enabled: true,
  },
  {
    company: 'Shopify',
    slug: 'shopify',
    source: 'company-shopify',
    provider: 'custom-html',
    careersUrl: 'https://www.shopify.com/careers/search',
    enabled: true,
  },
  {
    company: 'Twilio',
    slug: 'twilio',
    source: 'company-twilio',
    provider: 'greenhouse',
    boardToken: 'twilio',
    careersUrl: 'https://www.twilio.com/en-us/company/jobs',
    enabled: true,
  },
  {
    company: 'Palantir',
    slug: 'palantir',
    source: 'company-palantir',
    provider: 'lever',
    boardToken: 'palantir',
    careersUrl: 'https://www.palantir.com/careers/',
    enabled: true,
  },
];
