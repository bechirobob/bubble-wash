export const schemaVersion = 'bubblewash-research-3';
export const launchApproved: boolean = true;
export const retentionReviewApproved: boolean = true;
export const deliveryApproved: boolean = true;
export const responseRecipient = 'info@bubblewash.co';
export function collectionWindow(env:Record<string,string|undefined>,now=Date.now()) {
  if(env.BUBBLEWASH_RESEARCH_OPEN!=='true') return false;
  const expiry=env.BUBBLEWASH_RESEARCH_CLOSES_AT;
  if(!expiry)return true;
  return Boolean( /^\d{4}-\d{2}-\d{2}T/.test(expiry) && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry)>now);
}
export function collectionOpen(env:Record<string,string|undefined>=process.env,now=Date.now()) {
  return launchApproved && retentionReviewApproved && collectionWindow(env,now);
}
export function assertAdult(input:unknown):asserts input is Record<string,unknown> {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Adult eligibility required.');
  const value=input as Record<string,unknown>;
  if(value.adultEligible!==true) throw new Error('This survey is for people aged 18 or older.');
  const a=value.answers;
  if(a && typeof a==='object' && !Array.isArray(a) && (a as Record<string,unknown>).A1==='Under 18') throw new Error('This survey is for people aged 18 or older.');
}


// Shared client/server UTF-8 ceiling for the complete serialized submission, not character count.
export const maxSubmissionBytes=65_536;
export function submissionBudget(value:unknown){
 const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;
 return {bytes,percent:Math.ceil(bytes/maxSubmissionBytes*100),remaining:Math.max(0,maxSubmissionBytes-bytes),withinLimit:bytes<=maxSubmissionBytes};
}
export function researchNotice(draft:boolean,reviewApproved=false){
 return draft?'Draft only. No real responses are being collected. Use synthetic details only.':'Your contact details remain linked to your research answers. We will contact you only for the optional purposes you choose. Email copies are held separately by the recipient; website privacy requests do not automatically remove those copies.'+(reviewApproved?' Identifiable website research records are retained for up to 12 months from collection, then reviewed for deletion or anonymisation, subject to a lawful retention obligation or justified research need. Permanent cleanup is handled separately, not automatically.':'');
}
