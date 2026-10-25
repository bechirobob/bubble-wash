import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const global = read('src/app/globals.css');
const survey = read('src/components/research/research.module.css');
const results = read('src/components/research/results.module.css');
test('the reference public palette is shared, not a separate public-only theme',()=>{
 const root=global.match(/:root\s*\{([^}]+)\}/)[1];
 for(const [token,value] of Object.entries({'--brand':'#086584','--brand-dark':'#064b64','--ink-strong':'#123e50','--muted':'#506671','--wash-blue':'#edf5fc','--wash-sage':'#f2f6f0','--surface':'#ffffff'}))assert.ok(root.includes(token+': '+value),token);
 assert.doesNotMatch(global.match(/\.publicSite\s*\{([^}]+)\}/)[1],/--brand|--wash/);
});
test('public survey retains its shared public identity',()=>{
 for(const css of [survey]){
  assert.match(css,/font-family:var\(--font-sans\)/);
  assert.match(css,/background:var\(--wash-blue\)/);assert.match(css,/background:var\(--wash-sage\)/);assert.match(css,/background:var\(--surface\)/);
  assert.match(css,/var\(--brand\)/);assert.doesNotMatch(css,/Arial,Helvetica|14px system-ui|#175f66|#4c927c|#143f3d/);
 }
 assert.match(read('src/app/survey/page.tsx'),/className="surveyLanding"/);
 assert.doesNotMatch(read('src/app/survey/page.tsx'),/fontFamily:/);
});
test('owner results use the accepted staff shell, palette and native touch controls',()=>{
 const ui=read('src/components/research/ResearchResults.tsx');
 assert.match(ui, /<PortalShell role="admin" allStaffAccess/);
 assert.match(ui, /title: 'Survey results'/);
 assert.match(results, /--ink:#15313e;--muted:#61727a;--brand:#08758e/);
 assert.match(results, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(results, /min-height:44px;font-size:16px/);
 assert.match(ui, /ResearchDisclosure title="Who is represented\?"/);
});
test('shared identity retains neutral edges and never introduces colored shadows',()=>{
 for(const css of [global,survey,results]){
  for(const match of css.matchAll(/(?:box-shadow|text-shadow):([^;]+);/g))assert.equal(match[1].trim(),'none');
  assert.doesNotMatch(css,/drop-shadow\(/);
 }
 assert.match(global,/--line: #dedede;/);assert.match(global,/--focus-ring: #222222;/);
});
