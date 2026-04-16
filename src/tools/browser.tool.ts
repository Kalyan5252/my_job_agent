import { chromium, type Page } from "playwright";
import { FieldAnswer, FormField } from "../types";

export class BrowserTool {
  async withPage<T>(url: string, action: (page: Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return await action(page);
    } finally {
      await page.close();
      await browser.close();
    }
  }

  async extractFormFields(url: string): Promise<FormField[]> {
    return this.withPage(url, async (page) => {
      return page.evaluate(() => {
        const selectable = Array.from(document.querySelectorAll("input, textarea, select"));
        return selectable.map((el) => {
          const input = el as HTMLInputElement;
          const label =
            input.getAttribute("aria-label") ||
            input.getAttribute("name") ||
            input.getAttribute("id") ||
            "field";

          return {
            name: input.name || input.id || label,
            label,
            type: input.type || input.tagName.toLowerCase(),
            required: input.required,
            placeholder: input.placeholder || undefined
          };
        });
      });
    });
  }

  async fillForm(url: string, answers: FieldAnswer[]): Promise<void> {
    await this.withPage(url, async (page) => {
      for (const answer of answers) {
        const selector = `[name="${answer.fieldName}"], #${answer.fieldName}`;
        const target = page.locator(selector).first();
        if (!(await target.count())) continue;

        const tagName = await target.evaluate((el) => el.tagName.toLowerCase());
        if (tagName === "select") {
          await target.selectOption({ label: answer.value }).catch(async () => {
            await target.selectOption({ value: answer.value }).catch(() => undefined);
          });
        } else {
          await target.fill(answer.value);
        }
      }

      // Guardrail: We intentionally do not auto-click submit in starter mode.
      // Toggle this behavior once your validations and human review flow are ready.
    });
  }
}
