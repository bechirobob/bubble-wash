import assert from 'node:assert/strict';
import { realpathSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
export function verifiedCrossVersionRoots() {
 assert.ok(process.env.BUBBLEWASH_TEST_BASELINE_ROOT && process.env.BUBBLEWASH_TEST_FALLBACK_ROOT,
 'Cross-version acceptance requires explicit BUBBLEWASH_TEST_BASELINE_ROOT and BUBBLEWASH_TEST_FALLBACK_ROOT checkout paths.');
 const roots={baseline:realpathSync(process.env.BUBBLEWASH_TEST_BASELINE_ROOT),candidate:realpathSync(resolve(import.meta.dirname,'..')),fallback:realpathSync(process.env.BUBBLEWASH_TEST_FALLBACK_ROOT)};
 const values=Object.values(roots);
 for(let i=0;i<values.length;i++) for(let j=i+1;j<values.length;j++) assert.ok(values[i]!==values[j]&&!values[i].startsWith(values[j]+'/')&&!values[j].startsWith(values[i]+'/'),'Cross-version roots must be distinct and non-overlapping');
 const expected=JSON.parse(readFileSync(new URL('./owner-outbox-compat-sources.json',import.meta.url),'utf8'));
 for(const [kind,root] of Object.entries(roots)) {
  const actual={};
  assert.ok(lstatSync(join(root,'src')).isDirectory()&&!lstatSync(join(root,'src')).isSymbolicLink(),'Source root must be a real directory');
  for(const entry of readdirSync(join(root,'src'),{recursive:true,withFileTypes:true})) {
   assert.ok(entry.isFile()||entry.isDirectory(),'Source identity rejects symlink or special entry');
   if(entry.isDirectory()) continue;
   const file=join(entry.parentPath,entry.name); const name=file.slice(root.length+1);
   actual[name]=createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  assert.deepEqual(actual,expected[kind],`${kind} source identity differs from reviewed cross-version fixture`);
 }
 return roots;
}
