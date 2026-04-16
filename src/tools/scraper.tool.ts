import { chromium } from "playwright";
import { JobPosting, JobProfile, JobSearchQuery } from "../types";

interface NormalizedJob extends Omit<JobPosting, "location"> {
  location: string;
  strategy: "api" | "html" | "browser";
}

export class ScraperTool {
  async fetchJobs(input: JobProfile | JobSearchQuery): Promise<JobPosting[]> {
    const query = this.normalizeQuery(input);
    this.log(`Starting scrape: role="${query.role}", location="${query.location || "any"}"`);

    const apiJobs = await this.fetchFromApis(query);
    this.log(`API strategy returned ${apiJobs.length} jobs`);

    const htmlJobs = await this.fetchFromHtml(query);
    this.log(`HTML strategy returned ${htmlJobs.length} jobs`);

    // Playwright fallback is triggered when simpler strategies return too few jobs.
    const browserJobs = apiJobs.length + htmlJobs.length < 8 ? await this.fetchFromBrowser(query) : [];
    if (browserJobs.length > 0) this.log(`Browser strategy returned ${browserJobs.length} jobs`);

    const merged = this.dedupeJobs([...apiJobs, ...htmlJobs, ...browserJobs]);
    if (merged.length === 0) {
      const seed = this.seedFallbackJobs(query);
      this.log(`All strategies returned 0. Using ${seed.length} fallback jobs.`);
      return seed.slice(0, query.maxResults ?? 50);
    }

    this.log(`Total deduped jobs: ${merged.length}`);
    return merged.slice(0, query.maxResults ?? 50);
  }

  private normalizeQuery(input: JobProfile | JobSearchQuery): JobSearchQuery {
    if ("experience" in input) {
      return {
        role: input.role,
        location: "Remote",
        skills: input.skills,
        filters: {
          remoteOnly: true,
          postedWithinHours: 24 * 14
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
        employmentType: input.filters?.employmentType
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
        location: this.cleanText(location || query.location || "Remote"),
        description: `Role discovered via HTML scraping from We Work Remotely for query: ${query.role}`,
        requirements: query.skills?.slice(0, 6) || [],
        applyUrl,
        rawData: { snippet: card.slice(0, 1_000) },
        strategy: "html"
      });
    }

    return normalized;
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

  private async fetchWithTimeout(url: string, timeoutMs = 12_000): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        headers: {
          "User-Agent": "my-job-agent/0.1 (+hybrid-scraper)"
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

  private seedFallbackJobs(query: JobSearchQuery): JobPosting[] {
    const role = query.role || "Backend Engineer";
    const skills = (query.skills || ["Node.js", "TypeScript", "MongoDB"]).slice(0, 6);
    return [
      {
        source: "seed-fallback",
        externalId: `seed-${this.slugify(role)}-1`,
        title: `${role} (Fallback)`,
        company: "Starter Labs",
        location: query.location || "Remote",
        description: `Fallback job generated because external sources returned no data for role "${role}".`,
        requirements: skills,
        applyUrl: "https://example.com/apply/fallback-1",
        rawData: { strategy: "fallback", reason: "no_external_results" }
      },
      {
        source: "seed-fallback",
        externalId: `seed-${this.slugify(role)}-2`,
        title: `${role} - Platform (Fallback)`,
        company: "BuildOps",
        location: query.location || "Remote",
        description: `Fallback platform role for ${role}.`,
        requirements: skills,
        applyUrl: "https://example.com/apply/fallback-2",
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
