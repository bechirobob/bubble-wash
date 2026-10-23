'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {BrandLink} from '@/components/BrandLink';
import {findForm,eligibilityQuestions,interviewProbes,displayPrompt,serviceDescription,pricingDescription,visible,answerError,type InstrumentId,type Answers,type Question} from '@/lib/research/model';
import {schemaVersion,launchApproved,retentionReviewApproved,submissionBudget,researchNotice} from '@/lib/research/policy';
import styles from './research.module.css';
const emptyIdentity={name:'',organisation:'',email:'',phone:''};
export function ResearchForm({instrumentId,preview=false}:{instrumentId:InstrumentId;preview?:boolean}){
 const form=findForm(instrumentId)!;
 const [adult,setAdult]=useState(false),[excluded,setExcluded]=useState(false),[ended,setEnded]=useState(false),[saved,setSaved]=useState(false);
 const [identity,setIdentity]=useState(emptyIdentity),[answers,setAnswers]=useState<Answers>({}),[consent,setConsent]=useState('');
 const [step,setStep]=useState(0),[error,setError]=useState(''),[sending,setSending]=useState(false);
 const key=useRef(''),locked=useRef(false),heading=useRef<HTMLHeadingElement>(null);
 const consumer=instrumentId==='consumer',business=['business-interview','vendor-interview'].includes(instrumentId);
 const groups:{title:string;questions:Question[]}[]=[];
 for(const q of form.questions.filter(q=>visible(q,answers,instrumentId))){
  const last=groups.at(-1);
  if(!last||last.title!==q.section||last.questions.length===3)groups.push({title:q.section,questions:[q]});else last.questions.push(q);
 }
 if(consumer||instrumentId==='consumer-interview'){
  const at=groups.findIndex(g=>consumer?!g.title.startsWith('Section A'):g.title!=='Warm-up');
  groups.splice(at<0?groups.length:at,0,{title:'Your profile',questions:eligibilityQuestions.slice(0,2).filter(q=>visible(q,answers,instrumentId))},{title:'Your profile',questions:eligibilityQuestions.slice(2).filter(q=>visible(q,answers,instrumentId))});
 }
 if(instrumentId==='consumer-interview'){
  const questions=interviewProbes.filter(q=>visible(q,answers,instrumentId));
  const at=groups.findIndex(g=>g.title==='Close');
  const probeGroups=[];for(let i=0;i<questions.length;i+=3)probeGroups.push({title:'Questions for your profile',questions:questions.slice(i,i+3)});
  groups.splice(at<0?groups.length:at,0,...probeGroups);
 }
 const current=groups[Math.min(step-1,groups.length-1)];
 const draft=preview||!launchApproved;
 const sectionTitle=(title:string)=>title.startsWith('Section F')?['Students','Business owners','Office workers','Households'][Number(title[9])-1]??title:title;
 const payload={adultEligible:true,instrument:instrumentId,schemaVersion,submissionKey:'00000000-0000-0000-0000-000000000000',identity,consent:consent==='Yes',answers,reference:''};
 const budget=submissionBudget(payload);
 function exclude(){setIdentity(emptyIdentity);setAnswers({});setAdult(false);setConsent('');setExcluded(true);}
 function setAnswer(id:string,value:string|string[]){
  if(id==='A1'&&value==='Under 18'){exclude();return;}
  setAnswers(old=>{const next={...old,[id]:value};for(const q of [...form.questions,...eligibilityQuestions,...(instrumentId==='consumer-interview'?interviewProbes:[])])if(!visible(q,next,instrumentId))delete next[q.id];if(next.A3!=='Other (specify)')delete next['A3-other'];if(next.A4!=='Other')delete next['A4-other'];if(next.F1a!=='Other university or college (please specify)')delete next['F1a-other'];return next;});
 }
 function move(next:number){setError('');setStep(next);requestAnimationFrame(()=>heading.current?.focus());}
 async function submit(){
  if(preview||!adult||excluded||answers.A1==='Under 18'||locked.current)return;
  if(!budget.withinLimit){setError('Your response is over the total size limit. Please shorten some answers before submitting.');return;}
  locked.current=true;setSending(true);setError('');key.current ||= crypto.randomUUID();
  try{
   const response=await fetch('/api/research/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,submissionKey:key.current})});
   const result=await response.json();if(!response.ok||result.ok!==true)throw new Error(result.error||'Unable to save. Please try again.');
   setSaved(true);setIdentity(emptyIdentity);setAnswers({});
  }catch(e){setError(e instanceof Error?e.message:'Unable to save. Please try again.');}
  finally{locked.current=false;setSending(false);}
 }
 function field(q:Question){
  const value=answers[q.id]??'',kind=q.suggested_input_type;
  const options=kind==='linear_scale'?['1','2','3','4','5']:q.options;
  let prompt=displayPrompt(q);
  if(instrumentId==='business-interview'&&q.id==='6'&&answers.hospital!=='Yes')prompt=prompt.replace(' Hospitals: ask about infection control and compliance documents.','');
  return <fieldset key={q.id}><legend>{q.id.startsWith('probe-')||q.id.startsWith('icp-')?'':q.id+'. '}{prompt}</legend>
   {['linear_scale','number_or_nonresponse_choice'].includes(kind)&&<p className={styles.hint}>{q.answer_specification}</p>}
   {options&&kind!=='number_or_nonresponse_choice'?options.filter(v=>!v.includes('[')).map(option=><label key={option} className={styles.choice}><input type={kind==='checkboxes'?'checkbox':'radio'} name={q.id} required={q.id.startsWith('icp-')} checked={Array.isArray(value)?value.includes(option):value===option} onChange={e=>setAnswer(q.id,kind==='checkboxes'?(e.target.checked?[...(Array.isArray(value)?value:[]),option]:(Array.isArray(value)?value:[]).filter(v=>v!==option)):option)}/>{option}</label>)
   :kind==='number_or_nonresponse_choice'?<><label htmlFor={q.id}>Amount</label><input id={q.id} type="number" min="0" step="0.01" value={options?.includes(String(value))?'':String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/>{options?.map(option=><label key={option} className={styles.choice}><input type="radio" name={q.id} checked={value===option} onChange={()=>setAnswer(q.id,option)}/>{option}</label>)}</>
   :kind==='optional_contact_group'?<><p>Name, phone and email were supplied before the questions. The optional purposes above remain separate choices.</p><p className={styles.note}>{draft?'No enrollment or contact occurs in this draft.':'Your choices above apply only to the purposes you selected. Giving contact details at the start does not opt you into updates or pilot contact.'}</p></>
   :kind==='number'?<><label htmlFor={q.id}>Your answer {q.id.startsWith('E')?'(GH¢)':''}</label><input id={q.id} type="number" min="0" step="0.01" value={String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/></>
   :<><label htmlFor={q.id}>Your answer{q.required_status==='explicit_optional'||!consumer?' (optional)':''}</label><textarea id={q.id} maxLength={4000} value={String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/></>}
   {q.id==='A3'&&value==='Other (specify)'&&<><label htmlFor="A3-other">Specify area</label><input id="A3-other" required maxLength={160} value={String(answers['A3-other']??'')} onChange={e=>setAnswer('A3-other',e.target.value)}/></>}
   {q.id==='A4'&&value==='Other'&&<><label htmlFor="A4-other">Please describe your work/study category.</label><input id="A4-other" required maxLength={160} value={String(answers['A4-other']??'')} onChange={e=>setAnswer('A4-other',e.target.value)}/></>}
   {q.id==='F1a'&&value==='Other university or college (please specify)'&&<><label htmlFor="F1a-other">Specify university or college</label><input id="F1a-other" required maxLength={160} value={String(answers['F1a-other']??'')} onChange={e=>setAnswer('F1a-other',e.target.value)}/></>}
  </fieldset>;
 }
 const logo=<BrandLink/>;
 if(excluded)return <main className={styles.shell}>{logo}<h1>This survey is for people aged 18 or older.</h1><p>No personal details or answers have been saved or emailed.</p><Link href="/">Back to Bubble Wash</Link></main>;
 if(!adult)return <main className={styles.shell}>{logo}{preview&&<p className={styles.note}>Preview · Not live</p>}<h1>Before you start</h1><p>Please confirm your age before sharing your details.</p><fieldset><legend>Are you 18 or older?</legend><div className={styles.actions}><button type="button" onClick={exclude}>No, I am under 18</button><button type="button" onClick={()=>setAdult(true)}>Yes, I am 18 or older</button></div></fieldset></main>;
 if(ended)return <main className={styles.shell}>{logo}<h1>You can stop here.</h1><p>No response has been submitted. Thank you for your time.</p><Link href="/">Back to Bubble Wash</Link></main>;
 if(saved)return <main className={styles.shell}>{logo}<p className={styles.saved} role="status">✓ RESPONSE SAVED</p><h1>Thank you!</h1><p>You’re helping us make laundry work better for you.</p><div className={styles.receipt}><p>We’ll only contact you for the options you chose.</p></div><Link href="/">Back to Bubble Wash</Link></main>;
 return <main className={styles.shell}>{logo}{preview&&<p className={styles.note}>Unpublished preview · No submission or email</p>}{step>0&&<p className={styles.hint}>{form.title}</p>}<h1 ref={heading} tabIndex={-1}>{step===0?'Your details':step>groups.length?'Review and submit':sectionTitle(current.title)}</h1><p>{step===0?'Help shape better laundry.':null}</p>{step>0&&<><progress aria-label="Questionnaire progress" max={groups.length+1} value={step}/><p className={styles.hint}>{`Step ${Math.min(step,groups.length)} of ${groups.length}`}</p></>}
 <form onSubmit={e=>{e.preventDefault();if(!budget.withinLimit){setError('Please shorten some answers to stay within the total response size limit.');return;}if(step===0&&consent!=='Yes'){setError('Choose whether you agree to take part.');return;}for(const q of (step?current?.questions:[])??[]){const issue=answerError(q,answers[q.id]);if(issue){setError(q.id+': '+issue);return;}}move(step+1);}}>
 {step===0?<><p className={styles.hint}>All details below are required.</p><label htmlFor="name">Full name</label><input id="name" autoComplete="name" maxLength={120} required value={identity.name} onChange={e=>setIdentity({...identity,name:e.target.value})}/>
 {business&&<><label htmlFor="organisation">Organisation</label><input id="organisation" autoComplete="organization" maxLength={160} required value={identity.organisation} onChange={e=>setIdentity({...identity,organisation:e.target.value})}/></>}
 <label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" maxLength={254} required value={identity.email} onChange={e=>setIdentity({...identity,email:e.target.value})}/>
 <label htmlFor="phone">Phone number</label><input id="phone" type="tel" autoComplete="tel" maxLength={40} required value={identity.phone} onChange={e=>setIdentity({...identity,phone:e.target.value})}/>
 <p className={styles.privacySummary}>Bubble Wash stores your details and answers and emails them in full to <a href="mailto:info@bubblewash.co">info@bubblewash.co</a> for research. Your response is not anonymous. Participation is voluntary. You may skip {consumer?'optional questions':'any question'} or stop before submitting.</p>
 <details className={styles.more}><summary>More information</summary><p>Bubble Wash Technologies Ltd., Eugene’s Place, Accra, Ghana, uses your details and answers to understand laundry habits and service needs.</p><p>{researchNotice(draft,retentionReviewApproved)}</p><p>For access, correction or deletion requests, use our <Link href="/privacy">privacy request form</Link> or email <a href="mailto:info@bubblewash.co">info@bubblewash.co</a>.</p></details>
 <fieldset className={styles.consent}><legend>Research consent</legend>{['Yes','No'].map(v=><label key={v} className={styles.choice}><input type="radio" name="consent" checked={consent===v} onChange={()=>{if(v==='No'){setIdentity(emptyIdentity);setAnswers({});setEnded(true);}setConsent(v);}}/>{v==='Yes'?'Yes, I agree':'No, I do not agree (end survey)'}</label>)}</fieldset>
 {instrumentId==='business-interview'&&<label>Is your organisation a hospital?<select value={String(answers.hospital??'')} onChange={e=>setAnswer('hospital',e.target.value)}><option value="">Not specified</option><option>Yes</option><option>No</option></select></label>}
 {instrumentId==='vendor-interview'&&<label>Is this a hotel laundry?<select value={String(answers.hotelLaundry??'')} onChange={e=>setAnswer('hotelLaundry',e.target.value)}><option value="">Not specified</option><option>Yes</option><option>No</option></select></label>}

 </>:step<=groups.length?<>{current.questions.some(q=>q.id==='E1'||(instrumentId==='consumer-interview'&&q.id==='12'))&&<p>{serviceDescription}</p>}{consumer&&current.questions.some(q=>['E3','E4','E5','E6'].includes(q.id))&&<p className={styles.note}>{pricingDescription}</p>}{current.questions.map(field)}</>:<><p>{preview?'Preview complete. No response is saved or emailed.':'Use Back to check your answers, or submit your response.'}</p>{!preview&&<div className={styles.actions}><button type="button" disabled={sending||!budget.withinLimit} onClick={submit}>{sending?'Saving…':'Submit response'}</button></div>}<Link href="/survey">Questionnaire choices</Link></>}
 {(step>0||budget.percent>75)&&<p className={styles.hint} aria-live="polite">Overall response length: {budget.percent}% of the limit. {!budget.withinLimit&&'Please shorten one or more answers before continuing or submitting.'}</p>}
 {error&&<p role="alert" className={styles.error}>{error}</p>}<div className={styles.actions}>{step>0&&<button type="button" disabled={sending} onClick={()=>move(step-1)}>Back</button>}{step<=groups.length&&<button type="submit" disabled={!budget.withinLimit}>Continue</button>}</div></form></main>;
}

