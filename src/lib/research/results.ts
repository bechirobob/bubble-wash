import { answerError, findForm, forms, ids, interviewProbes, profiles, relevantProfiles, eligibilityQuestions, eligibilityNeeded, profileError, type Answers, type InstrumentId, type Question } from './model.ts';
import { schemaVersion } from './policy.ts';

export type ResearchRow = { id: string; instrument: string; schema_version: string; created_at: string; payload: string };
export type ResultFilters = { instrument: string; audience: string; area: string; question: string; compare: 'audience' | 'area'; option: string; sample: 'core' | 'quota' | 'all'; page: number };
export type ParsedResponse = { row: ResearchRow; answers: Answers; identity: { name: string; organisation: string; email: string; phone: string }; schemaKnown: boolean; analysis: { matchedProfiles: string[]; accra: boolean | null; quota: boolean | null; areaReview: boolean }; synthetic: boolean; malformed: boolean; flags: string[] };
const instruments = [...ids];
const areas = forms[0].questions.find(q => q.id === 'A3')?.options ?? [];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown) => typeof value === 'string' ? value : '';
export const answered = (value: unknown) => Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;
export const percent = (count: number, base: number) => base ? Math.round(count / base * 1000) / 10 : null;

export function parseFilters(params: URLSearchParams): ResultFilters {
  const instrument = params.get('instrument') ?? 'consumer';
  const audience = params.get('audience') ?? 'all';
  const area = params.get('area') ?? 'all';
  const page = Number(params.get('page') ?? 1);
  if (!['all', ...instruments].includes(instrument) || !['all', 'none', ...profiles.map(([id]) => id)].includes(audience) || !['all', 'unanswered', ...areas].includes(area) || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('Invalid results filter.');
  const compare = params.get('compare') ?? 'audience';
  if (!['audience', 'area'].includes(compare)) throw new Error('Invalid comparison.');
  const sample = params.get('sample') ?? 'core';
  if (!['core', 'quota', 'all'].includes(sample)) throw new Error('Invalid analysis sample.');
  return { instrument, audience, area, sample: sample as 'core' | 'quota' | 'all', question: text(params.get('question')).slice(0, 50), compare: compare as 'audience' | 'area', option: text(params.get('option')).slice(0, 250), page };
}

export function parseResponse(row: ResearchRow): ParsedResponse {
  let payload: Record<string, unknown> = {};
  let malformed = false;
  try { const parsed: unknown = JSON.parse(row.payload); if (!object(parsed)) throw new Error(); payload = parsed; } catch { malformed = true; }
  const raw = object(payload.answers) ? payload.answers : {};
  const answers: Answers = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' || Array.isArray(v) && v.every(item => typeof item === 'string'))) as Answers;
  const identity = object(payload.identity) ? payload.identity : {};
  malformed ||= !object(payload.answers) || !object(payload.identity) || payload.instrument !== row.instrument || !instruments.includes(row.instrument as InstrumentId) || Object.keys(answers).length !== Object.keys(raw).length;
  const schemaKnown = row.schema_version === schemaVersion && payload.schemaVersion === schemaVersion;
  const synthetic = payload.submissionKey === '20b2f9aa-77dd-4c7a-8efe-b23f176c77f1' && payload.reference === 'operator-test-v1';
  const flags = [...(synthetic ? ['Known operator test'] : []), ...(!schemaKnown ? ['Version needs review'] : []), ...(malformed ? ['Record needs review'] : [])];
  const storedAnalysis = object(payload.analysis) ? payload.analysis : {};
  const tri = (value: unknown) => value === true ? true : value === false ? false : null;
  const analysis = { matchedProfiles: schemaKnown ? relevantProfiles(answers) : [], accra: schemaKnown ? tri(storedAnalysis.eligibleAccraCoreAnalysis) : null, quota: schemaKnown ? tri(storedAnalysis.agreedAreaQuota) : null, areaReview: schemaKnown && storedAnalysis.areaReviewRequired === true };
  if (row.instrument === 'consumer' && schemaKnown) {
    if (analysis.accra === false) flags.push('Outside Accra core');
    if (analysis.accra === null) flags.push('Accra eligibility unknown');
    if (analysis.quota === false) flags.push('Outside agreed-area quota');
    if (analysis.areaReview) flags.push('Area needs review');
  }
  const result: ParsedResponse = { row, answers, analysis, identity: { name: text(identity.name), organisation: text(identity.organisation), email: text(identity.email), phone: text(identity.phone) }, schemaKnown, synthetic, malformed, flags };
  if (schemaKnown && !malformed) {
    const questions = questionsFor(row.instrument);
    const blanks = questions.filter(q => q.suggested_input_type !== 'optional_contact_group' && questionApplicability(q, answers, row.instrument as InstrumentId) === 'eligible' && !answered(answers[q.id])).length;
    if (blanks) flags.push('Some answers blank');
  }
  return result;
}

export function questionsFor(instrument: string): Question[] {
  const form = findForm(instrument);
  return form ? [...form.questions, ...(instrument === 'consumer-interview' ? interviewProbes : []), ...(['consumer', 'consumer-interview'].includes(instrument) ? eligibilityQuestions : [])] : [];
}
export function audienceMatches(response: ParsedResponse, audience: string) {
  return audience === 'all' || response.schemaKnown && (audience === 'none' ? ['consumer', 'consumer-interview'].includes(response.row.instrument) && profileError(response.answers) === null && relevantProfiles(response.answers).length === 0 : response.analysis.matchedProfiles.includes(audience));
}
export function areaMatches(response: ParsedResponse, area: string) {
  return area === 'all' || response.row.instrument === 'consumer' && (area === 'unanswered' ? !answered(response.answers.A3) : response.answers.A3 === area);
}
export function flagRepeatedContacts(responses: ParsedResponse[]) {
  const counts = new Map<string, number>();
  const keys = (response: ParsedResponse) => [response.identity.email.trim().toLowerCase(), response.identity.phone.replace(/\D/g, '')].map((value, index) => value ? `${response.row.instrument}:${index === 0 ? 'email' : 'phone'}:${value}` : '').filter(Boolean);
  for (const response of responses.filter(r => !r.synthetic && !r.malformed)) for (const key of keys(response)) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const response of responses) if (!response.synthetic && keys(response).some(key => (counts.get(key) ?? 0) > 1)) response.flags.push('Possible repeated contact');
}
export function analyticResponse(response: ParsedResponse) { return response.schemaKnown && !response.synthetic && !response.malformed; }

