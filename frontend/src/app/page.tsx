import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDot,
  Database,
  GitBranch,
  Inbox,
  Network,
  RadioTower,
  RefreshCcw,
  ShieldAlert,
  Terminal,
  TimerReset,
} from 'lucide-react';
import { DigestButton, DiscoveryLauncher, ReviewActions } from '@/components/dashboard-actions';
import { fetchDashboardSummary, type DashboardSummary, type QueueSnapshot } from '@/lib/api';

export default async function DashboardPage() {
  const summary = await loadSummary();
  const openReviews = summary.manualReviews.filter((review) => review.status !== 'resolved');
  const failedJobs = summary.queues.reduce((total, queue) => total + queue.failed, 0);
  const activeJobs = summary.queues.reduce((total, queue) => total + queue.active, 0);
  const waitingJobs = summary.queues.reduce((total, queue) => total + queue.waiting, 0);
  const providerRows = Object.entries(summary.sources.providers).sort((a, b) => b[1] - a[1]);

  return (
    <main className="min-h-screen bg-[#f8f8fb] text-slate-950">
      <div className="grid min-h-screen lg:grid-cols-[16rem_1fr]">
        <aside className="hidden border-r border-slate-200 bg-white/80 px-4 py-5 backdrop-blur lg:block">
          <div className="mb-8 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-violet-600 text-white">
              <Network size={17} />
            </div>
            <div>
              <div className="text-sm font-semibold">Job Agent</div>
              <div className="text-xs text-slate-500">distributed console</div>
            </div>
          </div>

          <nav className="space-y-1 text-sm">
            <NavItem active icon={<Terminal size={15} />} label="Operations" />
            <NavItem icon={<Boxes size={15} />} label="Sources" />
            <NavItem icon={<Database size={15} />} label="Queues" />
            <NavItem icon={<ShieldAlert size={15} />} label="Review" />
          </nav>

          <div className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span>Redis</span>
              <span className={summary.workers.redisEnabled ? 'text-emerald-700' : 'text-slate-400'}>
                {summary.workers.redisEnabled ? 'connected' : 'disabled'}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className={summary.workers.redisEnabled ? 'h-full w-full bg-violet-600' : 'h-full w-1/4 bg-slate-300'}
              />
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/86 px-4 py-3 backdrop-blur md:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                  <GitBranch size={14} />
                  production / discovery
                </div>
                <h1 className="mt-1 text-xl font-semibold">Automation Control</h1>
              </div>
              <div className="flex items-center gap-2">
                <DigestButton />
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                  {new Date(summary.generatedAt).toLocaleTimeString()}
                </div>
              </div>
            </div>
          </header>

          <div className="grid gap-5 px-4 py-5 md:px-6 xl:grid-cols-[1fr_21rem]">
            <div className="min-w-0 space-y-5">
              <section className="rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Terminal size={16} className="text-violet-700" />
                    Run discovery
                  </div>
                </div>
                <div className="p-4">
                  <DiscoveryLauncher />
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-4">
                <Signal label="Sources" value={summary.sources.enabled} detail="enabled" state={summary.sources.targetMet ? 'ok' : 'warn'} />
                <Signal label="Waiting" value={waitingJobs} detail="queued jobs" />
                <Signal label="Active" value={activeJobs} detail="workers busy" />
                <Signal label="Failed" value={failedJobs} detail="needs retry" state={failedJobs > 0 ? 'bad' : 'ok'} />
              </section>

              <section className="rounded-lg border border-slate-200 bg-white">
                <SectionHeader
                  icon={<RadioTower size={16} />}
                  title="Queue pipeline"
                  meta={summary.reliability.retries}
                />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium uppercase text-slate-500">
                        <th className="px-4 py-3">Queue</th>
                        <th className="px-3 py-3">State</th>
                        <th className="px-3 py-3 text-right">Waiting</th>
                        <th className="px-3 py-3 text-right">Active</th>
                        <th className="px-3 py-3 text-right">Delayed</th>
                        <th className="px-3 py-3 text-right">Failed</th>
                        <th className="px-4 py-3 text-right">Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.queues.map((queue) => (
                        <QueueRow key={queue.name} queue={queue} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 bg-white">
                <SectionHeader
                  icon={<Boxes size={16} />}
                  title="Source registry"
                  meta={`${summary.sources.configured} configured · ${summary.sources.enabled} enabled`}
                />
                <div className="grid gap-px bg-slate-200 sm:grid-cols-2 xl:grid-cols-3">
                  {providerRows.map(([provider, count]) => (
                    <div key={provider} className="bg-white p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <span className="font-mono text-xs uppercase text-slate-500">{provider}</span>
                        <span className="rounded-md bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700">
                          {count}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-violet-600"
                          style={{ width: `${Math.max(12, (count / Math.max(summary.sources.enabled, 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <aside className="space-y-5">
              <section className="rounded-lg border border-slate-200 bg-white">
                <SectionHeader icon={<Inbox size={16} />} title="Review inbox" meta={`${openReviews.length} open`} />
                <div className="p-4">
                  {openReviews.length === 0 ? (
                    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-8 text-center text-sm text-slate-500">
                      No human blockers waiting.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {openReviews.map((review) => (
                        <article key={review.id} className="rounded-md border border-slate-200 p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <Badge tone="warn">{review.status.replaceAll('_', ' ')}</Badge>
                            <span className="text-xs text-slate-400">{review.lastStep}</span>
                          </div>
                          <h3 className="font-medium">{review.title}</h3>
                          <p className="text-sm text-slate-500">{review.company}</p>
                          <p className="mt-2 text-sm text-slate-600">{review.blockerCode}</p>
                          <div className="mt-3">
                            <ReviewActions id={review.id} currentUrl={review.currentUrl || review.applyUrl} />
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 bg-white">
                <SectionHeader icon={<Activity size={16} />} title="Runtime" meta="current snapshot" />
                <div className="space-y-3 p-4 text-sm">
                  <RuntimeLine label="Scrape worker" value={summary.workers.scrapeQueue} />
                  <RuntimeLine label="Score worker" value={summary.workers.scoreQueue} />
                  <RuntimeLine label="Write worker" value={summary.workers.writeQueue} />
                  <RuntimeLine label="Manual review" value={`${summary.reliability.manualReviewOpen}/${summary.reliability.manualReviewTotal}`} />
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 bg-[#fbfbfd] p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <TimerReset size={15} className="text-violet-700" />
                  Handoff protocol
                </div>
                <ol className="space-y-2 text-sm text-slate-600">
                  <li>1. Worker pauses on CAPTCHA/login.</li>
                  <li>2. Dashboard records blocker context.</li>
                  <li>3. User reviews and resumes safely.</li>
                </ol>
              </section>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

async function loadSummary(): Promise<DashboardSummary> {
  try {
    return await fetchDashboardSummary();
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      sources: { configured: 0, enabled: 0, targetMet: false, providers: {} },
      queues: [],
      workers: {
        redisEnabled: false,
        scrapeQueue: 'discovery-scrape',
        scoreQueue: 'discovery-score',
        writeQueue: 'discovery-write',
      },
      reliability: { retries: 'Backend unavailable', manualReviewOpen: 0, manualReviewTotal: 0 },
      manualReviews: [],
    };
  }
}

function NavItem({ icon, label, active }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <div
      className={
        active
          ? 'flex items-center gap-2 rounded-md bg-violet-50 px-3 py-2 font-medium text-violet-700'
          : 'flex items-center gap-2 rounded-md px-3 py-2 text-slate-600 hover:bg-slate-50'
      }
    >
      {icon}
      {label}
    </div>
  );
}

function SectionHeader({ icon, title, meta }: { icon: React.ReactNode; title: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-violet-700">{icon}</span>
        {title}
      </div>
      {meta ? <div className="truncate text-xs text-slate-500">{meta}</div> : null}
    </div>
  );
}

function Signal({
  label,
  value,
  detail,
  state = 'neutral',
}: {
  label: string;
  value: number;
  detail: string;
  state?: 'neutral' | 'ok' | 'warn' | 'bad';
}) {
  const icon =
    state === 'ok' ? (
      <CheckCircle2 size={15} className="text-emerald-600" />
    ) : state === 'bad' || state === 'warn' ? (
      <AlertTriangle size={15} className={state === 'bad' ? 'text-rose-600' : 'text-amber-600'} />
    ) : (
      <CircleDot size={15} className="text-violet-600" />
    );

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        {icon}
      </div>
      <div className="font-mono text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function QueueRow({ queue }: { queue: QueueSnapshot }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Database size={15} className="text-slate-400" />
          <span className="font-medium">{queue.name}</span>
        </div>
      </td>
      <td className="px-3 py-3">
        <Badge tone={queue.enabled ? 'ok' : 'muted'}>{queue.enabled ? 'connected' : 'redis off'}</Badge>
      </td>
      <NumberCell value={queue.waiting} />
      <NumberCell value={queue.active} />
      <NumberCell value={queue.delayed} />
      <NumberCell value={queue.failed} danger={queue.failed > 0} />
      <NumberCell value={queue.completed} edge />
    </tr>
  );
}

function NumberCell({ value, danger, edge }: { value: number; danger?: boolean; edge?: boolean }) {
  return (
    <td className={edge ? 'px-4 py-3 text-right font-mono' : 'px-3 py-3 text-right font-mono'}>
      <span className={danger ? 'text-rose-600' : 'text-slate-700'}>{value}</span>
    </td>
  );
}

function RuntimeLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">{value}</span>
    </div>
  );
}

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'muted' }) {
  const classes =
    tone === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-slate-50 text-slate-600';

  return <span className={`rounded-md border px-2 py-1 text-xs ${classes}`}>{children}</span>;
}
