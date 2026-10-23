import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookingLabel } from '../src/lib/booking-label.ts';
const source=readFileSync(new URL('../src/components/TrackingLookup.tsx',import.meta.url),'utf8');
const effect=source.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/);
assert.ok(effect,'Tracking component keeps its bounded auto-load effect');
const run=new Function('window','fetch','setResult','setStatus','setTone',effect[1]);

for(const input of ['https://example.invalid/track#tracking=BW-R0123456789ABCDEF','https://example.invalid/track?id=BW-R0123456789ABCDEF']) {
  test('saved private link auto-loads then removes capability from browser URL: '+(input.includes('#')?'fragment':'legacy query'),async()=>{
    const replacements=[],requests=[],results=[],tones=[];
    const window={location:{href:input},history:{replaceState:(...args)=>replacements.push(args)}};
    const fetch=async(...args)=>{requests.push(args);return {ok:true,json:async()=>({ok:true,tracking:{id:'opaque',bookingReference:'BW-123'}})}};
    const cleanup=run(window,fetch,value=>results.push(value),()=>{},value=>tones.push(value));
    await new Promise(setImmediate);
    assert.deepEqual(replacements,[[null,'','/track']]);
    assert.deepEqual(requests,[['/api/track?trackingToken=BW-R0123456789ABCDEF',{cache:'no-store'}]]);
    assert.equal(bookingLabel(results[0]),'BW-123');assert.deepEqual(tones,['success']);assert.equal(typeof cleanup,'function');cleanup();
  });
}
test('empty URL performs no lookup; failure exposes no result',async()=>{
  let requested=false;
  assert.equal(run({location:{href:'https://example.invalid/track'},history:{}},()=>{requested=true},()=>{},()=>{},()=>{}),undefined);
  assert.equal(requested,false);
  const results=[],tones=[];
  run({location:{href:'https://example.invalid/track#tracking=BW-001'},history:{replaceState(){}}},async()=>({ok:false,json:async()=>({ok:false,error:'Private link required'})}),value=>results.push(value),()=>{},value=>tones.push(value));
  await new Promise(setImmediate);assert.deepEqual(results,[null]);assert.deepEqual(tones,['error']);
  assert.equal(bookingLabel({bookingReference:null}),'Legacy test booking');
});
