import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { DashboardService } from './dashboard.service';

export class EmailDigestService {
  constructor(private readonly dashboard = new DashboardService()) {}

  async buildDigest() {
    const snapshot = await this.dashboard.snapshot();
    const openReviews = snapshot.manualReviews.filter((item) => item.status !== 'resolved');
    const openCount = snapshot.reliability.manualReviewOpen;
    const failedQueues = snapshot.queues.reduce((sum, queue) => sum + queue.failed, 0);

    const subject = `Job Agent Digest: ${openCount} review item(s), ${failedQueues} failed queue job(s)`;
    const lines = [
      `Generated: ${snapshot.generatedAt}`,
      `Sources: ${snapshot.sources.enabled}/${snapshot.sources.configured} enabled`,
      `Manual reviews open: ${openCount}`,
      `Queue failures: ${failedQueues}`,
      '',
      'Queues:',
      ...snapshot.queues.map(
        (queue) =>
          `- ${queue.name}: waiting=${queue.waiting}, active=${queue.active}, failed=${queue.failed}, delayed=${queue.delayed}`,
      ),
      '',
      'Manual review:',
      ...(openReviews.length
        ? openReviews.map((item) => `- ${item.company} ${item.title}: ${item.blockerCode}`)
        : ['- none']),
    ];

    return {
      subject,
      text: lines.join('\n'),
      snapshot,
    };
  }

  async sendDigest() {
    const digest = await this.buildDigest();
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.DIGEST_RECIPIENT_EMAIL) {
      return {
        sent: false,
        reason: 'SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and DIGEST_RECIPIENT_EMAIL are required.',
        digest,
      };
    }

    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: env.DIGEST_RECIPIENT_EMAIL,
      subject: digest.subject,
      text: digest.text,
    });

    return { sent: true, digest };
  }
}
