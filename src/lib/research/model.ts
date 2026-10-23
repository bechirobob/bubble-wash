import source from './source.json' with {type:'json'};
import {assertAdult,schemaVersion} from './policy.ts';
export const ids=['consumer','consumer-interview','business-interview','vendor-interview'] as const;
export type InstrumentId=typeof ids[number];
export type Answer=string|string[];
export type Answers=Record<string,Answer>;
export type Question={id:string;section:string;prompt:string;source_text:string;options?:string[];answer_specification?:string|null;suggested_input_type:string;required_status?:string};
export const forms=source.forms.map((form,index)=>({...form,id:ids[index],questions:form.questions as Question[]}));
export const serviceDescription=source.service_description;
export const pricingDescription=source.pricing_description;
export function findForm(id:string){return forms.find(form=>form.id===id);}
export const profiles=[['student','Students'],['business','Business owners'],['corporate','Office workers'],['household','Households']] as const;
export const eligibilityQuestions:Question[]=[
 {id:'icp-student',section:'Your profile',prompt:'Students: Do you attend university or college and live in a hall, hostel or shared accommodation?',source_text:'Setup: F1 university/college attendance and hall, hostel or shared accommodation.',options:['Yes','No'],suggested_input_type:'single_choice'},
 {id:'icp-business',section:'Your profile',prompt:'Business owners: Are you a business owner or self-employed?',source_text:'Setup: F2 business owner or self-employed.',options:['Yes','No'],suggested_input_type:'single_choice'},
 {id:'icp-corporate',section:'Your profile',prompt:'Office workers: Are you employed in an office or corporate role?',source_text:'Setup: F3 employed in an office or corporate role.',options:['Yes','No'],suggested_input_type:'single_choice'},
 {id:'icp-household',section:'Your profile',prompt:'Households: Are you a woman who works and has household laundry responsibilities?',source_text:'Setup: F4 women who work and have household laundry responsibilities; overlap permitted.',options:['Yes','No'],suggested_input_type:'single_choice'},
];
export function eligibilityNeeded(q:Question,answers:Answers){return !(q.id==='icp-business'&&answers.A4==='Business owner or self-employed'||q.id==='icp-corporate'&&answers.A4==='Employed in an office or corporate role');}
export function profileError(answers:Answers):string|null{return eligibilityQuestions.some(q=>eligibilityNeeded(q,answers)&&!['Yes','No'].includes(String(answers[q.id]??'')))?'Please answer each profile question.':null;}
export function relevantProfiles(answers:Answers){return profiles.filter(([id])=>answers['icp-'+id]==='Yes'||id==='business'&&answers.A4==='Business owner or self-employed'||id==='corporate'&&answers.A4==='Employed in an office or corporate role').map(([id])=>id);}
export function researchAnalysis(id:InstrumentId,answers:Answers){
 if(id!=='consumer')return {matchedProfiles:id==='consumer-interview'?relevantProfiles(answers):[]};
 const accra=['I live in Accra','I work in Accra','Both'].includes(String(answers.A2))?true:answers.A2==='Neither'?false:null;
 const area=String(answers.A3??'');
 return {matchedProfiles:relevantProfiles(answers),eligibleAccraSample:accra,eligibleAccraCoreAnalysis:accra,agreedAreaQuota:accra===false?false:['Tse Addo','East Legon','Airport','Cantonments','Achimota','Haatso'].includes(area)?true:area==='None of these'?false:null,areaReviewRequired:area==='Other (specify)',researchArea:area};
}
export const interviewProbes=(source.forms[1].persona_probes??[]).map((prompt,i)=>({id:'probe-'+['household','corporate','business','student'][i],section:'Questions for your profile',prompt,source_text:prompt,suggested_input_type:'paragraph',required_status:'consent_script_allows_skipping'}));
export function displayPrompt(q:Question){return q.id.startsWith('probe-')?q.prompt.replace(/^[^:]+: /,(profiles.find(([id])=>q.id==='probe-'+id)?.[1]??q.prompt.split(':')[0])+': '):q.prompt;}
export function visible(q:Question,a:Answers,id:InstrumentId){
 if(q.id.startsWith('icp-'))return eligibilityNeeded(q,a);
 if(id==='consumer'&&/^F[1-4]/.test(q.id))return relevantProfiles(a).some(profile=>profile===['student','business','corporate','household'][Number(q.id[1])-1]);
 if(id==='consumer-interview'&&q.id.startsWith('probe-'))return relevantProfiles(a).some(profile=>profile===q.id.slice(6));
 if(id==='consumer'){
  if(q.id==='A8a')return a.A8==='House help';
  if(q.id==='B6c')return ['Yes, regularly','Yes, occasionally'].includes(String(a.B6b));
  if(q.id==='H4')return ['H1','H2','H3'].some(key=>a[key]==='Yes');
 }
 return !(id==='vendor-interview'&&q.id==='13'&&a.hotelLaundry!=='Yes');
}
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
export type Submission={adultEligible:true;instrument:InstrumentId;schemaVersion:string;submissionKey:string;identity:{name:string;organisation:string;email:string;phone:string};consent:true;answers:Answers;reference:string;analysis?:ReturnType<typeof researchAnalysis>};
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
 if(['consumer','consumer-interview'].includes(form.id)){const error=profileError(answers);if(error)throw new Error(error);}
 const extras=new Set(form.id==='consumer'?['A3-other','A4-other','F1a-other']:form.id==='business-interview'?['hospital']:form.id==='vendor-interview'?['hotelLaundry']:[]);
 const clean:Answers={};
 for(const [key,value]of Object.entries(answers)){
  const q=form.questions.find(q=>q.id===key)??(form.id==='consumer-interview'?interviewProbes.find(q=>q.id===key):undefined)??(['consumer','consumer-interview'].includes(form.id)?eligibilityQuestions.find(q=>q.id===key):undefined);
  if(q){const error=answerError(q,value);if(error)throw new Error(error);if(!visible(q,answers,form.id))throw new Error('Answer not applicable.');}
  else{if(!extras.has(key)||typeof value!=='string'||value.length>4000)throw new Error('Unknown or invalid field.');if(['hospital','hotelLaundry'].includes(key)&&!['Yes','No',''].includes(value))throw new Error('Invalid classification.');if(key==='A3-other'&&answers.A3!=='Other (specify)'||key==='A4-other'&&answers.A4!=='Other'||key==='F1a-other'&&(answers.F1a!=='Other university or college (please specify)'||!relevantProfiles(answers).includes('student')))throw new Error('Clarification not applicable.');}
  clean[key]=value;
 }
 if(form.id==='consumer'){for(const [field,choice,detail] of [['A3','Other (specify)','A3-other'],['A4','Other','A4-other'],['F1a','Other university or college (please specify)','F1a-other']])if(answers[field]===choice&&(typeof answers[detail]!=='string'||!String(answers[detail]).trim()||String(answers[detail]).length>160))throw new Error('Please complete the requested clarification.');}
 if(typeof input.reference!=='string'||!/^[a-zA-Z0-9_-]{0,80}$/.test(input.reference))throw new Error('Invalid reference.');
 return {adultEligible:true,instrument:form.id,schemaVersion,submissionKey:input.submissionKey,identity:details,consent:true,answers:clean,reference:input.reference,analysis:researchAnalysis(form.id,clean)};
}

