'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {BrandLink} from '@/components/BrandLink';
import {findForm,personas,serviceDescription,visible,unresolved,answerError,type InstrumentId,type Answers,type Question} from '@/lib/research/model';
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
 if(instrumentId==='consumer-interview'&&'persona_probes' in form){
  const probes=(form.persona_probes??[]) as string[],keys=['working-woman','corporate','business','student'];
  const questions=probes.flatMap((prompt,i)=>answers['persona-'+keys[i]]==='Yes'?[{id:'probe-'+keys[i],prompt,section:'Optional relevant questions',source_text:prompt,suggested_input_type:'paragraph'}]:[]);
  const at=groups.findIndex(g=>g.title==='Close');
  if(questions.length)groups.splice(at<0?groups.length:at,0,{title:'Optional relevant questions',questions});
 }
 const current=groups[Math.min(step-1,groups.length-1)];
 const draft=preview||!launchApproved;
 const payload={adultEligible:true,instrument:instrumentId,schemaVersion,submissionKey:'00000000-0000-0000-0000-000000000000',identity,consent:consent==='Yes',answers,reference:''};
 const budget=submissionBudget(payload);
 function exclude(){setIdentity(emptyIdentity);setAnswers({});setAdult(false);setConsent('');setExcluded(true);}
 function setAnswer(id:string,value:string|string[]){
  if(id==='A1'&&value==='Under 18'){exclude();return;}
  setAnswers(old=>{const next={...old,[id]:value};for(const q of form.questions)if(!visible(q,next,instrumentId))delete next[q.id];if(next.A3!=='Other (specify)')delete next['A3-other'];if(id.startsWith('persona-')&&value!=='Yes')delete next['probe-'+id.slice(8)];return next;});
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
  let prompt=q.prompt;
  if(instrumentId==='vendor-interview'&&q.id==='6')prompt=prompt.replace(' (Ask for a price list or photograph it, with permission.)','');
  if(instrumentId==='business-interview'&&q.id==='6'&&answers.hospital!=='Yes')prompt=prompt.replace(' Hospitals: ask about infection control and compliance documents.','');
  return <fieldset key={q.id} disabled={unresolved(q,instrumentId)}><legend>{q.id}. {prompt}</legend>
   {unresolved(q,instrumentId)&&<p className={styles.note}>Source setup is missing for this field. It is disabled for review until approved, not removed from the questionnaire.</p>}
   {['linear_scale','number_or_nonresponse_choice'].includes(kind)&&<p className={styles.hint}>{q.answer_specification}</p>}
   {options&&kind!=='number_or_nonresponse_choice'?options.filter(v=>!v.includes('[')).map(option=><label key={option} className={styles.choice}><input type={kind==='checkboxes'?'checkbox':'radio'} name={q.id} checked={Array.isArray(value)?value.includes(option):value===option} onChange={e=>setAnswer(q.id,kind==='checkboxes'?(e.target.checked?[...(Array.isArray(value)?value:[]),option]:(Array.isArray(value)?value:[]).filter(v=>v!==option)):option)}/>{option}</label>)
   :kind==='number_or_nonresponse_choice'?<><label htmlFor={q.id}>Amount</label><input id={q.id} type="number" min="0" step="0.01" value={options?.includes(String(value))?'':String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/>{options?.map(option=><label key={option} className={styles.choice}><input type="radio" name={q.id} checked={value===option} onChange={()=>setAnswer(q.id,option)}/>{option}</label>)}</>
   :kind==='optional_contact_group'?<><p>Name, phone and email were supplied before the questions. The optional purposes above remain separate choices.</p><p className={styles.note}>{draft?'No enrollment or contact occurs in this draft.':'Your choices above apply only to the purposes you selected. Giving contact details at the start does not opt you into updates or pilot contact.'}</p></>
   :kind==='number'?<><label htmlFor={q.id}>Your answer {q.id.startsWith('E')?'(GH¢)':''}</label><input id={q.id} type="number" min="0" step="0.01" value={String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/></>
   :<><label htmlFor={q.id}>Your answer (optional)</label><textarea id={q.id} maxLength={4000} value={String(value)} onChange={e=>setAnswer(q.id,e.target.value)}/></>}
   {q.id==='A3'&&value==='Other (specify)'&&<><label htmlFor="A3-other">Specify area</label><input id="A3-other" maxLength={160} value={String(answers['A3-other']??'')} onChange={e=>setAnswer('A3-other',e.target.value)}/></>}
  </fieldset>;
 }
 const logo=<BrandLink/>;
 if(excluded)return <main className={styles.shell}>{logo}<h1>This survey is for people aged 18 or older.</h1><p>No personal details or answers have been saved or emailed.</p><Link href="/">Back to Bubble Wash</Link></main>;
 if(!adult)return <main className={styles.shell}>{logo}{preview&&<p className={styles.note}>Preview · Not live</p>}<h1>Before you start</h1><p>This research is for people aged 18 or older. Please confirm your eligibility before entering any personal details.</p><fieldset><legend>Are you 18 or older?</legend><div className={styles.actions}><button type="button" onClick={exclude}>No, I am under 18</button><button type="button" onClick={()=>setAdult(true)}>Yes, I am 18 or older</button></div></fieldset></main>;
 if(ended)return <main className={styles.shell}>{logo}<h1>You can stop here.</h1><p>No response has been submitted. Thank you for your time.</p><Link href="/">Back to Bubble Wash</Link></main>;
 if(saved)return <main className={styles.shell}>{logo}<p className={styles.saved} role="status">✓ RESPONSE SAVED</p><h1>Thank you!</h1><p>Your answers will help us build something that actually works for you.</p><div className={styles.receipt}><p>01 · Your answers are saved.</p><p>02 · Our team will read them.</p><p>03 · We’ll follow up only for the updates or activities you chose.</p></div><Link href="/">Back to Bubble Wash</Link></main>;
 return <main className={styles.shell}>{logo}{preview&&<p className={styles.note}>Unpublished preview · No submission or email</p>}<p className={styles.hint}>{form.title}</p><h1 ref={heading} tabIndex={-1}>{step===0?'Your details':step>groups.length?'Review and submit':current.title}</h1><progress aria-label="Questionnaire progress" max={groups.length+1} value={step}/><p className={styles.hint}>{step===0?'Before the questionnaire':`Step ${Math.min(step,groups.length)} of ${groups.length}`}</p>
 <form onSubmit={e=>{e.preventDefault();if(!budget.withinLimit){setError('Please shorten some answers to stay within the total response size limit.');return;}if(step===0&&consent!=='Yes'){setError('Choose whether you agree to take part.');return;}for(const q of (step?current?.questions:[])??[]){const issue=answerError(q,answers[q.id]);if(issue){setError(q.id+': '+issue);return;}}move(step+1);}}>
 {step===0?<><label htmlFor="name">Full name</label><input id="name" autoComplete="name" maxLength={120} required value={identity.name} onChange={e=>setIdentity({...identity,name:e.target.value})}/>
 {business&&<><label htmlFor="organisation">Organisation</label><input id="organisation" autoComplete="organization" maxLength={160} required value={identity.organisation} onChange={e=>setIdentity({...identity,organisation:e.target.value})}/></>}
 <label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" maxLength={254} required value={identity.email} onChange={e=>setIdentity({...identity,email:e.target.value})}/>
 <label htmlFor="phone">Phone number</label><input id="phone" type="tel" autoComplete="tel" maxLength={40} required value={identity.phone} onChange={e=>setIdentity({...identity,phone:e.target.value})}/>
 <p>This is an interim version of the research questionnaire. Some questions are not included yet. Taking part is voluntary; you may skip research questions or stop before submitting.</p><p>Bubble Wash uses your name, email, phone, organisation where applicable and answers to understand laundry habits and service needs. Your details are required and linked to your answers: this is not anonymous. Your completed response is stored by Bubble Wash and emailed in full to info@bubblewash.co for the research team. Separate choices below control launch updates and pilot contact.</p><p>For access, correction or deletion requests, use our <Link href="/privacy">privacy request form</Link> or contact <a href="mailto:info@bubblewash.co">info@bubblewash.co</a>.</p>
 <p className={styles.note}>{researchNotice(draft,retentionReviewApproved)}</p>
 <fieldset><legend>I agree to Bubble Wash collecting and storing my details and answers for the research described.</legend>{['Yes','No'].map(v=><label key={v} className={styles.choice}><input type="radio" name="consent" checked={consent===v} onChange={()=>{if(v==='No'){setIdentity(emptyIdentity);setAnswers({});setEnded(true);}setConsent(v);}}/>{v==='Yes'?'Yes, I agree':'No, I do not agree (end survey)'}</label>)}</fieldset>
 {(consumer||instrumentId==='consumer-interview')&&<fieldset><legend>Optional sections: choose any that are relevant to you.</legend><p>No section is selected automatically. You can leave all unchecked.</p>{personas.map(([id,label])=><label className={styles.choice} key={id}><input type="checkbox" checked={answers['persona-'+id]==='Yes'} onChange={e=>setAnswer('persona-'+id,e.target.checked?'Yes':'No')}/>{label}</label>)}</fieldset>}
 {instrumentId==='business-interview'&&<label>Is your organisation a hospital?<select value={String(answers.hospital??'')} onChange={e=>setAnswer('hospital',e.target.value)}><option value="">Not specified</option><option>Yes</option><option>No</option></select></label>}
 {instrumentId==='vendor-interview'&&<label>Is this a hotel laundry?<select value={String(answers.hotelLaundry??'')} onChange={e=>setAnswer('hotelLaundry',e.target.value)}><option value="">Not specified</option><option>Yes</option><option>No</option></select></label>}

 </>:step<=groups.length?<>{current.questions.some(q=>q.id==='E1'||(instrumentId==='consumer-interview'&&q.id==='12'))&&<p>{serviceDescription}</p>}{consumer&&current.questions.some(q=>['E3','E4','E5','E6'].includes(q.id))&&<p className={styles.note}>The source bag-size definition is missing. These pricing fields remain disabled.</p>}{current.questions.map(field)}</>:<>{consumer&&<><label htmlFor="reference">Reference code (please leave as it is)</label><input id="reference" readOnly value={preview?'preview':''}/></>}<p>{preview?'Preview complete. No response is saved or emailed.':'Use Back to check your answers, or submit your response.'}</p>{!preview&&<div className={styles.actions}><button type="button" disabled={sending||!budget.withinLimit} onClick={submit}>{sending?'Saving…':'Submit response'}</button></div>}<Link href="/survey">Questionnaire choices</Link></>}
 <p className={styles.hint} aria-live="polite">Overall response length: {budget.percent}% of the limit. {!budget.withinLimit&&'Please shorten one or more answers before continuing or submitting.'}</p>
 {error&&<p role="alert" className={styles.error}>{error}</p>}<div className={styles.actions}>{step>0&&<button type="button" disabled={sending} onClick={()=>move(step-1)}>Back</button>}{step<=groups.length&&<button type="submit" disabled={!budget.withinLimit}>Continue</button>}</div></form></main>;
}

