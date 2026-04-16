import { JobProfile } from "../types";

export class ResumeService {
  summarizeForRole(profile: JobProfile): string {
    const skills = profile.skills.join(", ");
    return `Candidate targeting ${profile.role} with ${profile.experience} experience level. Core skills: ${skills}.`;
  }
}
