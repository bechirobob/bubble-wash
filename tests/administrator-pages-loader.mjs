// Execute real server page guards; replace client render trees only (no browser/CSS assertion).
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { resolve as aliasResolve } from './alias-loader.mjs';
export async function resolve(specifier, context, nextResolve) {
  const names = specifier === '@/components/StaffWorkspaces'
    ? ['AdminWorkspace','VendorWorkspace','DriverWorkspace','SupportWorkspace']
    : specifier === '@/components/research/ResearchResults' ? ['ResearchResults'] : null;
  if (names) return { url: 'data:text/javascript,' + encodeURIComponent(names.map(name => `export function ${name}(){return null}`).join(';')), shortCircuit:true };
  if (specifier === 'next/navigation') return nextResolve('next/dist/client/components/navigation.react-server.js',context);
  return aliasResolve(specifier,context,nextResolve);
}
export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) {
    const source = await readFile(new URL(url),'utf8');
    return { format:'module', shortCircuit:true, source:ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText };
  }
  return nextLoad(url,context);
}
