/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS webpack build/loader interface, fixture-only. */
const ts = require('typescript');
module.exports = function(source) {return ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;};
