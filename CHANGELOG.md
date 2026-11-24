# Changelog

## 1.1.0 (2026-11-24)

Download **`Selvedge-Setup-1.1.0.exe`** below and run it. It upgrades an existing install in place, keeping your settings, key and saved applications.

### Cover letters

- **New Cover letter view.** Start from a saved application (its job description and tailored résumé), or paste a new job description and choose a résumé.
- **A few personal questions first.** Gemini asks about your story, why this company, and an analogy or interest, all specific to your résumé and the role. It also recommends paragraphs or paragraphs with bullets, and you choose.
- **Company research.** Uses Google Search grounding when your Gemini plan allows it. Otherwise Selvedge reads Wikipedia, the company's website and recent Google News headlines, and Gemini picks 3 to 5 facts, each with its sources. You choose up to two to mention.
- **Humaniser.** After the draft, one or two AI editing passes fix what five local checks flag: sentence rhythm, specific detail, stock phrases, typography and voice. A final scrub removes em dashes, curly quotes and invisible characters. Any edit that changes a number or adds a skill is discarded.
- **Honesty checks.** Flags skills and numbers that aren't in your résumé, your answers or the company facts.
- **Saved with the application.** The cover letter PDF (one page, same letterhead as the résumé), a plain-text copy, the research notes and your answers. History shows which applications have a letter.

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
