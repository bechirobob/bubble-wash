import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { buildResults, parseResponse, parseFilters, questionSummary, questionApplicability, flagRepeatedContacts } from '../src/lib/research/results.ts';
import { readResearchResults, readResearchResponse } from '../src/lib/research/results-store.ts';
import { forms, researchAnalysis } from '../src/lib/research/model.ts';
import { schemaVersion } from '../src/lib/research/policy.ts';
import { canViewResearchResults } from '../src/lib/research/access.ts';
const q = id => forms[0].questions.find(question => question.id === id);
const profile = { 'icp-student': 'No', 'icp-business': 'No', 'icp-corporate': 'Yes', 'icp-household': 'Yes' };
function row(answers = {}, extra = {}) {
  const a = { ...profile, A2: 'Both', A3: 'East Legon', ...answers };
  const payload = { instrument: 'consumer', schemaVersion, submissionKey: randomUUID(), identity: { name: 'Synthetic person', organisation: '', email: randomUUID() + '@example.invalid', phone: '' }, answers: a, analysis: researchAnalysis('consumer', a), reference: '', ...extra };
  return { id: randomUUID(), instrument: payload.instrument, schema_version: payload.schemaVersion, created_at: '2026-10-20T10:00:00Z', payload: JSON.stringify(payload) };
}
const filters = query => parseFilters(new URLSearchParams(query));
test('one response counted once while audience memberships overlap', () => {
  const result = buildResults([row({ E1: '5' })], filters(''));
  assert.equal(result.totals.saved, 1); assert.equal(result.totals.analysis, 1);
  assert.equal(result.audienceBreakdown.find(g => g.id === 'corporate').count, 1);
  assert.equal(result.audienceBreakdown.find(g => g.id === 'household').count, 1);
  assert.equal(result.question.values[4].percent, 100);
});
test('single-choice denominator omits blanks and is never all saved', () => {
  const result = buildResults([row({ E1: '5' }), row({ E1: '4' }), row({ E1: '' })], filters(''));
  assert.equal(result.question.answered, 2); assert.equal(result.question.eligible, 3); assert.equal(result.question.blank, 1); assert.equal(result.question.values[4].percent, 50);
});
test('multi-select percentages count responses, not selections', () => {
  const result = buildResults([row({ C1: ['Takes too much time', 'Costs too much'] }), row({ C1: ['Takes too much time'] }), row({ C1: [] })], filters('question=C1'));
  assert.equal(result.question.answered, 2); assert.equal(result.question.values[0].percent, 100); assert.equal(result.question.values[1].percent, 50);
});
test('conditional denominator distinguishes known eligible, not-applicable, and unknown', () => {
  const parsed = [row({ A8: 'House help', A8a: '200' }), row({ A8: 'House help' }), row({ A8: 'Me' }), row({})].map(parseResponse);
  const result = questionSummary(parsed, q('A8a'), 'consumer');
  assert.equal(result.eligible, 2); assert.equal(result.answered, 1); assert.equal(result.blank, 1); assert.equal(result.notShown, 1); assert.equal(result.unknownEligibility, 1); assert.equal(result.median, 200);
  assert.equal(questionApplicability(q('H4'), { H1: 'No', H3: 'No' }, 'consumer'), 'unknown');
  assert.equal(questionApplicability(q('H4'), { H1: 'Yes' }, 'consumer'), 'eligible');
});
test('Accra core excludes Neither/unknown, quota also excludes None/Other without deleting rows', () => {
  const rows = [row({ E1: '5' }), row({ A2: 'Neither', E1: '1' }), row({ A3: 'None of these', E1: '4' }), row({ A3: 'Other (specify)', 'A3-other': 'Unclassified district', E1: '4' }), row({ A2: '', E1: '2' })];
  const core = buildResults(rows, filters(''));
  assert.equal(core.totals.saved, 5); assert.equal(core.totals.analysis, 3); assert.equal(core.totals.areaReview, 1); assert.equal(core.totals.outsideAccra, 1); assert.equal(core.totals.unknownScreening, 1);
  assert.equal(buildResults(rows, filters('sample=quota')).totals.analysis, 1);
  assert.equal(buildResults(rows, filters('sample=all')).totals.analysis, 5);
});
test('unknown historical version is retained but not guessed into current analysis', () => {
  const historical = row({ E1: '5' }, { schemaVersion: 'bubblewash-research-2', answers: { profile: ['household'], A2: 'Both', E1: '5' } });
  const result = buildResults([historical, row({ E1: '4' })], filters('sample=all'));
  assert.equal(result.totals.saved, 2); assert.equal(result.totals.analysis, 1); assert.equal(result.totals.unknownVersion, 1); assert.deepEqual(result.responses[0].profiles, []);
});
test('known operator test excluded but never deleted', () => {
  const synthetic = row({ E1: '5' }, { submissionKey: '20b2f9aa-77dd-4c7a-8efe-b23f176c77f1', reference: 'operator-test-v1' });
  const result = buildResults([synthetic], filters(''));
  assert.equal(result.totals.saved, 1); assert.equal(result.totals.analysis, 0); assert.equal(result.totals.synthetic, 1); assert.equal(result.responses.length, 1);
});
test('possible duplicate contacts are flagged, not discarded or equated to people', () => {
  const identity = { name: 'Shared contact', organisation: '', email: 'SAME@example.invalid', phone: '024 000 0000' };
  const result = buildResults([row({ E1: '5' }, { identity }), row({ E1: '4' }, { identity: { ...identity, email: 'same@example.invalid' } })], filters(''));
  assert.equal(result.totals.repeated, 2); assert.equal(result.totals.analysis, 2);
});
test('comparison uses each group own answered denominator', () => {
  const rows = [row({ 'icp-student': 'Yes', E1: '5' }), row({ 'icp-student': 'Yes', E1: '4' }), row({ 'icp-student': 'No', E1: '5' })];
  const result = buildResults(rows, filters('option=5'));
  assert.deepEqual(result.comparison.find(g => g.id === 'student'), { id: 'student', label: 'Students', count: 1, base: 2, percent: 50 });
  assert.equal(result.comparison.find(g => g.id === 'business').percent, null);
});
test('all questionnaires total does not turn interview prose into consumer figures', () => {
  const interview = row({}, { instrument: 'business-interview', answers: { '1': 'Synthetic prose' }, analysis: { matchedProfiles: [] } });
  const result = buildResults([row({ E1: '5' }), interview], filters('instrument=all'));
  assert.equal(result.totals.analysis, 2); assert.equal(result.question.answered, 1); assert.equal(result.questionInstrument, 'consumer');
});
test('numeric nonresponses are not coerced to zero', () => {
  const result = questionSummary([row({ B4: '100' }), row({ B4: '300' }), row({ B4: 'Don’t know' })].map(parseResponse), q('B4'), 'consumer');
  assert.equal(result.numericCount, 2); assert.equal(result.nonNumeric, 1); assert.equal(result.median, 200);
});
test('filter validation and unknown route guards are strict', () => {
  for (const query of ['instrument=foo', 'area=private-free-text', 'page=-1', 'page=1.5', 'sample=foo']) assert.throws(() => filters(query));
  for (const user of [null, { role: 'admin' }, { role: 'admin', allStaffAccess: false }, { role: 'support', allStaffAccess: true }, { role: 'vendor' }, { role: 'driver' }]) assert.equal(canViewResearchResults(user), false);
  assert.equal(canViewResearchResults({ role: 'admin', allStaffAccess: true }), true);
});
test('read path does not create schema, mutate records, or fetch email/contact in summary', () => {
  const db = new Database(':memory:'); assert.throws(() => readResearchResults(filters(''), db), /not ready/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='research_responses'").get().n, 0);
  db.exec(readFileSync(new URL('../db/proposed/research-v1.sql', import.meta.url), 'utf8'));
  const value = row({ E1: '5', C3: '<script>alert(1)</script>' });
  db.prepare('INSERT INTO research_responses VALUES (?,?,?,?,?,?,?)').run(value.id, randomUUID(), 'hash', value.instrument, value.schema_version, value.created_at, value.payload);
  const before = db.prepare('SELECT * FROM research_responses').all();
  const result = readResearchResults(filters(''), db);
  assert.equal(JSON.stringify(result).includes('@example.invalid'), false); assert.equal(JSON.stringify(result).includes('Synthetic person'), false); assert.equal('responses' in result, false); assert.equal(JSON.stringify(result).includes('<script>'), false);
  assert.equal(readResearchResponse(value.id, db).answers.find(a => a.id === 'C3').value, '<script>alert(1)</script>');
  assert.equal(readResearchResponse("' OR 1=1 --", db), null);
  assert.deepEqual(db.prepare('SELECT * FROM research_responses').all(), before); db.close();
});
test('malformed payload is retained, flagged and excluded; pagination remains bounded', () => {
  const bad = { ...row(), payload: '{bad json' }; const rows = [bad, ...Array.from({ length: 20 }, () => row({ E1: '5' }))];
  const result = buildResults(rows, filters('page=2'));
  assert.equal(result.totals.saved, 21); assert.equal(result.totals.analysis, 20); assert.equal(result.totals.malformed, 1); assert.equal(result.responses.length, 9);
});
test('A4-derived qualification works without redundant ICP answers', () => {
  for (const [occupation, profileId, questionId] of [['Business owner or self-employed', 'business', 'F2a'], ['Employed in an office or corporate role', 'corporate', 'F3a']]) {
    const a = { ...profile, A4: occupation }; delete a['icp-' + profileId];
    const record = row(a); const payload = JSON.parse(record.payload); delete payload.answers['icp-' + profileId]; payload.analysis = researchAnalysis('consumer', payload.answers); record.payload = JSON.stringify(payload);
    const result = buildResults([record], filters('question=' + questionId));
    assert.equal(result.question.eligible, 1); assert.equal(result.question.unknownEligibility, 0); assert.equal(result.audienceBreakdown.find(group => group.id === profileId).count, 1); assert.equal(result.audienceBreakdown.find(group => group.id === profileId).base, 1);
  }
});

test('missing contact values cannot shift phone into the email matching namespace', () => {
  const parsed = [row({}, { identity: { name: 'A', email: '', phone: '1234567890', organisation: '' } }), row({}, { identity: { name: 'B', email: '1234567890', phone: '', organisation: '' }, schemaVersion: 'historical' }), row({}, { identity: { name: 'C', email: 'separate@example.invalid', phone: '1234567890', organisation: '' } })].map(parseResponse);
  flagRepeatedContacts(parsed);
  assert.equal(parsed[0].flags.includes('Possible repeated contact'), true);
  assert.equal(parsed[1].flags.includes('Possible repeated contact'), false);
  assert.equal(parsed[2].flags.includes('Possible repeated contact'), true);
});

test('results UI hides internal row IDs and uses shared neutral decorative edges', () => {
  const ui = readFileSync(new URL('../src/components/research/ResearchResults.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/components/research/results.module.css', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /response\.id\.slice/);
  assert.doesNotMatch(css, /border(?:-(?:top|bottom|left|right|color))?:[^;{}]*#[0-9a-fA-F]{3,8}/);
  assert.match(css, /var\(--line\)/); assert.match(css, /var\(--focus-ring\)/);
});

test('unanswered-area filter never treats interview absence as unanswered consumer A3', () => {
  const consumer = row({ A3: '' }); const interview = row({}, { instrument: 'business-interview', answers: { '1': 'Synthetic' }, analysis: { matchedProfiles: [] } });
  const result = buildResults([consumer, interview], filters('instrument=all&area=unanswered'));
  assert.equal(result.totals.saved, 1); assert.equal(result.responses[0].instrument, 'consumer');
});
test('historical detail preserves field keys instead of assigning present-day wording', () => {
  const db = new Database(':memory:'); db.exec(readFileSync(new URL('../db/proposed/research-v1.sql',import.meta.url),'utf8'));
  const historical = row({ A1: 'Original answer' }, { schemaVersion: 'unknown-history' });
  db.prepare('INSERT INTO research_responses VALUES (?,?,?,?,?,?,?)').run(historical.id,randomUUID(),'hash',historical.instrument,historical.schema_version,historical.created_at,historical.payload);
  const detail = readResearchResponse(historical.id,db); assert.equal(detail.answers.find(a => a.id === 'A1').label, 'Historical field A1'); db.close();
});
