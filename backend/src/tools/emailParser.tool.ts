import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { env } from '../config/env';

export interface ParsedEmail {
  messageId: string;
  subject: string;
  from: string;
  text: string;
  receivedAt: Date;
}

export class EmailParserTool {
  isConfigured(): boolean {
    return Boolean(env.IMAP_USER && env.IMAP_PASSWORD);
  }

  /** Fetch messages received in the last `sinceDays` days (newest `limit`). */
  async fetchRecent(limit = 100, sinceDays = env.TRACKING_LOOKBACK_DAYS): Promise<ParsedEmail[]> {
    if (!env.IMAP_USER || !env.IMAP_PASSWORD) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const emails: ParsedEmail[] = [];
      const imap = new Imap({
        user: env.IMAP_USER!,
        password: env.IMAP_PASSWORD!,
        host: env.IMAP_HOST,
        port: env.IMAP_PORT,
        tls: env.IMAP_TLS,
      });

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) {
            reject(err);
            return;
          }

          const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
          imap.search([['SINCE', since]], (searchErr, results) => {
            if (searchErr) {
              reject(searchErr);
              return;
            }

            const latest = results.slice(Math.max(0, results.length - limit));
            if (latest.length === 0) {
              imap.end();
              resolve([]);
              return;
            }

            const fetcher = imap.fetch(latest, { bodies: '' });
            const pending: Array<Promise<void>> = [];

            fetcher.on('message', (msg) => {
              let raw = '';

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                  raw += chunk.toString('utf8');
                });
              });

              msg.once('end', () => {
                pending.push(parseOne());
              });
              const parseOne = async () => {
                try {
                  const parsed = await simpleParser(raw);
                  const fallbackId = `${parsed.date?.toISOString() ?? ''}|${parsed.from?.text ?? ''}|${parsed.subject ?? ''}`;
                  emails.push({
                    messageId: parsed.messageId || fallbackId,
                    subject: parsed.subject || '',
                    from: parsed.from?.text || '',
                    text: parsed.text || (typeof parsed.html === 'string' ? parsed.html : ''),
                    receivedAt: parsed.date || new Date(),
                  });
                } catch {
                  // Ignore malformed messages; continue parsing the rest.
                }
              };
            });

            fetcher.once('error', reject);
            fetcher.once('end', () => {
              // Parsing is async; wait for every message before resolving.
              Promise.all(pending).then(() => {
                imap.end();
                resolve(emails);
              }, reject);
            });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }
}
