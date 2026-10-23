import assert from 'node:assert/strict';
import test from 'node:test';
import { listWindow } from '../src/lib/list-window.ts';

test('50 rows use five ten-row pages, with no gaps or duplicates', () => {
 const seen=[];
 for(let page=0;page<5;page++) {
  const w=listWindow(50,page);assert.equal(w.pages,5);assert.equal(w.end-w.start,10);
  for(let i=w.start;i<w.end;i++)seen.push(i);
 }
 assert.deepEqual(seen,Array.from({length:50},(_,i)=>i));
});
test('empty, short, final and shrinking lists have bounded ranges', () => {
 assert.deepEqual(listWindow(0,12),{page:0,pages:1,pageSize:10,start:0,end:0,total:0});
 assert.deepEqual(listWindow(51,5),{page:5,pages:6,pageSize:10,start:50,end:51,total:51});
 assert.equal(listWindow(3,5).page,0);assert.equal(listWindow(3,5).end,3);
 assert.equal(listWindow(50,-1).page,0);assert.equal(listWindow(50,99).page,4);
});
test('invalid and fractional sizes do not create unbounded pages', () => {
 assert.equal(listWindow(50,NaN,NaN).pageSize,10);assert.equal(listWindow(50,Infinity).page,0);
 assert.equal(listWindow(Infinity,0).total,0);assert.equal(listWindow(50,2,-3).pageSize,1);
 assert.equal(listWindow(50.9,1.7,4.9).end,8);
});


test('shared styles have no shadow decoration or trapped dispatch scroll region', async () => {
 const {readFileSync,readdirSync}=await import('node:fs');
 const {join}=await import('node:path');
 function audit(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
   const path=join(dir,entry.name);if(entry.isDirectory()) audit(path);
   else if(/\.(css|tsx|svg)$/.test(entry.name)) {
    const source=readFileSync(path,'utf8');
    for(const match of source.matchAll(/(?:box-shadow|text-shadow)\s*:\s*([^;}]+)/g))assert.equal(match[1].trim(),'none',path);
    assert.doesNotMatch(source,/drop-shadow\s*\(/,path);
   }
  }
 }
 audit(new URL('../src/',import.meta.url).pathname);
 const css=readFileSync(new URL('../src/app/globals.css',import.meta.url),'utf8');
 assert.match(css,/\.boundedListViewport \[hidden\] \{ display: none !important;/);
 assert.match(css,/overscroll-behavior: auto/);assert.match(css,/\.boundedListPages button \{ min-height: 44px/);
 assert.doesNotMatch(css,/\.dispatchStopList\s*\{[^}]*overflow/);
});
