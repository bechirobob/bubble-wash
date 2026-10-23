import {validate,findForm,profiles,interviewProbes,eligibilityQuestions,displayPrompt,type Submission} from './model.ts';
import {responseRecipient} from './policy.ts';
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
export function renderEmail(input:Submission){
 const value=validate(input),form=findForm(value.instrument)!;
 const rows=[['Name',value.identity.name],['Organisation',value.identity.organisation||'Not applicable'],['Email',value.identity.email],['Phone',value.identity.phone],['Research consent','Agreed'],['Reference',value.reference],...Object.entries(value.answers).map(([key,answer])=>{
  const question=form.questions.find(q=>q.id===key)??interviewProbes.find(q=>q.id===key)??eligibilityQuestions.find(q=>q.id===key);
  return [key==='profile'?'Profile':key+'. '+(question?displayPrompt(question):key),Array.isArray(answer)?answer.map(v=>key==='profile'?(profiles.find(([id])=>id===v)?.[1]??'None of these'):v).join('; '):answer];
 }),...Object.entries(value.analysis??{}).map(([key,answer])=>['Research analysis: '+key,Array.isArray(answer)?answer.map(v=>profiles.find(([id])=>id===v)?.[1]??v).join('; '):answer===null?'Not determined':String(answer)])];
 return {to:responseRecipient,subject:'New Bubble Wash research response: '+form.title,text:rows.map(([k,v])=>k+'\n'+v).join('\n\n'),html:rows.map(([k,v])=>'<p><strong>'+escape(k)+'</strong><br>'+escape(v).replaceAll('\n','<br>')+'</p>').join('')};
}

