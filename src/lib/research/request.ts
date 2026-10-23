import {maxSubmissionBytes} from './policy.ts';
// No IP address, identity or submitted fields are retained by this process-local abuse guard.
// A distributed edge throttle remains required before launch.
export function createAdmissionGuard(limit=120,windowMs=60_000){
 let started=0,count=0;
 return (now=Date.now())=>{if(now-started>=windowMs||now<started){started=now;count=0;}count++;return count<=limit;};
}
export const admitResearchRequest=createAdmissionGuard();
export class RequestBoundaryError extends Error{
 status:number;
 constructor(status:number,message:string){super(message);this.status=status;}
}
export async function readBoundedJson(body:ReadableStream<Uint8Array>|null,contentLength:string|null,maxBytes=maxSubmissionBytes,timeoutMs=10_000):Promise<unknown>{
 if(contentLength!==null&&(!/^\d+$/.test(contentLength)||Number(contentLength)>maxBytes))throw new RequestBoundaryError(413,'Response too large.');
 if(!body)throw new RequestBoundaryError(400,'Missing response.');
 const reader=body.getReader();let total=0;const chunks:Uint8Array[]=[];
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new RequestBoundaryError(408,'Response timed out.'));void reader.cancel().catch(()=>{});},timeoutMs);});
 try{
  while(true){const result=await Promise.race([reader.read(),deadline]);if(result.done)break;total+=result.value.byteLength;if(total>maxBytes){void reader.cancel().catch(()=>{});throw new RequestBoundaryError(413,'Response too large.');}chunks.push(result.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RequestBoundaryError(400,'Invalid response.');}
 }finally{if(timer)clearTimeout(timer);}
}
