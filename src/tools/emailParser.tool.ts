import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { env } from '../config/env';

export interface ParsedEmail {
  subject: string;
  from: string;
  text: string;
  receivedAt: Date;
}

export class EmailParserTool {
  async fetchRecent(limit = 20): Promise<ParsedEmail[]> {
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

          imap.search(['ALL'], (searchErr, results) => {
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

            fetcher.on('message', (msg) => {
              let raw = '';

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                  raw += chunk.toString('utf8');
                });
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(raw);
                  emails.push({
                    subject: parsed.subject || '',
                    from: parsed.from?.text || '',
                    text: parsed.text || parsed.html || '',
                    receivedAt: parsed.date || new Date(),
                  });
                } catch {
                  // Ignore malformed messages; continue parsing the rest.
                }
              });
            });

            fetcher.once('error', reject);
            fetcher.once('end', () => {
              imap.end();
              resolve(emails);
            });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }
}
