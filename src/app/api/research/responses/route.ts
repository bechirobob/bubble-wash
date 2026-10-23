import {after,NextRequest,NextResponse} from 'next/server';
import {collectionOpen} from '@/lib/research/policy';
import {validate} from '@/lib/research/model';
import {saveResponse} from '@/lib/research/store';
import {sameOriginJsonGuard} from '@/lib/security';
import {clientKey,isRateLimited} from '@/lib/rate-limit';
import {admitResearchRequest,readBoundedJson,RequestBoundaryError} from '@/lib/research/request';
import {researchEmailReady,dispatchResearchNotifications} from '@/lib/research/provider';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:NextRequest){
 if(!collectionOpen()||!researchEmailReady())return NextResponse.json({error:'This survey is closed. No response was saved.'},{status:503,headers});
 const guard=sameOriginJsonGuard(request.headers,'research response');if(guard)return guard;
 try{
  if(!admitResearchRequest())return NextResponse.json({error:'Please try again later.'},{status:429,headers});
  const raw=await readBoundedJson(request.body,request.headers.get('content-length'));
  let input;
  try{input=validate(raw);}catch{return NextResponse.json({error:'Check eligibility, consent and response fields.'},{status:400,headers});}
 if(isRateLimited(clientKey(request.headers,'research'),5,60_000))return NextResponse.json({error:'Please try again later.'},{status:429,headers});
  if(!collectionOpen()||!researchEmailReady())return NextResponse.json({error:'This survey is closed. No response was saved.'},{status:503,headers});
  const saved=saveResponse(input);
  after(async()=>{try{await dispatchResearchNotifications();}catch{/* Saved response remains durable; maintenance can retry pending work. */}});
  return NextResponse.json({ok:true,duplicate:saved.duplicate},{headers});
 }catch(error){
  if(error instanceof RequestBoundaryError)return NextResponse.json({error:error.message},{status:error.status,headers});
  const conflict=error instanceof Error&&error.message==='SUBMISSION_CONFLICT';
  return NextResponse.json({error:conflict?'This key already saved a different response. Your saved response is unchanged.':'Unable to save. Please try again.'},{status:conflict?409:500,headers});
 }
}

