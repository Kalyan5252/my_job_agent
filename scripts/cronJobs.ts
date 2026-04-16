import cron from "node-cron";
import { env } from "../src/config/env";
import { DiscoveryWorkflow } from "../src/workflows/discovery.workflow";
import { TrackingWorkflow } from "../src/workflows/tracking.workflow";
import { connectMongo } from "../src/db/mongo/client";
import { initPostgres } from "../src/db/postgres/client";

async function main() {
  await connectMongo();
  await initPostgres();

  const discovery = new DiscoveryWorkflow();
  const tracking = new TrackingWorkflow();

  const profile = {
    role: env.DEFAULT_JOB_ROLE,
    skills: env.DEFAULT_JOB_SKILLS.split(",").map((s) => s.trim()),
    experience: env.DEFAULT_JOB_EXPERIENCE
  };

  cron.schedule("0 */6 * * *", async () => {
    const result = await discovery.run(profile);
    console.log(`[CRON][Discovery] total=${result.total} apply=${result.applyCount}`);
  });

  cron.schedule("*/20 * * * *", async () => {
    const result = await tracking.run();
    console.log(`[CRON][Tracking] updates=${result.updates}`);
  });

  console.log("Cron jobs running: discovery every 6h, tracking every 20m");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
