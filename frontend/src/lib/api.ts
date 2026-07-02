export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000';

export interface QueueSnapshot {
  name: string;
  enabled: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface ManualReviewItem {
  id: string;
  status: 'blocked_manual_review' | 'user_reviewing' | 'resume_requested' | 'resolved';
  blockerCode: string;
  blockerReason: string;
  company: string;
  title: string;
  applyUrl?: string;
  currentUrl?: string;
  screenshotPath?: string;
  lastStep: string;
  resumeToken: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface DashboardSummary {
  generatedAt: string;
  sources: {
    configured: number;
    enabled: number;
    targetMet: boolean;
    providers: Record<string, number>;
  };
  queues: QueueSnapshot[];
  workers: {
    redisEnabled: boolean;
    scrapeQueue: string;
    scoreQueue: string;
    writeQueue: string;
  };
  reliability: {
    retries: string;
    manualReviewOpen: number;
    manualReviewTotal: number;
  };
  manualReviews: ManualReviewItem[];
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const response = await fetch(`${API_BASE_URL}/dashboard/summary`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Dashboard API failed with ${response.status}`);
  }
  return response.json() as Promise<DashboardSummary>;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