export function sampleMatches(response: ParsedResponse, sample: ResultFilters['sample']) {
  if (sample === 'all' || response.row.instrument !== 'consumer') return true;
  return response.analysis.accra === true && (sample !== 'quota' || response.analysis.quota === true);
}
/** Missing routing answers are unknown, never silently treated as a skipped/ineligible question. */
export function questionApplicability(question: Question, answers: Answers, instrument: InstrumentId): 'eligible' | 'not-applicable' | 'unknown' {
  let gate = '';
  if (instrument === 'consumer' && /^F[1-4]/.test(question.id)) gate = 'icp-' + ['student', 'business', 'corporate', 'household'][Number(question.id[1]) - 1];
  if (instrument === 'consumer-interview' && question.id.startsWith('probe-')) gate = 'icp-' + question.id.slice(6);
  if (gate) return relevantProfiles(answers).some(profile => 'icp-' + profile === gate) ? 'eligible' : answers[gate] === 'No' ? 'not-applicable' : 'unknown';
  if (question.id.startsWith('icp-') && !eligibilityNeeded(question, answers)) return 'not-applicable';
  if (instrument === 'vendor-interview' && question.id === '13') return answers.hotelLaundry === 'Yes' ? 'eligible' : answers.hotelLaundry === 'No' ? 'not-applicable' : 'unknown';
  if (instrument === 'consumer') {
    if (question.id === 'H4') { const gates = ['H1', 'H2', 'H3'].map(id => answers[id]); return gates.includes('Yes') ? 'eligible' : gates.every(value => value === 'No') ? 'not-applicable' : 'unknown'; }
    const parentId = question.id === 'A8a' ? 'A8' : question.id === 'B6c' ? 'B6b' : '';
    if (parentId) { const parent = findForm('consumer')!.questions.find(q => q.id === parentId)!; if (!answered(answers[parentId]) || answerError(parent, answers[parentId])) return 'unknown'; return (parentId === 'A8' ? answers.A8 === 'House help' : ['Yes, regularly', 'Yes, occasionally'].includes(String(answers.B6b))) ? 'eligible' : 'not-applicable'; }
  }
  return 'eligible';
}

export function questionSummary(responses: ParsedResponse[], question: Question, instrument: InstrumentId) {
  const instrumentRows = responses.filter(r => analyticResponse(r) && r.row.instrument === instrument);
  const applicable = instrumentRows.filter(r => questionApplicability(question, r.answers, instrument) === 'eligible');
  const notShown = instrumentRows.filter(r => questionApplicability(question, r.answers, instrument) === 'not-applicable').length;
  const unknownEligibility = instrumentRows.filter(r => questionApplicability(question, r.answers, instrument) === 'unknown').length;
  const valid = applicable.filter(r => answered(r.answers[question.id]) && !answerError(question, r.answers[question.id]));
  const invalid = applicable.filter(r => answered(r.answers[question.id]) && answerError(question, r.answers[question.id])).length;
  const options = question.suggested_input_type === 'linear_scale' ? ['1', '2', '3', '4', '5'] : question.options ?? [];
  const categorical = ['single_choice', 'checkboxes', 'linear_scale'].includes(question.suggested_input_type);
  const values = categorical ? options.map(label => { const count = valid.filter(r => Array.isArray(r.answers[question.id]) ? (r.answers[question.id] as string[]).includes(label) : r.answers[question.id] === label).length; return { label, count, percent: percent(count, valid.length) }; }) : [];
  const numeric = ['number', 'number_or_nonresponse_choice'].includes(question.suggested_input_type) ? valid.map(r => r.answers[question.id]).filter((value): value is string => typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value)).map(Number).sort((a, b) => a - b) : [];
  const median = numeric.length ? (numeric[Math.floor((numeric.length - 1) / 2)] + numeric[Math.floor(numeric.length / 2)]) / 2 : null;
  return { id: question.id, prompt: question.prompt, inputType: question.suggested_input_type, multiSelect: question.suggested_input_type === 'checkboxes', eligible: applicable.length, answered: valid.length, blank: applicable.length - valid.length - invalid, notShown, unknownEligibility, invalid, values, median, numericCount: numeric.length, nonNumeric: valid.length - numeric.length };
}

