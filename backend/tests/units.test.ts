import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword } from '../src/auth/auth.service';
import {
  matchEmailToCompany,
  normalizeCompany,
  pickApplication,
} from '../src/agents/tracker.agent';
import { buildCandidateProfileFromText } from '../src/services/profile.service';

test('password hashes verify only the right password', () => {
  const hash = hashPassword('a-very-long-password');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('a-very-long-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
  assert.equal(verifyPassword('anything', 'garbage'), false);
});

test('company normalization strips legal suffixes', () => {
  assert.equal(normalizeCompany('Acme Technologies Pvt. Ltd.'), 'acme');
  assert.equal(normalizeCompany('Razorpay Software Private Limited'), 'razorpay');
});

test('emails only match exactly one company', () => {
  const companies = ['Acme Technologies', 'Globex', 'Initech'];
  assert.equal(
    matchEmailToCompany(
      {
        subject: 'Your application to Globex',
        from: 'Talent <no-reply@greenhouse.io>',
        text: 'Thanks for applying',
      },
      companies,
    ),
    'Globex',
  );
  // Sender domain match.
  assert.equal(
    matchEmailToCompany(
      { subject: 'Interview invitation', from: 'hr@acme.com', text: '' },
      companies,
    ),
    'Acme Technologies',
  );
  // Generic subject words must not match everything (old bug).
  assert.equal(
    matchEmailToCompany(
      { subject: 'Thank you for applying', from: 'jobs@lever.co', text: 'We received it' },
      companies,
    ),
    undefined,
  );
  // Two companies mentioned -> ambiguous -> no update.
  assert.equal(
    matchEmailToCompany(
      { subject: 'Globex and Initech newsletter', from: 'news@example.com', text: '' },
      companies,
    ),
    undefined,
  );
});

test('pickApplication prefers the role mentioned in the email', () => {
  const apps = [
    { id: 1, company: 'Globex', role: 'Frontend Engineer', status: 'applied' },
    { id: 2, company: 'Globex', role: 'Backend Engineer', status: 'applied' },
  ];
  assert.equal(
    pickApplication(apps, { subject: 'Backend Engineer - next steps', text: '' })?.id,
    2,
  );
  assert.equal(pickApplication(apps, { subject: 'Update', text: '' })?.id, 1);
});

test('resume text is turned into a candidate profile', () => {
  const text = [
    'Jane Doe',
    'jane.doe@example.com | +91 98765 43210 | linkedin.com/in/janedoe | github.com/janedoe',
    'B.Tech Computer Science, Example University',
    'Backend Developer Intern - built Node.js and PostgreSQL services with Redis and Docker',
    'Skills: TypeScript, React, Next.js, AWS',
  ].join('\n');
  const profile = buildCandidateProfileFromText(text, '/data/resume/primary.pdf');
  assert.equal(profile.name, 'Jane Doe');
  assert.equal(profile.email, 'jane.doe@example.com');
  assert.equal(profile.linkedin, 'https://linkedin.com/in/janedoe');
  assert.ok(profile.skills?.includes('Node.js'));
  assert.ok(profile.skills?.includes('TypeScript'));
  assert.ok(!profile.skills?.includes('Go'), 'short skills must match whole words only');
  assert.equal(profile.educationHighlights?.length, 1);
});

test('secure store encrypts at rest and round-trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-'));
  process.env.DATA_ENCRYPTION_KEY = 'k'.repeat(40);
  // env is parsed at import time, so import after setting the key.
  const { env } = await import('../src/config/env');
  (env as { DATA_ENCRYPTION_KEY?: string }).DATA_ENCRYPTION_KEY = 'k'.repeat(40);
  const store = await import('../src/lib/secureStore');
  const file = path.join(dir, 'state.json');
  store.writeSecureJson(file, { cookies: [{ name: 'li_at', value: 'secret' }] });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.startsWith('JAENC1:'));
  assert.ok(!raw.includes('secret'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(store.readSecureJson(file), { cookies: [{ name: 'li_at', value: 'secret' }] });
  fs.rmSync(dir, { recursive: true, force: true });
});
