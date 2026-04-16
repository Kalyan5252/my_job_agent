import { TrackerAgent } from "../agents/tracker.agent";

export class TrackingWorkflow {
  private readonly tracker = new TrackerAgent();

  async run(): Promise<{ updates: number }> {
    const updates = await this.tracker.run();
    return { updates };
  }
}
