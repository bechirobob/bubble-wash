import {validate,findForm,type Submission} from './model.ts';
import {responseRecipient} from './policy.ts';
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
export function renderEmail(input:Submission){
 const value=validate(input),form=findForm(value.instrument)!;
 const rows=[['Name',value.identity.name],['Organisation',value.identity.organisation||'Not applicable'],['Email',value.identity.email],['Phone',value.identity.phone],['Research consent','Agreed'],['Reference',value.reference],...Object.entries(value.answers).map(([key,answer])=>[key+'. '+(form.questions.find(q=>q.id===key)?.prompt??key),Array.isArray(answer)?answer.join('; '):answer])];
 return {to:responseRecipient,subject:'New Bubble Wash research response: '+form.title,text:rows.map(([k,v])=>k+'\n'+v).join('\n\n'),html:rows.map(([k,v])=>'<p><strong>'+escape(k)+'</strong><br>'+escape(v).replaceAll('\n','<br>')+'</p>').join('')};
}

