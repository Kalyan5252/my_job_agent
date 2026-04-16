import { pgPool } from "../db/postgres/client";
import { LLMService } from "../services/llm.service";
import { EmailParserTool } from "../tools/emailParser.tool";

export class TrackerAgent {
  private readonly llm = new LLMService();
  private readonly emailParser = new EmailParserTool();

  async run(): Promise<number> {
    const emails = await this.emailParser.fetchRecent();
    let updates = 0;

    for (const email of emails) {
      const status = await this.llm.classifyEmailStatus(`${email.subject}\n${email.text}`);
      if (status === "unknown") continue;

      const companyGuess = extractCompanyHint(email.subject, email.from);
      const result = await pgPool.query(
        `
        UPDATE applications
        SET status = $1, updated_at = NOW(), notes = COALESCE(notes, '') || $2
        WHERE LOWER(company) LIKE LOWER($3)
        `,
        [status, `\nStatus updated from email: ${email.subject}`, `%${companyGuess}%`]
      );
      updates += result.rowCount ?? 0;
    }

    return updates;
  }
}

function extractCompanyHint(subject: string, from: string): string {
  const subjectToken = subject.split(" ").find((token) => /[a-zA-Z]{3,}/.test(token));
  if (subjectToken) return clean(subjectToken);

  const domain = from.split("@")[1] || "";
  const domainName = domain.split(".")[0] || "";
  return clean(domainName || "company");
}

function clean(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").trim();
}
