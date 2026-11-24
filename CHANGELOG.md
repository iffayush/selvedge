# Changelog

## 1.0.0 (2026-11-24)

The first release of **Selvedge**: résumés, finished properly.

### Download

Download **`Selvedge-Setup-1.0.0.exe`** below and run it. It installs for your Windows user only (no admin rights needed) and adds Start menu and Desktop shortcuts. Windows 10 or 11, 64-bit.

The installer isn't code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**. On first run, Selvedge asks for a free Gemini API key and links you to Google AI Studio to create one.

### What it does

- **ATS read of your résumé.** Contact details, section headings, length, quantified bullets, action verbs, date formats, multi-column layouts, tables and icon characters.
- **Keyword match against the job description.** Split into required, important and nice to have, with ticks for the skills you genuinely have.
- **Scores.** ATS score, keyword match and shortlist confidence, each with its breakdown and a before → after view.
- **How to get shortlisted.** Prioritised tips, strengths, gaps, red flags, and **projects to build** to close your gaps.
- **Tailored résumé, editable.** Saved as a one-page, ATS-friendly PDF with clickable links.
- **Honesty checks.** Flags skills and numbers in the tailored version that weren't in your original, and blocks saving until `[X%]` placeholders are filled in.
- **Organised saving.** Each application goes in `Company\Role (date)\` with the PDF, the job description, your original file and an ATS report. History lets you reopen any of them.
- **Gemini models.** Uses gemini-3.6-flash by default, with automatic fallback to 3.5-flash and 3.5-flash-lite.

### Notes

- Your API key is stored only on your computer, encrypted with your Windows account.
- On Gemini's free tier, Google may use what you send, including your résumé text, to improve its products.
