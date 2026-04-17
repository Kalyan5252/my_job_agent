import { chromium } from "playwright";
import { CompanyTier, JobPosting, JobProfile, JobSearchQuery } from "../types";
import { GroqScraperService } from "../services/groqScraper.service";
import { env } from "../config/env";

interface NormalizedJob extends Omit<JobPosting, "location"> {
  location: string;
  strategy: "api" | "html" | "browser";
}

export class ScraperTool {
  private readonly groqScraper = new GroqScraperService();

  async fetchJobs(input: JobProfile | JobSearchQuery): Promise<JobPosting[]> {
    const query = this.normalizeQuery(input);
    this.log(`Starting scrape: role="${query.role}", location="${query.location || "any"}"`);

    const apiJobs = await this.fetchFromApis(query);
    this.log(`API strategy returned ${apiJobs.length} jobs`);

    const indianJobs = await this.fetchFromIndianSources(query);
    this.log(`Indian-source strategy returned ${indianJobs.length} jobs`);

    const htmlJobs = await this.fetchFromHtml(query);
    this.log(`HTML strategy returned ${htmlJobs.length} jobs`);

    // Playwright fallback is triggered when simpler strategies return too few jobs.
    const browserJobs = apiJobs.length + htmlJobs.length < 8 ? await this.fetchFromBrowser(query) : [];
    if (browserJobs.length > 0) this.log(`Browser strategy returned ${browserJobs.length} jobs`);

    const merged = this.dedupeJobs([...apiJobs, ...indianJobs, ...htmlJobs, ...browserJobs]);
    const actionable = merged.filter((job) => this.hasValidApplyUrl(job.applyUrl));
    if (merged.length !== actionable.length) {
      this.log(`Dropped ${merged.length - actionable.length} jobs without valid apply URL`);
    }

    if (actionable.length === 0) {
      if (!env.SCRAPER_ALLOW_SYNTHETIC_FALLBACK) {
        this.log("All strategies returned 0 actionable jobs. Synthetic fallback disabled.");
        return [];
      }

      const synthetic = this.syntheticFallbackJobs(query);
      this.log(`All strategies returned 0 actionable jobs. Using ${synthetic.length} synthetic fallback jobs.`);
      return synthetic.slice(0, query.maxResults ?? 50);
    }

    const prioritized = this.prioritizeJobs(actionable, query);
    if (prioritized.length === 0) {
      if (!env.SCRAPER_ALLOW_SYNTHETIC_FALLBACK) {
        this.log("No jobs left after filters. Synthetic fallback disabled.");
        return [];
      }

      const synthetic = this.syntheticFallbackJobs(query);
      this.log(`No jobs left after filters. Using ${synthetic.length} India-focused synthetic fallback jobs.`);
      return synthetic.slice(0, query.maxResults ?? 50);
    }

    this.log(
      `Total deduped jobs: ${merged.length}, actionable jobs: ${actionable.length}, prioritized jobs: ${prioritized.length}`
    );
    return prioritized.slice(0, query.maxResults ?? 50);
  }

  private normalizeQuery(input: JobProfile | JobSearchQuery): JobSearchQuery {
    if ("experience" in input) {
      return {
        role: input.role,
        location: "Remote",
        skills: input.skills,
        filters: {
          remoteOnly: true,
          postedWithinHours: 24 * 14,
          country: "India",
          locations: this.defaultIndiaLocations()
        },
        priority: {
          companyTierOrder: ["top", "mid", "other"],
          highPayFirst: true
        },
        maxResults: 40
      };
    }

    return {
      ...input,
      maxResults: input.maxResults ?? 40,
      filters: {
        remoteOnly: input.filters?.remoteOnly ?? true,
        postedWithinHours: input.filters?.postedWithinHours ?? 24 * 14,
        employmentType: input.filters?.employmentType,
        country: input.filters?.country ?? "India",
        locations: input.filters?.locations ?? this.defaultIndiaLocations(),
        minSalaryLpa: input.filters?.minSalaryLpa
      },
      priority: {
        companyTierOrder: input.priority?.companyTierOrder ?? ["top", "mid", "other"],
        highPayFirst: input.priority?.highPayFirst ?? true
      }
    };
  }

