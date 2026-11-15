'use client';

import { useRouter } from 'next/navigation';
import { Play, RotateCcw, Send, UserCheck } from 'lucide-react';
import { postJson } from '@/lib/api';

export function ReviewActions({ id, currentUrl }: { id: string; currentUrl?: string }) {
  const router = useRouter();

  async function run(action: 'open' | 'resume' | 'resolve') {
    await postJson(`/manual-reviews/${id}/${action}`, {});
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button className="icon-button" onClick={() => run('open')} title="Mark as being reviewed">
        <UserCheck size={16} />
      </button>
      {currentUrl ? (
        <a className="text-button" href={currentUrl} target="_blank" rel="noreferrer">
          Open URL
        </a>
      ) : null}
      <button className="text-button" onClick={() => run('resume')}>
        <RotateCcw size={15} />
        Resume
      </button>
      <button className="text-button" onClick={() => run('resolve')}>
        <Play size={15} />
        Resolve
      </button>
    </div>
  );
}

export function DigestButton() {
  const router = useRouter();

  async function sendDigest() {
    await postJson('/digests/email/send');
    router.refresh();
  }

  return (
    <button className="text-button" onClick={sendDigest}>
      <Send size={15} />
      Send digest
    </button>
  );
}

export function DiscoveryLauncher() {
  const router = useRouter();

  async function scheduleDiscovery(formData: FormData) {
    const role = String(formData.get('role') || 'Backend Engineer');
    const country = String(formData.get('country') || 'India');
    const maxResults = Number(formData.get('maxResults') || 40);
    await postJson('/workflows/discovery/schedule', {
      role,
      country,
      maxResults,
      companyTierOrder: ['top', 'mid', 'other'],
      highPayFirst: true,
    });
    router.refresh();
  }

  return (
    <form action={scheduleDiscovery} className="grid gap-2 lg:grid-cols-[1fr_11rem_6rem_auto]">
      <label className="command-field">
        <span>role</span>
        <input name="role" defaultValue="Backend Engineer" aria-label="Role" />
      </label>
      <label className="command-field">
        <span>country</span>
        <input name="country" defaultValue="India" aria-label="Country" />
      </label>
      <label className="command-field">
        <span>limit</span>
        <input name="maxResults" defaultValue="40" aria-label="Max results" />
      </label>
      <button className="primary-button" type="submit">
        <Play size={16} />
        Queue
      </button>
    </form>
  );
}
