import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';

const root = new URL('../', import.meta.url).pathname;
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const border = /^border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?$/;
const functional = new Map([
  ['.navCta|border', '1px solid var(--brand)'],
  ['.liveShareIndicator.is-on|border-color', 'var(--brand)'],
  ['.planGrid|border-top', '2px solid var(--brand-dark)'],
  ['.quoteSummary, .trackingResult, .bookingConfirmation|border-top', '2px solid var(--brand-dark)'],
  ['.planRecommendation|border-top', '2px solid var(--brand-dark)'],
  ['.publicSite .quoteSummary|border-top', '2px solid var(--brand)'],
  ['.planChoice:has(input:checked)|border-bottom-color', 'var(--brand)'],
]);
function auditCss(source, filename) {
  const tree = postcss.parse(source, { from: filename });
  tree.walkDecls(declaration => {
    const { prop, value } = declaration;
    const selector = declaration.parent.selector;
    if (['box-shadow', 'text-shadow'].includes(prop)) assert.equal(value, 'none', filename);
    if (prop === 'filter') assert.doesNotMatch(value, /drop-shadow|url\(/i, filename);
    if (/^border-image/.test(prop)) assert.equal(value, 'none', 'Border images cannot bypass neutral edges');
    if (/^--(?:line(?:-strong|-active)?|focus-ring|surface)$/.test(prop)) assert.ok(/^#([\da-f]{2})\1\1$/i.test(value), `${selector} ${prop} must stay neutral`);
    if (/^--status-.*-line$/.test(prop)) {
      const liveStatus = { '--status-info-line':'#a9d0dc', '--status-success-line':'#b5d2bf', '--status-warning-line':'#ddc98d', '--status-danger-line':'#dfb8b2' };
      assert.equal(value, selector === ':root' ? liveStatus[prop] : 'var(--line-strong)');
    }
    if (!border.test(prop) && !['outline', 'outline-color'].includes(prop)) return;
    const exception = selector === '.install' && prop === 'border' && filename.endsWith('/WebAppInstall.module.css') ? '1px solid var(--brand)' : functional.get(`${selector}|${prop}`);
    if (exception) { assert.equal(value, exception); return; }
    if (/CanvasText|Highlight/.test(value)) {
      let parent = declaration.parent;
      while (parent && !(parent.type === 'atrule' && parent.name === 'media' && parent.params === '(forced-colors: active)')) parent = parent.parent;
      assert.ok(parent, 'System colors are reserved for forced-colors accessibility');
    }
    const remaining = value.replace(/var\(--(?:line(?:-strong|-active)?|focus-ring|surface)\)/g, '')
      .replace(/\b(?:none|solid|dashed|dotted|double|transparent|CanvasText|Highlight)\b/g, '')
      .replace(/(?:^|\s)(?:0|[\d.]+(?:px|rem|em))(?=\s|$)/g, '').trim();
    assert.equal(remaining, '', `${filename}: ${selector} { ${prop}: ${value} } must use the neutral tokens`);
  });
}

test('authored CSS retains exact live public accents and neutral staff boundaries without shadows', () => {
  for (const filename of [...files(join(root, 'src')), ...files(join(root, 'public'))].filter(file => file.endsWith('.css'))) auditCss(readFileSync(filename, 'utf8'), filename);
  for (const mutation of [':root { --line: #dbe8ec }', '.newCard { border-left: 3px solid red }', '.newCard { border-color: var(--danger) }', '.newCard { border-image: linear-gradient(red, blue) 1 }', '.newCard { box-shadow: 0 2px 8px blue }', '.newCard { filter: drop-shadow(0 2px 8px blue) }']) assert.throws(() => auditCss(mutation, 'regression.css'));
});

test('inline styles and SVG assets cannot bypass the decoration contract', () => {
  for (const filename of [...files(join(root, 'src')), ...files(join(root, 'public'))]) {
    if (!/\.(?:tsx?|svg|css)$/.test(filename)) continue;
    const source = readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /<filter\b|<fe(?:DropShadow|GaussianBlur|Offset)\b|filter\s*=\s*["']url\(/i, filename);
    if (filename.endsWith('.svg')) {
      assert.doesNotMatch(source, /(?:box-shadow|text-shadow)\s*:\s*(?!none\b)|drop-shadow\s*\(/i, filename);
      continue;
    }
    if (!/\.tsx?$/.test(filename)) continue;
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(ast).replace(/^['"]|['"]$/g, '');
        const property = name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
        if (border.test(property) || ['box-shadow', 'text-shadow', 'filter', 'outline', 'outline-color'].includes(property)) {
          assert.ok(ts.isStringLiteral(node.initializer) || ts.isNumericLiteral(node.initializer), `${filename}: style values must be statically auditable`);
          auditCss(`.inline { ${property}: ${node.initializer.text} }`, filename);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test('public accent palette and scoped neutral staff policy are both present', () => {
  const css=readFileSync(join(root,'src/app/globals.css'),'utf8');
  assert.match(css,/--brand: #086584/);
  assert.match(css,/--status-info-line: #a9d0dc/);
  assert.match(css,/\.portalPage \{ --status-info-line: var\(--line-strong\)/);
  assert.match(css,/\.staffSectionNav a\[aria-current="page"\] \{[^}]*border-bottom-color: var\(--line-active\)/);
  assert.match(css,/\.publicSite \.quoteSummary \{[^}]*border-top: 2px solid var\(--brand\)/);
});
