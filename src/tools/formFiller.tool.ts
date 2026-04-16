import { FieldAnswer, FormField } from "../types";

export class FormFillerTool {
  toAnswers(fields: FormField[], mappedValues: Record<string, string>): FieldAnswer[] {
    return fields.map((field) => ({
      fieldName: field.name,
      value: mappedValues[field.name] ?? ""
    }));
  }

  validate(answers: FieldAnswer[], fields: FormField[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const field of fields) {
      if (!field.required) continue;
      const answer = answers.find((item) => item.fieldName === field.name)?.value?.trim();
      if (!answer) {
        errors.push(`Missing required field: ${field.name}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
