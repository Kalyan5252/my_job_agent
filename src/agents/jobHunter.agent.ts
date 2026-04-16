import { jobsCollection } from "../db/mongo/client";
import { enqueueApplication } from "../queues/apply.queue";
import { LLMService } from "../services/llm.service";
import { ScoringService } from "../services/scoring.service";
import { ScraperTool } from "../tools/scraper.tool";
import { JobProfile, ScoredJob } from "../types";

export class JobHunterAgent {
  private readonly scraper = new ScraperTool();
  private readonly llm = new LLMService();
  private readonly scoring = new ScoringService(this.llm);

  async run(profile: JobProfile): Promise<ScoredJob[]> {
    const jobs = await this.scraper.fetchJobs(profile);
    const scored: ScoredJob[] = [];

    for (const job of jobs) {
      const enriched = await this.scoring.scoreAndDecide(profile, job);
      scored.push(enriched);
    }

    const coll = await jobsCollection();
    if (scored.length > 0) {
      await coll.insertMany(scored);
    }

    const eligible = scored.filter((job) => job.apply);
    for (const job of eligible) {
      await enqueueApplication({ job, profile });
    }

    return scored;
  }
}
