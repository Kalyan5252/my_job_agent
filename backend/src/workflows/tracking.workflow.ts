import { TrackerAgent, TrackingResult } from '../agents/tracker.agent';

export class TrackingWorkflow {
  private readonly tracker = new TrackerAgent();

  async run(): Promise<TrackingResult> {
    return this.tracker.run();
  }
}
