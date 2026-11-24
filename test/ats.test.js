import test from 'node:test';
import assert from 'node:assert/strict';
import {
  termRegex, matchKeywords, keywordCoverage, formatChecks, formatScore, computeScores,
  resumeToText, findPlaceholders, statementLines, hasMetric, unconfirmedAdditions,
} from '../lib/ats.js';

test('keyword regex handles tech names with symbols', () => {
  assert.ok(termRegex('C++').test('Wrote services in C++ and Go'));
  assert.ok(!termRegex('C').test('Wrote services in C++ and Go'));
  assert.ok(termRegex('C#').test('Backend in C#/.NET'));
  assert.ok(termRegex('.NET').test('Backend in C#/.NET'));
  assert.ok(termRegex('Node.js').test('APIs with Node.js.'));
  assert.ok(!termRegex('Java').test('JavaScript only'));
  assert.ok(termRegex('JavaScript').test('JavaScript only'));
  assert.ok(termRegex('machine learning').test('Machine-Learning pipelines'));
  assert.ok(termRegex('API').test('Built REST APIs'));
  assert.ok(!termRegex('R').test('Used React daily'));
  assert.ok(termRegex('R').test('Languages: SQL, Python, R'));
});

test('variants count as a match and report what matched', () => {
  const [m] = matchKeywords('Deployed on AWS', [{ term: 'Amazon Web Services', variants: ['AWS'], importance: 'must' }]);
  assert.equal(m.matched, true);
  assert.equal(m.matchedAs, 'AWS');
});

test('keyword coverage weighs required terms higher', () => {
  const kws = [
    { term: 'SQL', variants: [], importance: 'must' },
    { term: 'Python', variants: [], importance: 'important' },
    { term: 'Looker', variants: [], importance: 'nice' },
  ];
  const cov = keywordCoverage(matchKeywords('SQL and Looker', kws));
  // matched weight 3 + 1 out of 6
  assert.equal(cov.score, 67);
  assert.deepEqual(cov.byImportance.must, { matched: 1, total: 1 });
  assert.equal(cov.matched, 2);
});

test('format checks flag missing contact details and layout problems', () => {
  const checks = formatChecks('Experience\n• Did things\nEducation\nSkills', { multiColumn: true, hasTables: true, oddChars: 2 });
  const by = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  assert.equal(by.email, 'fail');
  assert.equal(by.phone, 'warn');
  assert.equal(by.columns, 'warn');
  assert.equal(by.tables, 'warn');
  assert.equal(by.chars, 'warn');
  assert.equal(by.sections, 'pass');
  assert.ok(formatScore(checks) < 70);
});

test('metric detection ignores dates but counts decimals', () => {
  assert.equal(hasMetric('Led migration Jan 2020 – Mar 2021'), false);
  assert.equal(hasMetric('Cut costs by 30%'), true);
  assert.equal(hasMetric('Reached 0.81 AUC'), true);
});

test('only experience and project bullets count as achievement statements', () => {
  const text = 'Experience\n• Built a thing\n• Led a team of 4\n• Shipped v2\nCertifications\n• AWS Certified\nLanguages\n• English';
  assert.deepEqual(statementLines(text), ['Built a thing', 'Led a team of 4', 'Shipped v2']);
});

test('confidence combines parts and is capped by a missing hard requirement', () => {
  const keywords = [{ term: 'SQL', variants: [], importance: 'must' }];
  const base = { text: 'jane@example.com +91 98765 43210\nExperience\n• Built SQL reports\nEducation\nSkills\nSQL', meta: {}, keywords, fitScore: 90 };
  const ok = computeScores({ ...base, requirements: [{ text: 'SQL', mustHave: true, hard: false, status: 'met' }] });
  assert.equal(ok.confidence.score, Math.round(0.35 * 100 + 0.35 * 100 + 0.3 * 90));
  assert.equal(ok.confidence.capped, false);
  assert.equal(ok.confidence.label, 'High');

  const capped = computeScores({
    ...base,
    requirements: [
      { text: 'SQL', mustHave: true, hard: false, status: 'met' },
      { text: "Bachelor's degree", mustHave: true, hard: true, status: 'missing' },
    ],
  });
  assert.equal(capped.confidence.score, 60);
  assert.equal(capped.confidence.capped, true);
  assert.deepEqual(capped.confidence.blockers, ["Bachelor's degree"]);
});

test('structured resume flattens to text with headings and bullets', () => {
  const text = resumeToText({
    name: 'Jane Doe', headline: 'Analyst', contact: ['jane@example.com'], summary: 'Hi.',
    skills: [{ category: 'Tools', items: ['SQL', 'Excel'] }],
    experience: [{ title: 'Analyst', company: 'Acme', location: '', start: '2020', end: 'Present', bullets: ['Did [X%] better'] }],
    projects: [], education: [], certifications: [], extras: [],
  });
  assert.match(text, /^Jane Doe/);
  assert.match(text, /\nExperience\n/);
  assert.match(text, /• Did \[X%\] better/);
  assert.deepEqual(findPlaceholders(text), ['[X%]']);
});

test('skills added by the AI without confirmation are flagged', () => {
  const keywords = [
    { term: 'SQL', variants: [], importance: 'must' },
    { term: 'pandas', variants: [], importance: 'important' },
    { term: 'Snowflake', variants: [], importance: 'nice' },
    { term: 'Amazon Web Services', variants: ['AWS'], importance: 'nice' },
  ];
  const original = 'Wrote SQL reports. Deployed on AWS.';
  const tailored = 'Wrote SQL reports with pandas in Snowflake. Deployed on Amazon Web Services.';
  assert.deepEqual(unconfirmedAdditions(original, tailored, keywords, ['snowflake']), ['pandas']);
  assert.deepEqual(unconfirmedAdditions(original, original, keywords, []), []);
});

test('a word-stem mention in the original is not flagged as an addition', () => {
  const keywords = [{ term: 'Forecasting', variants: [], importance: 'important' }, { term: 'Mentoring', variants: [], importance: 'important' }];
  const original = 'Created Excel models to forecast weekly delivery volumes.';
  const tailored = 'Forecasting: built Excel models to forecast volumes. Mentoring juniors.';
  assert.deepEqual(unconfirmedAdditions(original, tailored, keywords, []), ['Mentoring']);
});

test('multi-word skills already described in the original are not flagged; invented tools still are', () => {
  const kw = (term) => ({ term, variants: [], importance: 'important' });
  const keywords = ['A/B testing', 'retail domain knowledge', 'Data Analysis', 'pandas', 'scikit-learn', 'Power BI'].map(kw);
  const original = 'Data analyst. Ran A/B tests for retail teams using Python and Tableau.';
  const tailored = 'Data Analysis expert. A/B testing for retail domain knowledge. Used pandas, scikit-learn and Power BI.';
  assert.deepEqual(unconfirmedAdditions(original, tailored, keywords, []), ['pandas', 'scikit-learn', 'Power BI']);
});
