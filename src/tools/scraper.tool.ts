import { JobPosting, JobProfile } from "../types";

export class ScraperTool {
  async fetchJobs(profile: JobProfile): Promise<JobPosting[]> {
    // Placeholder adapter layer. Replace this with platform APIs and site scrapers.
    return [
      {
        source: "demo",
        externalId: "demo-1",
        title: `${profile.role} - Node.js`,
        company: "Acme Labs",
        location: "Remote",
        description: "Build backend services using Node.js, MongoDB, and AI tooling.",
        requirements: ["Node.js", "MongoDB", "REST APIs", "AI integration"],
        applyUrl: "https://example.com/apply/demo-1",
        rawData: { provider: "seed" }
      },
      {
        source: "demo",
        externalId: "demo-2",
        title: `${profile.role} - Platform`,
        company: "Nova Systems",
        location: "Hybrid",
        description: "Design scalable systems, queues, and distributed workers in TypeScript.",
        requirements: ["TypeScript", "Redis", "PostgreSQL"],
        applyUrl: "https://example.com/apply/demo-2",
        rawData: { provider: "seed" }
      }
    ];
  }
}