  // Strategy 1: API scraping (fast + reliable).
  private async fetchFromApis(query: JobSearchQuery): Promise<NormalizedJob[]> {
    const [remotive, arbeitnow] = await Promise.all([
      this.scrapeRemotiveApi(query),
      this.scrapeArbeitnowApi(query)
    ]);

    return [...remotive, ...arbeitnow];
  }

  // Strategy 1b: India-focused sources and aggregators.
  private async fetchFromIndianSources(query: JobSearchQuery): Promise<NormalizedJob[]> {
    if (!env.INDIAN_JOB_SOURCES_ENABLED) {
      this.log("Indian sources disabled (INDIAN_JOB_SOURCES_ENABLED=false)");
      return [];
    }

    const [adzuna, jsearch, linkedin] = await Promise.all([
      this.scrapeAdzunaIndiaApi(query),
      this.scrapeRapidApiJSearch(query),
      this.scrapeLinkedInPublic(query)
    ]);

    return [...adzuna, ...jsearch, ...linkedin];
  }

  private async scrapeAdzunaIndiaApi(query: JobSearchQuery): Promise<NormalizedJob[]> {
    if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) {
      this.log("Adzuna skipped: missing ADZUNA_APP_ID or ADZUNA_APP_KEY");
      return [];
    }

    const where = (query.filters?.locations?.[0] || query.location || "India").trim();
    const url =
      `https://api.adzuna.com/v1/api/jobs/in/search/1` +
      `?app_id=${encodeURIComponent(env.ADZUNA_APP_ID)}` +
      `&app_key=${encodeURIComponent(env.ADZUNA_APP_KEY)}` +
      `&results_per_page=50` +
      `&what=${encodeURIComponent(query.role)}` +
      `&where=${encodeURIComponent(where)}` +
      `&content-type=application/json`;

    this.log(`Adzuna request: ${url.replace(env.ADZUNA_APP_KEY, "***")}`);
    const data = await this.fetchJson<{
      results?: Array<{
        id?: string;
        title?: string;
        company?: { display_name?: string };
        location?: { display_name?: string; area?: string[] };
        description?: string;
        redirect_url?: string;
        salary_min?: number;
        salary_max?: number;
      }>;
    }>(url);

    const results = data?.results ?? [];
    this.log(`Adzuna raw results: ${results.length}`);
    const out: NormalizedJob[] = [];

    for (const job of results) {
      if (!job.title || !job.company?.display_name || !job.description || !job.redirect_url) continue;
      const salaryLpa = this.toLpa(job.salary_min, job.salary_max);

      out.push({
        source: "adzuna-india",
        externalId: `adzuna-${job.id ?? this.slugify(`${job.company.display_name}-${job.title}`)}`,
        title: job.title,
        company: job.company.display_name,
        companyTier: this.inferCompanyTier(job.company.display_name),
        salaryLpa,
        location:
          job.location?.display_name ||
          (job.location?.area || []).join(", ") ||
          query.filters?.locations?.[0] ||
          "India",
        description: this.cleanText(job.description),
        requirements: this.inferRequirementsFromText(job.description, query.skills),
        applyUrl: job.redirect_url,
        rawData: { strategy: "api", provider: "adzuna", job },
        strategy: "api"
      });
    }

