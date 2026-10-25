import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production scheduler with a deterministic delayed animation frame.
const source = readFileSync(new URL('../src/components/research/ResearchForm.tsx', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function scheduleHeadingFocus('), source.indexOf('export function ResearchForm'));
function fixture() {
 const listeners=new Map(), frames=[], cancelled=[];
 const body={},button={},input={value:''};
 const document={body,activeElement:button,addEventListener(type,fn,capture){assert.equal(capture,true);listeners.set(type,fn);},removeEventListener(type,fn,capture){assert.equal(capture,true);if(listeners.get(type)===fn)listeners.delete(type);}};
 let focused=0;
 const heading={focus(){focused++;document.activeElement=heading;listeners.get('focusin')?.();}};
 const context={document,requestAnimationFrame(fn){frames.push(fn);return frames.length;},cancelAnimationFrame(id){cancelled.push(id);}};
 vm.createContext(context);vm.runInContext(ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {document,input,button,heading,listeners,frames,cancelled,schedule:()=>context.scheduleHeadingFocus(()=>heading),focused:()=>focused};
}
test('unchanged navigation focus announces the destination heading and removes listeners',()=>{
 const f=fixture();f.schedule();f.frames[0]();assert.equal(f.focused(),1);assert.equal(f.listeners.size,0);
});
test('focus acquired by an answer field survives the delayed navigation frame and typing',()=>{
 const f=fixture();f.schedule();f.document.activeElement=f.input;f.listeners.get('focusin')();f.input.value='Rapid answer';f.frames[0]();assert.equal(f.document.activeElement,f.input);assert.equal(f.input.value,'Rapid answer');assert.equal(f.focused(),0);assert.equal(f.listeners.size,0);
});
for(const event of ['pointerdown','keydown'])test(`${event} interaction cancels pending heading focus even before focus changes`,()=>{
 const f=fixture();f.schedule();f.listeners.get(event)();f.frames[0]();assert.equal(f.focused(),0);assert.equal(f.listeners.size,0);
});
test('an independently acquired focus is guarded even if no focus event was observed',()=>{
 const f=fixture();f.schedule();f.document.activeElement=f.input;f.frames[0]();assert.equal(f.focused(),0);
});
test('a removed navigation button naturally releasing focus to body still announces the heading',()=>{
 const f=fixture();f.schedule();f.document.activeElement=f.document.body;f.frames[0]();assert.equal(f.focused(),1);
});
test('cancel on unmount prevents a queued frame from focusing and detaches listeners',()=>{
 const f=fixture();const cancel=f.schedule();cancel();cancel();f.frames[0]();assert.equal(f.focused(),0);assert.equal(f.listeners.size,0);
});
test('new navigation cancels the older task without cancelling the new announcement',()=>{
 const f=fixture();f.schedule()();f.schedule();f.frames[0]();assert.equal(f.focused(),0);f.frames[1]();assert.equal(f.focused(),1);assert.equal(f.listeners.size,0);
});
test('component cancels heading work on navigation replacement and unmount',()=>{
 assert.match(source,/useEffect\(\(\)=>\(\)=>pendingHeadingFocus\.current\?\.\(\),\[\]\)/);
 assert.match(source,/function move\(next:number\)\{pendingHeadingFocus\.current\?\.\(\);/);
});
