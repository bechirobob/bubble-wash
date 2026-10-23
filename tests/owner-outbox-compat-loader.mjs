import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
const candidate=pathResolve(dirname(fileURLToPath(import.meta.url)),'..');
import { verifiedCrossVersionRoots } from './owner-outbox-compat-roots.mjs';
const roots=Object.values(verifiedCrossVersionRoots());
export async function resolve(specifier,context,nextResolve) {
 if(specifier==='next/server')return nextResolve('next/server.js',context);
 if(!specifier.startsWith('@/'))return nextResolve(specifier,context);
 const parent=context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):'';
 const root=roots.find(root=>parent.startsWith(root+'/'))||candidate;
 for(const extension of ['', '.ts','.tsx','.js','.mjs']) {
  const file=join(root,'src',specifier.slice(2)+extension);
  try{await access(file);return {url:pathToFileURL(file).href,shortCircuit:true};}catch{}
 }
 return nextResolve(specifier,context);
}
