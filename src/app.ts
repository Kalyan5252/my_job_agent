import Fastify from "fastify";
import { env } from "./config/env";
import { DiscoveryWorkflow } from "./workflows/discovery.workflow";
import { TrackingWorkflow } from "./workflows/tracking.workflow";
import { ApplyWorkflow } from "./workflows/apply.workflow";
import { JobProfile, ScoredJob } from "./types";

export function createApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  const discovery = new DiscoveryWorkflow();
  const tracking = new TrackingWorkflow();
  const apply = new ApplyWorkflow();

  app.get("/health", async () => ({ ok: true, service: "job-agent", at: new Date().toISOString() }));

  app.post<{ Body: Partial<JobProfile> }>("/workflows/discovery/run", async (request) => {
    const profile: JobProfile = {
      role: request.body.role || env.DEFAULT_JOB_ROLE,
      skills: request.body.skills || env.DEFAULT_JOB_SKILLS.split(",").map((s) => s.trim()),
      experience: request.body.experience || env.DEFAULT_JOB_EXPERIENCE
    };

    return discovery.run(profile);
  });

  app.post("/workflows/tracking/run", async () => tracking.run());

  app.post<{ Body: { job: ScoredJob; profile: JobProfile } }>("/workflows/application/run", async (request) => {
    await apply.run(request.body);
    return { success: true };
  });

  return app;
}
