import {
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from './discovery.types';

export interface DiscoveryTaskDispatcher {
  dispatchScrape(task: DiscoveryScrapeTask): Promise<void>;
  dispatchScore(task: DiscoveryScoreTask): Promise<void>;
  dispatchWrite(task: DiscoveryWriteTask): Promise<void>;
}
