import source from './source.json' with {type:'json'};
import {assertAdult,schemaVersion} from './policy.ts';
export const ids=['consumer','consumer-interview','business-interview','vendor-interview'] as const;
export type InstrumentId=typeof ids[number];
export type Answer=string|string[];
export type Answers=Record<string,Answer>;
export type Question={id:string;section:string;prompt:string;source_text:string;options?:string[];answer_specification?:string|null;suggested_input_type:string};
export const forms=source.forms.map((form,index)=>({...form,id:ids[index],questions:form.questions as Question[]}));
export const serviceDescription=source.service_description;
export function findForm(id:string){return forms.find(form=>form.id===id);}
export const personas=[['student','Students'],['business','Business owners and self-employed'],['corporate','Office and corporate workers'],['working-woman','Working women managing household responsibilities']] as const;
export function visible(q:Question,a:Answers,id:InstrumentId){
 if(id==='consumer'&&/^F[1-4]/.test(q.id)){const key=['student','business','corporate','working-woman'][Number(q.id[1])-1];return a['persona-'+key]==='Yes';}
 if(id==='consumer'){
  if(q.id==='A8a')return a.A8==='House help';
  if(q.id==='B6c')return ['Yes, regularly','Yes, occasionally'].includes(String(a.B6b));
  if(q.id==='H4')return ['H1','H2','H3'].some(key=>a[key]==='Yes');
 }
 return !(id==='vendor-interview'&&q.id==='13'&&a.hotelLaundry!=='Yes');
}
export function unresolved(q:Question,id:InstrumentId){return id==='consumer'&&['A7','F1a','H2','E3','E4','E5','E6'].includes(q.id);}
export function answerError(q:Question,value:unknown):string|null{
 if(value===undefined||value==='')return null;
 if(q.suggested_input_type==='checkboxes'){
  const max=q.id==='C1'?3:q.id==='F4c'?2:40;
  return !Array.isArray(value)||value.length>max||new Set(value).size!==value.length||value.some(v=>typeof v!=='string'||!q.options?.includes(v))?'Choose valid options within the stated limit.':null;
 }
 if(typeof value!=='string'||value.length>4000)return 'Enter a shorter answer.';
 if(q.options?.some(option=>option.includes('[')&&option===value))return 'Source placeholders are not answer choices.';
 if(q.suggested_input_type==='single_choice'&&!q.options?.includes(value))return 'Choose an available option.';
 if(q.suggested_input_type==='linear_scale'&&!['1','2','3','4','5'].includes(value))return 'Choose 1 to 5.';
 if(['number','number_or_nonresponse_choice'].includes(q.suggested_input_type)&&!q.options?.includes(value)&&(!/^\d+(\.\d{1,2})?$/.test(value)||Number(value)>100000000))return 'Enter a non-negative number.';
 return null;
}
export type Submission={adultEligible:true;instrument:InstrumentId;schemaVersion:string;submissionKey:string;identity:{name:string;organisation:string;email:string;phone:string};consent:true;answers:Answers;reference:string};
export function validate(input:unknown):Submission{
 assertAdult(input); // Deliberately before reading identity.
 const form=findForm(String(input.instrument));
 if(!form||input.schemaVersion!==schemaVersion||typeof input.submissionKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.submissionKey))throw new Error('Invalid questionnaire version or key.');
 if(input.consent!==true)throw new Error('Research consent required.');
 if(!input.identity||typeof input.identity!=='object'||Array.isArray(input.identity))throw new Error('Contact details required.');
 const identity=input.identity as Record<string,unknown>;
 const text=(key:string,max:number)=>{const v=identity[key];if(typeof v!=='string'||v.length>max)throw new Error('Invalid contact details.');return v.trim();};
 const details={name:text('name',120),organisation:text('organisation',160),email:text('email',254).toLowerCase(),phone:text('phone',40)};
 if(!details.name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)||!/^\+?[\d ()-]{7,40}$/.test(details.phone)||details.phone.replace(/\D/g,'').length<7)throw new Error('Enter a name, valid email and phone.');
 if(['business-interview','vendor-interview'].includes(form.id)&&!details.organisation)throw new Error('Organisation required.');
 if(!input.answers||typeof input.answers!=='object'||Array.isArray(input.answers))throw new Error('Invalid answers.');
 const answers=input.answers as Answers;
 const extras=new Set(form.id==='consumer'?['A3-other',...personas.map(([id])=>'persona-'+id)]:form.id==='consumer-interview'?[...personas.map(([id])=>'persona-'+id),'probe-working-woman','probe-corporate','probe-business','probe-student']:form.id==='business-interview'?['hospital']:['hotelLaundry']);
 const clean:Answers={};
 for(const [key,value]of Object.entries(answers)){
  const q=form.questions.find(q=>q.id===key);
  if(q){const error=answerError(q,value);if(error)throw new Error(error);if(!visible(q,answers,form.id))throw new Error('Answer not applicable.');if(unresolved(q,form.id)&&value!==''&&value!==undefined)throw new Error('Question content awaiting approval.');}
  else{if(!extras.has(key)||typeof value!=='string'||value.length>4000)throw new Error('Unknown or invalid field.');if(key.startsWith('probe-')&&answers['persona-'+key.slice(6)]!=='Yes')throw new Error('Persona probe not selected.');if((key.startsWith('persona-')||['hospital','hotelLaundry'].includes(key))&&!['Yes','No',''].includes(value))throw new Error('Invalid classification.');if(key==='A3-other'&&answers.A3!=='Other (specify)')throw new Error('Area clarification not applicable.');}
  clean[key]=value;
 }
 if(typeof input.reference!=='string'||!/^[a-zA-Z0-9_-]{0,80}$/.test(input.reference))throw new Error('Invalid reference.');
 return {adultEligible:true,instrument:form.id,schemaVersion,submissionKey:input.submissionKey,identity:details,consent:true,answers:clean,reference:input.reference};
}

