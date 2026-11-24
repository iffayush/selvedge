// Human-readable ATS report saved next to each application (ats-report.md).

const icon = { pass: '✅', warn: '⚠️', fail: '❌' };
const statusWord = { met: 'Met', partial: 'Partial', missing: 'Missing' };

function scoreLine(label, before, after) {
  if (after === undefined || after === null) return `| ${label} | ${before ?? '–'} | – |`;
  const diff = after - (before ?? 0);
  const sign = diff > 0 ? `+${diff}` : `${diff}`;
  return `| ${label} | ${before ?? '–'} | ${after} (${sign}) |`;
}

export function buildReport({ company, jobTitle, date, model, analysis = {}, before, after, changes = [] }) {
  const out = [];
  out.push(`# ATS report: ${jobTitle || 'Role'} at ${company || 'Unknown Company'}`);
  out.push('');
  out.push(`Saved ${date}${model ? ` · analysed with ${model}` : ''}`);
  out.push('');

  out.push('## Scores');
  out.push('');
  out.push('| Score | Original resume | Tailored resume |');
  out.push('|---|---|---|');
  out.push(scoreLine('ATS score', before?.ats?.score, after?.ats?.score));
  out.push(scoreLine('Keyword match', before?.keywords?.score, after?.keywords?.score));
  out.push(scoreLine('Shortlist confidence', before?.confidence?.score, after?.confidence?.score));
  const conf = after?.confidence ?? before?.confidence;
  if (conf) {
    out.push('');
    out.push(`Shortlist confidence is **${conf.label}** (${conf.score}/100).`);
    if (conf.capped) out.push(`Capped at 60 because a required qualification is missing: ${conf.blockers.join('; ')}.`);
  }
  if (analysis.fitRationale) {
    out.push('');
    out.push(`> ${analysis.fitRationale}`);
  }
  out.push('');

  const checks = after?.checks ?? before?.checks ?? [];
  if (checks.length) {
    out.push('## ATS checks (tailored resume)');
    out.push('');
    for (const c of checks) out.push(`- ${icon[c.status] ?? ''} **${c.label}**: ${c.detail}`);
    out.push('');
  }

  const matches = after?.keywords?.matches ?? before?.keywords?.matches ?? [];
  if (matches.length) {
    const fmt = (m) => `${m.term}${m.importance === 'must' ? ' *(required)*' : ''}`;
    out.push('## Keywords');
    out.push('');
    out.push(`**Matched (${matches.filter((m) => m.matched).length}):** ${matches.filter((m) => m.matched).map(fmt).join(', ') || 'none'}`);
    out.push('');
    out.push(`**Still missing (${matches.filter((m) => !m.matched).length}):** ${matches.filter((m) => !m.matched).map(fmt).join(', ') || 'none'}`);
    out.push('');
  }

  if (analysis.requirements?.length) {
    out.push('## Job requirements');
    out.push('');
    out.push('| Requirement | Required | Status | Evidence |');
    out.push('|---|---|---|---|');
    for (const r of analysis.requirements) {
      const ev = (r.evidence || '').replace(/\|/g, '/');
      out.push(`| ${r.text.replace(/\|/g, '/')} | ${r.mustHave ? 'Yes' : 'No'} | ${statusWord[r.status] ?? r.status} | ${ev ? `"${ev}"` : '–'} |`);
    }
    out.push('');
  }

  if (analysis.shortlistTips?.length) {
    out.push('## How to get shortlisted');
    out.push('');
    for (const t of analysis.shortlistTips) out.push(`- **[${t.priority}]** ${t.tip}${t.why ? `  \n  _${t.why}_` : ''}`);
    out.push('');
  }

  if (analysis.projectIdeas?.length) {
    const effort = { weekend: 'about a weekend', one_to_two_weeks: '1–2 weeks', month: 'about a month' };
    out.push('## Projects to build to qualify better');
    out.push('');
    for (const p of analysis.projectIdeas) {
      out.push(`### ${p.title} (${effort[p.effort] ?? p.effort})`);
      out.push('');
      out.push(p.whatToBuild);
      out.push('');
      if (p.skills?.length) out.push(`- **Shows:** ${p.skills.join(', ')}`);
      if (p.gapsClosed?.length) out.push(`- **Closes:** ${p.gapsClosed.join('; ')}`);
      if (p.resumeLine) out.push(`- **Resume line once done:** ${p.resumeLine}`);
      out.push('');
    }
  }

  if (analysis.otherWaysToQualify?.length) {
    out.push('## Other ways to qualify');
    out.push('');
    for (const w of analysis.otherWaysToQualify) out.push(`- **${w.suggestion}**${w.why ? `: ${w.why}` : ''}`);
    out.push('');
  }

  const lists = [
    ['Strengths', analysis.strengths],
    ['Gaps', analysis.gaps],
    ['Red flags', analysis.redFlags],
  ];
  for (const [title, items] of lists) {
    if (!items?.length) continue;
    out.push(`## ${title}`);
    out.push('');
    for (const i of items) out.push(`- ${i}`);
    out.push('');
  }

  if (changes.length) {
    out.push('## What was changed in the tailored resume');
    out.push('');
    for (const c of changes) out.push(`- **${c.section}:** ${c.what}${c.why ? ` (${c.why})` : ''}`);
    out.push('');
  }
  return out.join('\n');
}
