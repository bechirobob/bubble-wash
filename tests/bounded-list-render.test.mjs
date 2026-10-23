import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

// Actual React static rendering. Interaction/scroll geometry is separately tested
// in list-density.worklist.mjs, not represented as verified by this test.
test('bounded list renders mounted hidden rows, accessible controls and semantic invoice rows', () => {
 const script=String.raw`
 import assert from 'node:assert/strict';
 import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
 import { tmpdir } from 'node:os';import { join,resolve } from 'node:path';import { pathToFileURL } from 'node:url';
 import ts from 'typescript';import React from 'react';import { renderToStaticMarkup } from 'react-dom/server';
 const dir=mkdtempSync(join(tmpdir(),'bubblewash-list-render-'));
 const url=p=>pathToFileURL(resolve(p)).href;
 try {
  for(const [name,source] of [['list-window','src/lib/list-window.ts'],['LoadingSkeleton','src/components/LoadingSkeleton.tsx'],['BoundedList','src/components/BoundedList.tsx']]) {
   let code=ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
   code=code.replaceAll('"react/jsx-runtime"',JSON.stringify(url('node_modules/react/jsx-runtime.js'))).replaceAll('"react"',JSON.stringify(url('node_modules/react/index.js'))).replaceAll('"./LoadingSkeleton"','"./LoadingSkeleton.mjs"').replaceAll('"@/lib/list-window"','"./list-window.mjs"');
   writeFileSync(join(dir,name+'.mjs'),code);
  }
  const {BoundedList}=await import(pathToFileURL(join(dir,'BoundedList.mjs')));
  const rows=Array.from({length:51},(_,i)=>React.createElement('article',{key:'row-'+i},React.createElement('input',{defaultValue:'Draft '+i})));
  const html=renderToStaticMarkup(React.createElement(BoundedList,{label:'Tasks',noun:'tasks',header:React.createElement('div',{'aria-hidden':true},'Header')},rows));
  assert.match(html,/1–10 of 51 tasks loaded/);assert.match(html,/Page 1 of 6/);
  assert.equal((html.match(/data-list-row-key=/g)||[]).length,51);assert.equal((html.match(/ hidden=""/g)||[]).length,41);
  assert.match(html,/aria-label="Next page of Tasks"/);assert.match(html,/role="region" aria-label="Tasks"/);
  assert.match(html,/aria-hidden="true">Header/);assert.equal((html.match(/role="listitem"/g)||[]).length,51);
  const invoice=renderToStaticMarkup(React.createElement(BoundedList,{label:'Invoice',as:'dl'},React.createElement('div',{key:'line'},React.createElement('dt',null,'Laundry'),React.createElement('dd',null,'100'))));
  assert.match(invoice,/<dl[^>]*><div[^>]*><dt>Laundry<\/dt><dd>100<\/dd><\/div><\/dl>/);assert.doesNotMatch(invoice,/role="listitem"|role="list"/);
  const empty=renderToStaticMarkup(React.createElement(BoundedList,{label:'Tasks',noun:'tasks',emptyState:React.createElement('p',null,'Nothing waiting')},[]));
  assert.match(empty,/No tasks to show/);assert.match(empty,/Nothing waiting/);assert.doesNotMatch(empty,/of 1|Next page/);
  const loading=renderToStaticMarkup(React.createElement(BoundedList,{label:'Tasks',loading:true},[]));assert.match(loading,/Loading tasks/);assert.doesNotMatch(loading,/of 1|Next page/);
 } finally {rmSync(dir,{recursive:true,force:true});}
 `;
 const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=192'}});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
