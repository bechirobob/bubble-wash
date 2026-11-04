// Bounded host adapter. Source is supplied by the reviewed administrative caller.
import { lstatSync, statSync, realpathSync, readdirSync, readlinkSync } from 'node:fs';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
import { issueSecondCohort, retrieveSecondCohort, secondCohortState } from './uat-second-cohort.mjs';
const require = value => { if (!value) throw Error('Second cohort operation refused.'); };
export async function operate(request) {
  assertUatEnvironment();
  require(request && ['inspect','issue','retrieve'].includes(request.action));
  const fields=['action','expectedDatabaseIdentity',...(request.action==='inspect'?[]:['approved','ready','operationId',...(request.action==='issue'||request.expectedStateSha256!==undefined?['expectedStateSha256']:[]),'publicKey',...(request.action==='issue'?['notBefore','approvedUntil']:[])])];
  require(Object.keys(request).sort().join()===fields.sort().join());
  const identity=request.expectedDatabaseIdentity;
  require(identity && Object.keys(identity).sort().join()==='device,inode' && ['device','inode'].every(k=>typeof identity[k]==='string' && /^[0-9]{1,20}$/.test(identity[k])));
  const filename=process.env.BUBBLEWASH_DATABASE_PATH;
  const guard=(opened=false)=>{
    require(realpathSync(filename)===filename);
    const info=lstatSync(filename,{bigint:true});
    require(info.isFile() && info.nlink===1n && String(info.dev)===identity.device && String(info.ino)===identity.inode);
    if(opened){
      const descriptors=readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===filename;}catch{return false;}});
      require(descriptors.length===1);
      const actual=statSync('/proc/self/fd/'+descriptors[0],{bigint:true});
      require(String(actual.dev)===identity.device && String(actual.ino)===identity.inode);
    }
  };
  guard();
  const {default:Database}=await import('better-sqlite3');
  const db=new Database(filename,{readonly:request.action!=='issue',fileMustExist:true,timeout:5000});
  try {
    guard(true);db.pragma('trusted_schema=OFF');db.pragma('foreign_keys=ON');
    if(request.action!=='issue')db.pragma('query_only=ON');
    const operation=db.transaction(()=>{
      guard(true);
      const result=request.action==='inspect'?{stateSha256:secondCohortState(db),inspectedAt:Date.now()}
        :request.action==='issue'?issueSecondCohort(request,db):retrieveSecondCohort(request,db);
      guard(true);return result;
    });
    return request.action==='issue'?operation.immediate():operation();
  } finally {db.close();}
}
export async function runOperator() {
  try {
    require(process.argv.length<=2 && process.env.BUBBLEWASH_PUBLIC_URL==='https://uat.bubblewash.co' &&
      process.env.BUBBLEWASH_DATABASE_PATH==='/var/lib/bubblewash-uat/uat.sqlite' && process.env.BUBBLEWASH_UAT_DATA_ROOT==='/var/lib/bubblewash-uat');
    let raw='';for await(const chunk of process.stdin){raw+=chunk;require(Buffer.byteLength(raw)<=8192);}
    const result=await operate(JSON.parse(raw));raw='';process.stdout.write(JSON.stringify(result)+'\n');
  } catch {process.stderr.write('Second cohort operation refused; outcome may be uncertain.\n');process.exitCode=1;}
}