    return out;
  }

  private async scrapeRapidApiJSearch(query: JobSearchQuery): Promise<NormalizedJob[]> {
    if (!env.RAPIDAPI_KEY) {
      this.log("JSearch skipped: missing RAPIDAPI_KEY");
      return [];
    }

    const where = (query.filters?.locations?.[0] || query.location || "India").trim();
    const requestUrl =
      `https://${env.RAPIDAPI_HOST}/search` +
      `?query=${encodeURIComponent(`${query.role} in ${where}`)}` +
      `&page=1&num_pages=1&country=in&date_posted=all`;

    const res = await this.fetchWithTimeout(requestUrl, 15_000, {
      "X-RapidAPI-Key": env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": env.RAPIDAPI_HOST
    });
    if (!res) {
      this.log("JSearch request failed: no response");
      return [];
    }
    if (!res.ok) {
      this.log(`JSearch request failed: status ${res.status}`);
      return [];
    }

    let data: {
      data?: Array<{
        job_id?: string;
        job_title?: string;
        employer_name?: string;
        job_city?: string;
        job_country?: string;
        job_description?: string;
        job_apply_link?: string;
        job_publisher?: string;
        job_min_salary?: number;
        job_max_salary?: number;
      }>;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      this.log("JSearch response parse failed");
      return [];
    }

    const rows = data?.data ?? [];
    this.log(`JSearch raw rows: ${rows.length}`);
    const out: NormalizedJob[] = [];

    for (const row of rows) {
      if (!row.job_title || !row.employer_name || !row.job_description || !row.job_apply_link) continue;
      const location = [row.job_city, row.job_country].filter(Boolean).join(", ") || "India";
      const salaryLpa = this.toLpa(row.job_min_salary, row.job_max_salary);

      out.push({
        source: `jsearch-${(row.job_publisher || "aggregator").toLowerCase()}`,
        externalId: `jsearch-${row.job_id ?? this.slugify(`${row.employer_name}-${row.job_title}`)}`,
        title: row.job_title,
        company: row.employer_name,
        companyTier: this.inferCompanyTier(row.employer_name),
        salaryLpa,
        location,
        description: this.cleanText(row.job_description),
        requirements: this.inferRequirementsFromText(row.job_description, query.skills),
        applyUrl: row.job_apply_link,
        rawData: { strategy: "api", provider: "jsearch", row },
        strategy: "api"
      });
    }

    return out;
  }

  private async scrapeLinkedInPublic(query: JobSearchQuery): Promise<NormalizedJob[]> {
    if (!env.LINKEDIN_SCRAPER_ENABLED) {
      this.log("LinkedIn public scraper disabled (LINKEDIN_SCRAPER_ENABLED=false)");
      return [];
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    const out: NormalizedJob[] = [];
    const locations = query.filters?.locations?.length ? query.filters.locations.slice(0, 2) : ["India"];

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      for (const loc of locations) {
        const url =
          `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query.role)}` +
          `&location=${encodeURIComponent(loc)}`;
        this.log(`LinkedIn public scrape: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded" });

        const rows = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll("li .base-card"));
          return cards.slice(0, 25).map((card) => {
            const title = card.querySelector(".base-search-card__title")?.textContent?.trim() || "";
            const company = card.querySelector(".base-search-card__subtitle")?.textContent?.trim() || "";
            const location = card.querySelector(".job-search-card__location")?.textContent?.trim() || "";
            const applyUrl =
              (card.querySelector("a.base-card__full-link") as HTMLAnchorElement | null)?.href || "";
            return { title, company, location, applyUrl };
          });
        });

        for (const row of rows) {
          if (!row.title || !row.company || !row.applyUrl) continue;
          out.push({
            source: "linkedin-public",
            externalId: `linkedin-${this.slugify(`${row.company}-${row.title}-${loc}`)}`,
            title: row.title,
            company: row.company,
            companyTier: this.inferCompanyTier(row.company),
            salaryLpa: this.estimateSalaryLpa(`${row.title} ${row.company}`),
            location: row.location || loc,
            description: `${row.title} at ${row.company}.`,
            requirements: query.skills?.slice(0, 6) || [],
            applyUrl: row.applyUrl,
            rawData: { strategy: "browser", provider: "linkedin-public", row },
            strategy: "browser"
          });
        }
      }

      return out;
    } catch (error) {
      this.log(`LinkedIn public scrape failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return [];
    } finally {
      if (browser) await browser.close();
    }
  }

  private async scrapeRemotiveApi(query: JobSearchQuery): Promise<NormalizedJob[]> {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query.role)}`;
    this.log(`API request: ${url}`);
    const data = await this.fetchJson<{
      jobs?: Array<{
        id?: number;
        title?: string;
        company_name?: string;
        candidate_required_location?: string;
        description?: string;
        tags?: string[];
        url?: string;
      }>;
    }>(url);

    const jobs = data?.jobs ?? [];
    const normalized: NormalizedJob[] = [];

    for (const job of jobs) {
      if (!job.title || !job.company_name || !job.description) continue;

      normalized.push({
        externalId: `remotive-${String(job.id ?? job.url ?? job.title)}`,
        source: "remotive",
        title: job.title,
        company: job.company_name,
        companyTier: this.inferCompanyTier(job.company_name),
        salaryLpa: this.estimateSalaryLpa(`${job.title} ${job.description} ${(job.tags || []).join(" ")}`),
        location: job.candidate_required_location || query.location || "Remote",
        description: this.cleanText(job.description),
        requirements: (job.tags || []).slice(0, 8),
        applyUrl: job.url,
        rawData: job,
        strategy: "api"
      });
    }

    return normalized;
  }

  private async scrapeArbeitnowApi(query: JobSearchQuery): Promise<NormalizedJob[]> {
    const data = await this.fetchJson<{
      data?: Array<{
        slug?: string;
        title?: string;
        company_name?: string;
        location?: string;
        description?: string;
        tags?: string[];
        job_types?: string[];
        url?: string;
      }>;
    }>("https://www.arbeitnow.com/api/job-board-api");

    const allJobs = data?.data ?? [];
    const roleTokens = this.tokenize(query.role);

    const normalized: NormalizedJob[] = [];
    for (const job of allJobs) {
      const title = (job.title || "").toLowerCase();
      const titleMatchesRole = roleTokens.some((token) => token.length >= 3 && title.includes(token));
      if (!titleMatchesRole) continue;
      if (!job.title || !job.company_name || !job.description) continue;

      normalized.push({
        externalId: `arbeitnow-${job.slug ?? job.url ?? job.title}`,
        source: "arbeitnow",
        title: job.title,
        company: job.company_name,
        companyTier: this.inferCompanyTier(job.company_name),
        salaryLpa: this.estimateSalaryLpa(`${job.title} ${job.description} ${(job.tags || []).join(" ")}`),
        location: job.location || query.location || "Remote",
        description: this.cleanText(job.description),
        requirements: [...(job.tags || []), ...(job.job_types || [])].slice(0, 8),
        applyUrl: job.url,
        rawData: job,
        strategy: "api"
      });
    }

    return normalized;
  }

  // Strategy 2: HTML scraping using DOM-like selectors via regex extraction.
  private async fetchFromHtml(query: JobSearchQuery): Promise<NormalizedJob[]> {
    const url = `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(query.role)}`;
    this.log(`HTML request: ${url}`);
    const html = await this.fetchText(url);
    if (!html) return [];

    const cards = this.extractBlocks(html, /<li[^>]*class="[^"]*feature[^"]*"[^>]*>[\s\S]*?<\/li>/gi);

    const normalized: NormalizedJob[] = [];

    for (const [index, card] of cards.entries()) {
      const title = this.extractFirst(card, /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const company = this.extractFirst(card, /<span[^>]*class="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const location = this.extractFirst(card, /<span[^>]*class="[^"]*region[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const href = this.extractFirst(card, /href="([^"]+)"/i);

      if (!title || !company || !href) continue;

      const applyUrl = href.startsWith("http") ? href : `https://weworkremotely.com${href}`;
      normalized.push({
        externalId: `wwr-${index}-${this.slugify(title)}`,
        source: "weworkremotely",
        title: this.cleanText(title),
        company: this.cleanText(company),
        companyTier: this.inferCompanyTier(this.cleanText(company)),
        salaryLpa: this.estimateSalaryLpa(`${title} ${card}`),
        location: this.cleanText(location || query.location || "Remote"),
        description: `Role discovered via HTML scraping from We Work Remotely for query: ${query.role}`,
        requirements: query.skills?.slice(0, 6) || [],
        applyUrl,
        rawData: { snippet: card.slice(0, 1_000) },
        strategy: "html"
      });
    }

    if (normalized.length >= 5 || !this.groqScraper.isEnabled()) {
      return normalized;
    }

    this.log("HTML selector extraction low; trying Groq scraper assist");
    const groqJobs = await this.groqScraper.extractJobsFromHtml("weworkremotely", html, query);
    const enrichedGroq: NormalizedJob[] = groqJobs.map((job) => ({
      ...job,
      location: job.location || query.location || "Remote",
      companyTier: this.inferCompanyTier(job.company),
      salaryLpa: job.salaryLpa ?? this.estimateSalaryLpa(`${job.title} ${job.description}`),
      strategy: "html"
    }));

    return [...normalized, ...enrichedGroq];
  }

  // Strategy 3: Browser automation fallback for dynamic pages.
  private async fetchFromBrowser(query: JobSearchQuery): Promise<NormalizedJob[]> {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
      this.log("Browser fallback started");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(
        `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(query.role)}`,
        { waitUntil: "domcontentloaded" }
      );

      const jobs = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("li.feature"));
        return cards.slice(0, 30).map((card, index) => {
          const title = card.querySelector("span.title")?.textContent?.trim() || "";
          const company = card.querySelector("span.company")?.textContent?.trim() || "";
          const location = card.querySelector("span.region")?.textContent?.trim() || "Remote";
          const href = (card.querySelector("a") as HTMLAnchorElement | null)?.getAttribute("href") || "";

          return {
            idx: index,
            title,
            company,
            location,
            href
          };
        });
      });

      const normalized: NormalizedJob[] = [];
      for (const job of jobs) {
        if (!job.title || !job.company || !job.href) continue;

        normalized.push({
          externalId: `wwr-browser-${job.idx}-${this.slugify(job.title)}`,
          source: "weworkremotely",
          title: job.title,
          company: job.company,
          companyTier: this.inferCompanyTier(job.company),
          salaryLpa: this.estimateSalaryLpa(`${job.title} ${job.company}`),
          location: job.location || query.location || "Remote",
          description: `Role discovered via browser automation fallback for query: ${query.role}`,
          requirements: query.skills?.slice(0, 6) || [],
          applyUrl: job.href.startsWith("http") ? job.href : `https://weworkremotely.com${job.href}`,
          rawData: job,
          strategy: "browser"
        });
      }

      return normalized;
    } catch (error) {
      this.log(`Browser strategy failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return [];
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  private dedupeJobs(jobs: NormalizedJob[]): JobPosting[] {
    const map = new Map<string, JobPosting>();

    for (const job of jobs) {
      const key = this.makeDedupeKey(job);
      if (!map.has(key)) {
        map.set(key, {
          source: job.source,
          externalId: job.externalId,
          title: job.title,
          company: job.company,
          companyTier: job.companyTier,
          salaryLpa: job.salaryLpa,
          location: job.location,
          description: job.description,
          requirements: job.requirements,
          applyUrl: job.applyUrl,
          rawData: {
            ...((job.rawData as Record<string, unknown>) || {}),
            strategy: job.strategy
          }
        });
      }
    }

    return [...map.values()];
  }

  private makeDedupeKey(job: JobPosting): string {
    const byUrl = (job.applyUrl || "").trim().toLowerCase();
    if (byUrl) return byUrl;

    return `${job.source}:${job.company}:${job.title}`.toLowerCase();
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const res = await this.fetchWithTimeout(url);
    if (!res) {
      this.log(`Request failed (no response): ${url}`);
      return null;
    }
    if (!res.ok) {
      this.log(`Request failed (${res.status}): ${url}`);
      return null;
    }

    try {
      return (await res.json()) as T;
    } catch (error) {
      this.log(`JSON parse failed for ${url}: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    const res = await this.fetchWithTimeout(url);
    if (!res) {
      this.log(`Request failed (no response): ${url}`);
      return null;
    }
    if (!res.ok) {
      this.log(`Request failed (${res.status}): ${url}`);
      return null;
    }

    try {
      return await res.text();
    } catch (error) {
      this.log(`Text parse failed for ${url}: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    }
  }

  private async fetchWithTimeout(
    url: string,
    timeoutMs = 12_000,
    extraHeaders?: Record<string, string>
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        headers: {
          "User-Agent": "my-job-agent/0.1 (+hybrid-scraper)",
          ...(extraHeaders || {})
        },
        signal: controller.signal
      });
    } catch (error) {
      this.log(`Fetch error for ${url}: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private syntheticFallbackJobs(query: JobSearchQuery): JobPosting[] {
    const role = query.role || "Backend Engineer";
    const skills = (query.skills || ["Node.js", "TypeScript", "MongoDB"]).slice(0, 6);
    const preferredLocations = query.filters?.locations?.length
      ? query.filters.locations
      : this.defaultIndiaLocations();
    return [
      {
        source: "seed-fallback",
        externalId: `seed-${this.slugify(role)}-1`,
        title: `${role} (Fallback)`,
        company: "Microsoft",
        companyTier: "top",
        salaryLpa: 42,
        location: preferredLocations[0] || "Hyderabad",
        description: `Fallback job generated because external sources returned no data for role "${role}".`,
        requirements: skills,
        applyUrl: "https://example.com/apply/fallback-1",
        rawData: { strategy: "fallback", reason: "no_external_results" }
      },
      {
        source: "seed-fallback",
        externalId: `seed-${this.slugify(role)}-2`,
        title: `${role} - Platform (Fallback)`,
        company: "Atlassian",
        companyTier: "top",
        salaryLpa: 38,
        location: preferredLocations[1] || "Bengaluru",
        description: `Fallback platform role for ${role}.`,
        requirements: skills,
        applyUrl: "https://example.com/apply/fallback-2",
        rawData: { strategy: "fallback", reason: "no_external_results" }
      },
      {
        source: "seed-fallback",
        externalId: `seed-${this.slugify(role)}-3`,
        title: `${role} - Product (Fallback)`,
        company: "Razorpay",
        companyTier: "mid",
        salaryLpa: 30,
        location: preferredLocations[2] || "Pune",
        description: `Fallback mid-tier role for ${role}.`,
        requirements: skills,
        applyUrl: "https://example.com/apply/fallback-3",
        rawData: { strategy: "fallback", reason: "no_external_results" }
      }
    ];
  }

  private tokenize(input: string): string[] {
    return input
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private log(message: string): void {
    console.log(`[scraper] ${message}`);
  }

  private hasValidApplyUrl(value: string | undefined): boolean {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private inferRequirementsFromText(text: string, seedSkills?: string[]): string[] {
    const inferred = this.tokenize(text)
      .filter((token) =>
        [
          "node",
          "nodejs",
          "typescript",
          "javascript",
          "mongodb",
          "postgresql",
          "redis",
          "aws",
          "azure",
          "gcp",
          "docker",
          "kubernetes",
          "api",
          "microservices",
          "react",
          "python",
          "java",
          "golang"
        ].includes(token)
      )
      .slice(0, 8);
    const merged = [...(seedSkills || []).map((s) => s.toLowerCase()), ...inferred];
    return this.dedupeCaseInsensitive(merged);
  }

  private toLpa(min?: number, max?: number): number | undefined {
    const nums = [min, max].filter((x): x is number => typeof x === "number" && x > 0);
    if (nums.length === 0) return undefined;
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    // Adzuna/JSearch are often annual local currency; for India this can already be INR.
    if (avg > 100000) return Math.round(avg / 100000);
    if (avg > 1000) return Math.round(avg / 1000);
    return Math.round(avg);
  }

  private dedupeCaseInsensitive(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const key = value.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(value.trim());
    }
    return out;
  }

  private prioritizeJobs(jobs: JobPosting[], query: JobSearchQuery): JobPosting[] {
    const preferredLocations = (query.filters?.locations ?? []).map((l) => l.toLowerCase());
    const country = (query.filters?.country ?? "").toLowerCase().trim();
    const tierOrder = query.priority?.companyTierOrder ?? ["top", "mid", "other"];
    const tierRank = new Map<CompanyTier, number>(
      tierOrder.map((tier, idx) => [tier, idx] as const)
    );
    const highPayFirst = query.priority?.highPayFirst ?? true;
    const minSalaryLpa = query.filters?.minSalaryLpa ?? 0;

    const byLocation = preferredLocations.length
      ? jobs.filter((job) => this.matchesPreferredLocation(job.location, preferredLocations))
      : jobs;

    const byCountry = country
      ? byLocation.filter((job) => this.matchesCountry(job.location, country))
      : byLocation;

    const locationScoped = byCountry;

    const salaryScoped = locationScoped.filter((job) => (job.salaryLpa ?? 0) >= minSalaryLpa);
    const filtered = salaryScoped.length > 0 ? salaryScoped : locationScoped;

    return filtered.sort((a, b) => {
      const aTier = tierRank.get(a.companyTier ?? "other") ?? 99;
      const bTier = tierRank.get(b.companyTier ?? "other") ?? 99;
      if (aTier !== bTier) return aTier - bTier;

      if (highPayFirst) {
        const salaryDelta = (b.salaryLpa ?? 0) - (a.salaryLpa ?? 0);
        if (salaryDelta !== 0) return salaryDelta;
      }

      return (a.title || "").localeCompare(b.title || "");
    });
  }

  private matchesPreferredLocation(location: string | undefined, preferred: string[]): boolean {
    if (!location) return false;
    const value = location.toLowerCase();
    return preferred.some((city) => {
      if (city === "bangalore" || city === "bengaluru") {
        return value.includes("bangalore") || value.includes("bengaluru");
      }
      if (city === "hyderabad") return value.includes("hyderabad");
      if (city === "pune") return value.includes("pune");
      if (city === "chennai") return value.includes("chennai");
      if (city === "india") return value.includes("india");
      if (city === "remote") return value.includes("remote");
      return value.includes(city);
    });
  }

  private matchesCountry(location: string | undefined, country: string): boolean {
    if (!location) return false;
    const value = location.toLowerCase();

    if (country === "india") {
      return (
        value.includes("india") ||
        value.includes("hyderabad") ||
        value.includes("bangalore") ||
        value.includes("bengaluru") ||
        value.includes("pune") ||
        value.includes("chennai")
      );
    }

    return value.includes(country);
  }

  private inferCompanyTier(company: string): CompanyTier {
    const c = company.toLowerCase();
    const topTier = [
      "google",
      "microsoft",
      "amazon",
      "meta",
      "apple",
      "adobe",
      "atlassian",
      "salesforce",
      "uber",
      "nvidia",
      "oracle",
      "walmart"
    ];
    const midTier = [
      "razorpay",
      "swiggy",
      "zomato",
      "phonepe",
      "freshworks",
      "zoho",
      "paytm",
      "meesho",
      "cred",
      "postman",
      "browserstack",
      "thoughtworks"
    ];

    if (topTier.some((name) => c.includes(name))) return "top";
    if (midTier.some((name) => c.includes(name))) return "mid";
    return "other";
  }

  private estimateSalaryLpa(text: string): number | undefined {
    const value = text.toLowerCase();

    // Example matches: "30 lpa", "25 lakh", "₹40,00,000", "INR 24,00,000"
    const lpaMatch = value.match(/(\\d{1,3})(?:\\s*[-to]{1,3}\\s*\\d{1,3})?\\s*(lpa|lakh)/i);
    if (lpaMatch) return Number(lpaMatch[1]);

    const inrMatch = value.match(/(?:₹|inr)\\s*([\\d,]{5,})/i);
    if (inrMatch) {
      const annual = Number(inrMatch[1].replace(/,/g, ""));
      if (!Number.isNaN(annual) && annual > 0) return Math.round(annual / 100000);
    }

    // Heuristic by seniority keywords when explicit salary is absent.
    if (/(staff|principal|lead)/i.test(value)) return 40;
    if (/(senior|sde\\s*2|sde\\s*3)/i.test(value)) return 28;
    if (/(backend engineer|software engineer|full stack)/i.test(value)) return 18;
    if (/(intern|fresher|junior)/i.test(value)) return 8;

    return undefined;
  }

  private defaultIndiaLocations(): string[] {
    return ["Hyderabad", "Bengaluru", "Pune", "Chennai"];
  }

  private extractBlocks(input: string, pattern: RegExp): string[] {
    const matches = input.match(pattern);
    return matches ?? [];
  }

  private extractFirst(input: string, pattern: RegExp): string | null {
    const m = input.match(pattern);
    return m?.[1] ? this.cleanText(m[1]) : null;
  }

  private cleanText(input: string): string {
    return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  private slugify(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }
}
