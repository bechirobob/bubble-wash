'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, BarChart3, ChevronDown, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { PortalShell } from '@/components/StaffWorkspaces';
import type { ResearchResultsData, ResearchResponseList } from '@/lib/research/results';
import type { ResearchResponseDetail } from '@/lib/research/results-store';
import styles from './results.module.css';

const initialFilters = { instrument: 'consumer', audience: 'all', area: 'all', question: 'E1', compare: 'audience', option: '', sample: 'core', page: '1' };
const instrumentLabels: Record<string, string> = { consumer: 'Consumer survey', 'consumer-interview': 'Consumer interview', 'business-interview': 'Business interview', 'vendor-interview': 'Vendor interview' };
const displayPercent = (value: number | null) => value === null ? '—' : `${value}%`;
const date = (value: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));

export function ResearchResults({ userName }: { userName: string }) {
  const [filters, setFilters] = useState(initialFilters);
  const [tab, setTab] = useState<'patterns' | 'responses'>('patterns');
  const [data, setData] = useState<ResearchResultsData | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [listKey, setListKey] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [responseList, setResponseList] = useState<ResearchResponseList | null>(null);
  const [listError, setListError] = useState('');
  const [detail, setDetail] = useState<ResearchResponseDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const disclosureState = useRef<Record<string, boolean>>({});
  const requestKey = new URLSearchParams(filters).toString() + ':' + revision;
  const loading = loadedKey !== requestKey;
  const visibleResponseList = listKey === requestKey ? responseList : null;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/research/results?${new URLSearchParams(filters)}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Results could not be loaded.');
      if (!controller.signal.aborted) { setData(result); setError(''); }
    }).catch(err => { if (!controller.signal.aborted) { setError(err instanceof Error ? err.message : 'Results could not be loaded.'); setData(null); } }).finally(() => { if (!controller.signal.aborted) setLoadedKey(requestKey); });
    return () => controller.abort();
  }, [filters, revision, requestKey]);
  useEffect(() => {
    if (tab !== 'responses') return;
    const controller = new AbortController();
    fetch(`/api/admin/research/responses?${new URLSearchParams(filters)}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Responses could not be loaded.');
      if (!controller.signal.aborted) { setResponseList(result); setListError(''); }
    }).catch(err => { if (!controller.signal.aborted) { setResponseList(null); setListError(err instanceof Error ? err.message : 'Responses could not be loaded.'); } }).finally(() => { if (!controller.signal.aborted) setListKey(requestKey); });
    return () => controller.abort();
  }, [filters, revision, tab, requestKey]);
  useEffect(() => () => detailRequest.current?.abort(), []);
  function change(key: keyof typeof filters, value: string) {
    setFilters(current => ({ ...current, [key]: value, page: '1', ...(key === 'instrument' ? { audience: 'all', area: 'all', question: '', option: '', sample: ['consumer', 'all'].includes(value) ? 'core' : 'all' } : {}), ...(key === 'question' ? { option: '' } : {}) }));
  }
  async function openResponse(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    setDetail(null); setDetailStatus('Loading response…'); dialog.current?.showModal();
    try {
      const response = await fetch(`/api/admin/research/responses/${encodeURIComponent(id)}`, { cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Response could not be loaded.');
      if (!controller.signal.aborted) { setDetail(result); setDetailStatus(''); }
    } catch (err) { if (!controller.signal.aborted) setDetailStatus(err instanceof Error ? err.message : 'Response could not be loaded.'); }
  }
  const ready = !loading && data;
  const question = ready ? data.question : null;
  return <PortalShell role="admin" allStaffAccess title="Owner-only research" userName={userName} currentView="surveys" navigation={[]}
    heading={{ eyebrow: 'Private research · Owners only', title: 'Survey results', subtitle: '' }}
    headingAction={<button className={styles.refresh} type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw size={16} aria-hidden="true" />Refresh</button>}>
    <div className={styles.page}>
    <a href="#survey-results-main" className="skipLink">Skip to survey results</a>
    <div className={styles.content} id="survey-results-main">
      <section className={styles.filters} aria-label="Filter survey results">
        <label>Questionnaire<select aria-label="Questionnaire" value={filters.instrument} onChange={e => change('instrument', e.target.value)}>{(data?.instruments ?? [{ id: 'consumer', title: 'Consumer Survey' }]).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>Audience<select aria-label="Audience" value={filters.audience} onChange={e => change('audience', e.target.value)} disabled={!['consumer', 'consumer-interview', 'all'].includes(filters.instrument)}><option value="all">All audiences</option>{data?.audiences.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Area<select aria-label="Area" value={filters.area} onChange={e => change('area', e.target.value)} disabled={!['consumer', 'all'].includes(filters.instrument)}><option value="all">All areas</option>{data?.areas.map(area => <option key={area}>{area}</option>)}<option value="unanswered">Area unanswered</option></select></label>
        <label>Analysis sample<select aria-label="Analysis sample" value={filters.sample} onChange={e => change('sample', e.target.value)} disabled={!['consumer', 'all'].includes(filters.instrument)}><option value="core">Accra core</option><option value="quota">Accra · agreed areas</option><option value="all">All recorded</option></select></label>
      </section>
      {!loading && error ? <div className={styles.notice} role="alert"><strong>Results unavailable</strong><p>{error}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Try again</button></div> : null}
      <div className={styles.stats} aria-busy={loading}>
        <div><span>Saved</span><strong>{ready ? data.totals.saved : '—'}</strong></div>
        <div><span>In analysis</span><strong>{ready ? data.totals.analysis : '—'}</strong></div>
        <div><span>For review</span><strong>{ready ? data.totals.repeated : '—'}</strong></div>
        <p className={styles.statsDefinition}>Submissions, not unique people.</p>
      </div>
      <p className={styles.hint}>{ready ? `${data.totals.excluded} held outside this analysis · ${data.totals.repeated} possible repeated contacts flagged, not removed. Records are retained.` : loading ? 'Loading saved response counts…' : 'Saved response counts are unavailable.'}</p>
      <div className={styles.tabs} role="tablist" aria-label="Results view"><button type="button" id="patterns-tab" role="tab" aria-selected={tab === 'patterns'} aria-controls="patterns-panel" onClick={() => setTab('patterns')}><BarChart3 size={17} aria-hidden="true" />Patterns</button><button type="button" id="responses-tab" role="tab" aria-selected={tab === 'responses'} aria-controls="responses-panel" onClick={() => setTab('responses')}><Users size={17} aria-hidden="true" />Responses</button></div>
      {loading ? <p className={styles.status} role="status">Loading the latest saved responses…</p> : null}
      {ready && ['consumer', 'all'].includes(filters.instrument) ? <p className={styles.sampleNote}>Consumer scope: {filters.sample === 'core' ? 'Accra core' : filters.sample === 'quota' ? 'Accra core in agreed areas' : 'All recorded, including outside-scope responses'}. {data.totals.outsideAccra} outside Accra · {data.totals.outsideQuota} outside area quota · {data.totals.areaReview} area review · {data.totals.unknownScreening} unknown Accra eligibility. Records are retained.{filters.instrument === 'all' ? ' Interview responses are not subject to consumer area screening.' : ''}</p> : null}
      {ready && data.totals.saved === 0 ? <section className={styles.empty}><BarChart3 size={28} aria-hidden="true" /><h2>No responses in this view yet.</h2><p>{filters.audience !== 'all' || filters.area !== 'all' ? 'Try another audience or area. Your other responses are unchanged.' : 'Saved survey responses will appear here. The public survey and email copies continue separately.'}</p></section> : null}
      {ready && data.totals.saved > 0 && tab === 'patterns' ? <div id="patterns-panel" role="tabpanel" aria-labelledby="patterns-tab">
        <div className={styles.grid}>
          <section className={`${styles.card} ${styles.question}`}><div className={styles.sectionTitle}><h2>Question by question</h2><span>{instrumentLabels[data.questionInstrument]}</span></div>
            <label className={styles.questionSelect}><span>Choose a question</span><select aria-label="Choose a question" value={data.filters.question} onChange={e => change('question', e.target.value)}>{data.questions.map(q => <option key={q.id} value={q.id}>{q.id}. {q.label}</option>)}</select></label>
            {question ? <><h3>{question.prompt}</h3><p className={styles.base}><strong>{question.answered} answered</strong> of {question.eligible} eligible responses · {question.blank} blank · {question.notShown} not applicable{question.unknownEligibility ? ` · ${question.unknownEligibility} eligibility unknown` : ''}{question.invalid ? ` · ${question.invalid} invalid answer(s) held out` : ''}</p>
              {question.multiSelect ? <p className={styles.hint}>Multiple answers allowed. Each percentage uses the {question.answered} responses that answered, so percentages can add to more than 100%.</p> : <p className={styles.hint}>Percentages use answered responses for this question, not every saved response.</p>}
              {question.values.length ? <div className={styles.bars}>{question.values.map(value => <div className={styles.barRow} key={value.label}><div><span>{question.inputType === 'linear_scale' ? `${value.label} / 5` : value.label}</span><b>{displayPercent(value.percent)} <small>({value.count}/{question.answered})</small></b></div><div className={styles.track}><div style={{ width: `${value.percent ?? 0}%` }} /></div></div>)}</div> : ['number', 'number_or_nonresponse_choice'].includes(question.inputType) ? <div className={styles.numeric}><span>Median of numeric answers</span><strong>{question.median?.toLocaleString('en-GB') ?? '—'}</strong><p>{question.numericCount} numeric responses. {question.nonNumeric} non-numeric answers kept separately.</p></div> : <div className={styles.textNote}><p>This is a written-answer question. Read the responses rather than turning unclassified text into percentages.</p><button type="button" onClick={() => setTab('responses')}>Read responses <ArrowRight size={16} aria-hidden="true" /></button></div>}
            </> : null}
          </section>
          <ResearchDisclosure title="Who is represented?" readOpen={() => disclosureState.current.audience} saveOpen={(open) => { disclosureState.current.audience = open; }} className={styles.card}><p className={styles.hint}>Recorded eligibility groups. One response can belong to more than one group.</p><div className={styles.audiences}>{data.audienceBreakdown.map(group => <div key={group.id}><span>{group.label}</span><b>{group.count}<small>{group.base ? `${Math.round(group.count / group.base * 100)}% of ${group.base}` : 'No responses'}</small></b></div>)}</div><details className={styles.areas}><summary>By area <ChevronDown size={15} aria-hidden="true" /></summary>{data.areaBreakdown.map(group => <div key={group.label}><span>{group.label}</span><b>{group.count}<small>of {group.base}</small></b></div>)}<p className={styles.hint}>Structured area is collected in the consumer survey only. “Other” stays unclassified.</p></details></ResearchDisclosure>
        </div>
        {question && question.values.length > 0 ? <ResearchDisclosure title="A closer comparison" readOpen={() => disclosureState.current.comparison} saveOpen={(open) => { disclosureState.current.comparison = open; }} className={styles.comparison}><div className={styles.sectionTitle}><div><p>Compare the same answer, using each group’s own answered base.</p></div><div className={styles.compareControls}><label>Compare by<select aria-label="Compare by" value={filters.compare} onChange={e => change('compare', e.target.value)}><option value="audience">Audience</option><option value="area">Area</option></select></label><label>Answer<select aria-label="Answer" value={data.filters.option} onChange={e => change('option', e.target.value)}>{question.values.map(v => <option key={v.label}>{v.label}</option>)}</select></label></div></div><div className={styles.compareGrid}>{data.comparison.map(group => <div key={group.id}><span>{group.label}</span><strong>{displayPercent(group.percent)}</strong><small>{group.count} of {group.base} answered</small></div>)}</div><p className={styles.hint}>These are descriptive results, not a representative population estimate. Small groups can change sharply as responses arrive.{filters.compare === 'audience' ? ' Audiences overlap and must not be added together.' : ''}</p></ResearchDisclosure> : null}
      </div> : null}
      {ready && data.totals.saved > 0 && tab === 'responses' ? <section className={styles.card} id="responses-panel" role="tabpanel" aria-labelledby="responses-tab"><div className={styles.sectionTitle}><div><h2>Individual responses</h2><p>Contact details and written answers open only when you choose a response.</p></div><span>{data.pagination.total} saved</span></div><p role="status">{listKey === requestKey && listError ? listError : !visibleResponseList ? 'Loading responses…' : ''}</p><div className="boundedListViewport" role="region" aria-label="Survey responses" aria-describedby="survey-scroll-hint" tabIndex={0}><ul className={styles.responseList}>{visibleResponseList?.responses.map(response => <li key={response.id}><div className={styles.responseIdentity}><strong>{response.name}</strong><span>{response.organisation || instrumentLabels[response.instrument]} · {response.area}</span><small>{date(response.createdAt)}</small>{response.flags.length ? <div className={styles.flags}>{response.flags.map(flag => <span key={flag}>{flag}</span>)}</div> : null}</div><button type="button" onClick={() => openResponse(response.id)} aria-label={`Open response from ${response.name}`}>Open <ArrowUpRight size={17} aria-hidden="true" /></button></li>)}</ul></div><small className="boundedListHint" id="survey-scroll-hint">Scroll within this list. Page controls stay below it.</small><div className={styles.pagination}><span>Page {data.pagination.page} of {data.pagination.pages}</span><div><button type="button" disabled={data.pagination.page <= 1} onClick={() => setFilters(current => ({ ...current, page: String(data.pagination.page - 1) }))}>Previous</button><button type="button" disabled={data.pagination.page >= data.pagination.pages} onClick={() => setFilters(current => ({ ...current, page: String(data.pagination.page + 1) }))}>Next</button></div></div></section> : null}
      {ready ? <details className={styles.method}><summary>How to read these results <ChevronDown size={15} aria-hidden="true" /></summary><p>Every saved submission is counted once in the total. Sending the same submission again with the same submission key does not create a second row. Matching contact details within a questionnaire are flagged for review, not deleted or treated as proof of duplication.</p><p>Blank answers do not prove an incomplete submission. No completion rate, abandoned-session count, accuracy score or verified-people total is inferred. Group membership and conditional eligibility follow recorded answers, not demographic guesses. Eligibility is unknown when a required routing answer was not recorded; those responses are not silently counted as ineligible. ‘Not applicable’ reflects routing, not a measured impression count.</p><p>{data.totals.synthetic} known operator test(s), {data.totals.unknownVersion} unknown-version response(s) and {data.totals.malformed} unreadable record(s) are outside the analytical base, with records retained. Exclusion categories may overlap. Screened-out attempts and quota targets are not inferred from missing rows. Accra core excludes ‘Neither’ and unknown Accra eligibility. The agreed-area view also excludes unconfirmed/Other areas and ‘None of these’; Other remains review-required rather than rejected. All recorded permits a separate broad view without changing those flags.</p><p>Email copies remain a separate delivery process. These results read saved responses and do not send, change, delete or share them.</p></details> : null}
      <footer className={styles.footer}><ShieldCheck size={14} aria-hidden="true" />Private research · Existing owners only · Email copies continue</footer>
    </div>
    <dialog ref={dialog} className={styles.dialog} onClose={() => { detailRequest.current?.abort(); setDetail(null); }} aria-labelledby="response-title"><div className={styles.dialogHead}><div><p className={styles.eyebrow}>Private response</p><h2 id="response-title">{detail?.identity.name || 'Response details'}</h2></div><button type="button" aria-label="Close response" onClick={() => dialog.current?.close()}><X aria-hidden="true" /></button></div>{detailStatus ? <p role="status">{detailStatus}</p> : null}{detail ? <><div className={styles.contact}><p>{detail.identity.organisation}</p><p>{detail.identity.email}</p><p>{detail.identity.phone}</p><small>{instrumentLabels[detail.instrument]} · {date(detail.createdAt)} · {detail.schemaVersion}</small></div>{detail.flags.includes('Version needs review') ? <p className={styles.hint}>Historical survey version. Field keys and original values are shown without guessing current wording or eligibility.</p> : null}<dl className={styles.answers}>{detail.answers.map(answer => <div key={answer.id}><dt>{answer.label}</dt><dd>{Array.isArray(answer.value) ? answer.value.join(', ') || 'Blank' : answer.value || 'Blank'}</dd></div>)}</dl></> : null}</dialog>
    </div>
  </PortalShell>;
}

function ResearchDisclosure({ title, className, children, readOpen, saveOpen }: { title: string; className: string; children: ReactNode; readOpen: () => boolean | undefined; saveOpen: (open: boolean) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia('(max-width:760px)');
    const applyLayout = () => { if (ref.current) ref.current.open = !mobile.matches; };
    if (ref.current) ref.current.open = readOpen() ?? !mobile.matches;
    mobile.addEventListener('change', applyLayout);
    return () => mobile.removeEventListener('change', applyLayout);
  }, [readOpen]);
  return <details ref={ref} className={`${className} ${styles.researchDisclosure}`} open onToggle={(event) => { saveOpen(event.currentTarget.open); }}><summary>{title}<ChevronDown size={16} aria-hidden="true" /></summary><div>{children}</div></details>;
}
