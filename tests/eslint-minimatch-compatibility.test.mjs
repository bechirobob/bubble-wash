import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Linter, ESLint } from 'eslint';

const require = createRequire(import.meta.url);

test('legacy lint consumers retain callable matching, defaults and matcher classes', () => {
  for (const consumer of ['eslint', '@eslint/config-array', '@eslint/eslintrc', 'eslint-plugin-import', 'eslint-plugin-react', 'eslint-plugin-jsx-a11y']) {
    const fromConsumer = createRequire(require.resolve(consumer));
    const match = fromConsumer('minimatch');
    assert.equal(fromConsumer('minimatch/package.json').name, '@bubblewash/minimatch-compat');
    assert.equal(typeof match, 'function', consumer);
    assert.equal(match('src/view.tsx', 'src/*.{ts,tsx}'), true);
    assert.equal(match('src/view.js', 'src/*.{ts,tsx}'), false);
    assert.equal(match('.private', '*'), false);
    assert.equal(match.defaults({ dot: true })('.private', '*'), true);
    assert.equal(match.defaults({ dot: true }).defaults({ nocase: true })('.PRIVATE', '.private'), true);
    assert.equal(new match.Minimatch('src/!(test).tsx').match('src/view.tsx'), true);
    assert.equal(new match.Minimatch('src/!(test).tsx').match('src/test.tsx'), false);
    assert.deepEqual(['view.ts', 'view.js'].filter(match.filter('*.ts')), ['view.ts']);
    assert.deepEqual(match.match(['view.ts', 'view.js'], '*.ts'), ['view.ts']);
    assert.equal(match.makeRe('*.ts').test('view.ts'), true);
  }
});

test('actual import and React rules keep glob allowlists and diagnostics', () => {
  const linter = new Linter();
  const verify = code => linter.verify(code, [{
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { import: require('eslint-plugin-import'), react: require('eslint-plugin-react') },
    rules: { 'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }], 'react/jsx-pascal-case': ['error', { ignore: ['Legacy_*'] }] },
  }]);
  assert.deepEqual(verify('import "./theme.css"; const view = <Legacy_control />;'), []);
  assert.equal(verify('import "./side-effect.js";').filter(row => row.ruleId === 'import/no-unassigned-import').length, 1);
  assert.equal(verify('const view = <Bad_name />;').filter(row => row.ruleId === 'react/jsx-pascal-case').length, 1);
});

test('project flat config keeps generated-file ignores and TypeScript lint coverage', async () => {
  const eslint = new ESLint();
  assert.equal(await eslint.isPathIgnored('.next/server/generated.js'), true);
  assert.equal(await eslint.isPathIgnored('src/components/StaffWorkspaces.tsx'), false);
  const [result] = await eslint.lintText('const unused: number = 1;', { filePath: 'src/compatibility-probe.ts' });
  assert.ok(result.messages.some(row => row.ruleId === '@typescript-eslint/no-unused-vars'));
});


test('import internal-module allow and forbid lists retain predicate matching', () => {
  const linter = new Linter();
  const lint = (code, options) => linter.verify(code, [{
    plugins: { import: require('eslint-plugin-import') },
    rules: { 'import/no-internal-modules': ['error', options] },
  }]);
  assert.deepEqual(lint('import value from "some-package/allowed/file";', { allow: ['some-package/allowed/**'] }), []);
  assert.equal(lint('import value from "some-package/private/file";', { forbid: ['some-package/private/**'] }).filter(row => row.ruleId === 'import/no-internal-modules').length, 1);
  assert.deepEqual(lint('import value from "some-package/public/file";', { forbid: ['some-package/private/**'] }), []);
});
