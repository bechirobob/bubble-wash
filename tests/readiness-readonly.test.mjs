import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const root = path.resolve(import.meta.dirname, '..');
const python = `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('preserving',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(module.database_fingerprint(Path(sys.argv[2])))`;
function fingerprint(db) {
  const result = spawnSync('python3', ['-B', '-c', python, path.join(root, 'ops/deploy-preserving.py'), db], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
for (const scenario of ['complete', 'missing-staff-table', 'missing-core-table', 'missing-core-index', 'schema-mismatch', 'revoked-admin', 'missing-database']) {
  test(`readiness is read-only and fail-closed: ${scenario}`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'bubblewash-ready-'));
    try {
      const run = (mode) => {
        const result = spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types',
          '--experimental-loader=./tests/alias-loader.mjs', 'tests/readiness-readonly.fixture.mjs', directory, mode, scenario],
        { cwd: root, env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr);
      };
      run('seed');
      const db = path.join(directory, 'database.sqlite');
      const before = existsSync(db) ? fingerprint(db) : null;
      run(process.env.BUBBLEWASH_READINESS_TEST_HTTP === '1' ? 'http' : 'check');
      assert.equal(existsSync(db) ? fingerprint(db) : null, before, 'Exact preserving-deploy fingerprint must not change');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
