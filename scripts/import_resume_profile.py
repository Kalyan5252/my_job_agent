#!/usr/bin/env python3
from pathlib import Path
import argparse
import json
import re

from pypdf import PdfReader


def normalize_url(raw: str, default_prefix: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if "." in value:
        return f"https://{value}"
    return f"{default_prefix}{value}"


def grab(pattern: str, src: str, flags: int = 0) -> str:
    match = re.search(pattern, src, flags)
    return match.group(1).strip() if match else ""


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract candidate profile from a resume PDF.")
    parser.add_argument("--pdf", required=True, help="Path to source PDF file")
    parser.add_argument("--out-text", default="data/profile/resume.txt", help="Path for extracted text output")
    parser.add_argument(
        "--out-profile", default="data/profile/candidateProfile.json", help="Path for structured profile JSON output"
    )
    args = parser.parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    out_text = Path(args.out_text).expanduser().resolve()
    out_profile = Path(args.out_profile).expanduser().resolve()

    out_text.parent.mkdir(parents=True, exist_ok=True)
    out_profile.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(pdf_path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    out_text.write_text(text, encoding="utf-8")

    name = grab(r"^\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+)", text, re.M)
    email = grab(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", text)
    phone = grab(r"(\+?\d[\d\s\-]{8,}\d)", text)
    linkedin = grab(r"(?:https?://)?((?:www\.)?linkedin\.com/[^\s\|)]+)", text)
    github = grab(r"(?:https?://)?((?:www\.)?github\.com/[^\s\|)]+)", text)

    skills_dict = [
        "TypeScript",
        "JavaScript",
        "Node.js",
        "Express.js",
        "MongoDB",
        "PostgreSQL",
        "Redis",
        "AWS",
        "GCP",
        "Docker",
        "GraphQL",
        "REST",
        "LangChain",
        "LLM",
        "RAG",
        "React",
        "Next.js",
        "Python",
        "Java",
        "C++",
        "Go",
        "Git",
        "Jest",
        "Linux/Unix",
        "SQS",
        "Lambda",
    ]
    text_norm = text.lower().replace(".", "")
    skills = [s for s in skills_dict if s.lower().replace(".", "") in text_norm]

    education = []
    experience = []
    for line in text.splitlines():
        value = line.strip()
        if not value:
            continue
        low = value.lower()
        if any(key in low for key in ["b.tech", "btech", "bachelor", "university", "college", "cgpa", "gpa"]):
            education.append(value)
        if any(key in low for key in ["intern", "internship", "engineer", "developer", "contract", "full-time"]):
            experience.append(value)

    profile = {
        "name": name,
        "email": email,
        "phone": phone,
        "linkedin": normalize_url(linkedin, "https://linkedin.com/in/"),
        "github": normalize_url(github, "https://github.com/"),
        "skills": skills,
        "educationHighlights": education[:20],
        "experienceHighlights": experience[:30],
        "resumeFilePath": str(pdf_path),
        "generatedFrom": str(pdf_path),
    }
    out_profile.write_text(json.dumps(profile, indent=2), encoding="utf-8")

    print(f"Extracted text: {out_text}")
    print(f"Extracted profile: {out_profile}")


if __name__ == "__main__":
    main()