export function buildResults(rows: ResearchRow[], filters: ResultFilters) {
  const all = rows.map(parseResponse);
  flagRepeatedContacts(all);
  const filtered = all.filter(r => (filters.instrument === 'all' || r.row.instrument === filters.instrument) && audienceMatches(r, filters.audience) && areaMatches(r, filters.area));
  const valid = filtered.filter(analyticResponse);
  const base = valid.filter(r => sampleMatches(r, filters.sample));
  const questionInstrument = (filters.instrument === 'all' ? 'consumer' : filters.instrument) as InstrumentId;
  const questions = questionsFor(questionInstrument).filter(q => q.suggested_input_type !== 'optional_contact_group');
  const question = questions.find(q => q.id === filters.question) ?? questions.find(q => q.id === 'E1') ?? questions[0];
  const summary = question ? questionSummary(base, question, questionInstrument) : null;
  const selectedOption = summary?.values.find(v => v.label === filters.option)?.label ?? summary?.values.at(-1)?.label ?? '';
  const comparisonGroups: [string, string][] = filters.compare === 'audience' ? [...profiles.map(([id, label]) => [id, label] as [string, string]), ['none', 'None of these']] : [...areas.map(area => [area, area] as [string, string]), ['unanswered', 'Area unanswered']];
  const comparison = summary && question ? comparisonGroups.map(([id, label]) => {
    const group = base.filter(r => filters.compare === 'audience' ? audienceMatches(r, id) : areaMatches(r, id));
    const s = questionSummary(group, question, questionInstrument);
    const count = s.values.find(v => v.label === selectedOption)?.count ?? 0;
    return { id, label, count, base: s.answered, percent: percent(count, s.answered) };
  }) : [];
  const audienceBase = base.filter(r => ['consumer', 'consumer-interview'].includes(r.row.instrument) && profileError(r.answers) === null);
  const areaBase = base.filter(r => r.row.instrument === 'consumer');
  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(filters.page, pages);
  return {
    filters: { ...filters, question: question?.id ?? '', option: selectedOption, page },
    instruments: [{ id: 'all', title: 'All questionnaires' }, ...forms.map(form => ({ id: form.id, title: form.title.replace(' Questionnaire', '').replace(' Guide', '') }))],
    audiences: [...profiles.map(([id, label]) => ({ id, label })), { id: 'none', label: 'None of these' }], areas,
    totals: { saved: filtered.length, analysis: base.length, excluded: filtered.length - base.length, repeated: filtered.filter(r => r.flags.includes('Possible repeated contact')).length, blanks: filtered.filter(r => r.flags.includes('Some answers blank')).length, synthetic: filtered.filter(r => r.synthetic).length, unknownVersion: filtered.filter(r => !r.schemaKnown).length, malformed: filtered.filter(r => r.malformed).length, outsideAccra: valid.filter(r => r.row.instrument === 'consumer' && r.analysis.accra === false).length, unknownScreening: valid.filter(r => r.row.instrument === 'consumer' && r.analysis.accra === null).length, outsideQuota: valid.filter(r => r.row.instrument === 'consumer' && r.analysis.quota === false).length, areaReview: valid.filter(r => r.analysis.areaReview).length },
    audienceBreakdown: [...profiles.map(([id, label]) => ({ id, label })), { id: 'none', label: 'None of these' }].map(group => ({ ...group, count: audienceBase.filter(r => audienceMatches(r, group.id)).length, base: audienceBase.length })),
    areaBreakdown: [...areas, 'unanswered'].map(area => ({ label: area === 'unanswered' ? 'Area unanswered' : area, count: areaBase.filter(r => areaMatches(r, area)).length, base: areaBase.length })),
    questions: questions.map(q => ({ id: q.id, label: q.prompt })), questionInstrument, question: summary, comparison,
    responses: filtered.slice((page - 1) * pageSize, page * pageSize).map(r => ({ id: r.row.id, instrument: r.row.instrument, createdAt: r.row.created_at, name: r.identity.name || 'Name unavailable', organisation: r.identity.organisation, profiles: r.analysis.matchedProfiles, area: r.row.instrument === 'consumer' ? text(r.answers.A3) || 'Area unanswered' : 'Area not collected', flags: r.flags })),
    pagination: { page, pages, total: filtered.length, pageSize },
  };
}
export type ResearchResultsData = Omit<ReturnType<typeof buildResults>, 'responses'>;
export type ResearchResponseList = Pick<ReturnType<typeof buildResults>, 'responses' | 'pagination'>;
