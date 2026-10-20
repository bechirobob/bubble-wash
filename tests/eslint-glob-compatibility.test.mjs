import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { Linter } from "eslint";

const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const plugin = require("@next/eslint-plugin-next");
const { getRootDirs } = pluginRequire("./utils/get-root-dirs.js");
const canonical = (paths) => paths.map((path) => normalize(path).replace(/[\\/]$/, "")).sort();

test("Next ESLint keeps directory discovery and internal-link diagnostics with the safe glob replacement", () => {
  const fixture = mkdtempSync(join(tmpdir(), "bubblewash-eslint-glob-"));
  try {
    for (const name of ["alpha", "beta", ".hidden"]) {
      mkdirSync(join(fixture, name, "pages"), { recursive: true });
      writeFileSync(join(fixture, name, "pages", "about.js"), "export default function Page() {}\n");
    }
    writeFileSync(join(fixture, "not-a-directory"), "fixture");
    const alpha = join(fixture, "alpha");
    const beta = join(fixture, "beta");
    const linked = join(fixture, "linked");
    symlinkSync(alpha, linked, "dir");
    const roots = (rootDir) => getRootDirs({ cwd: fixture, settings: { next: { rootDir } } });
    assert.deepEqual(roots(undefined), [fixture]);
    assert.deepEqual(canonical(roots(alpha)), [alpha]);
    assert.deepEqual(canonical(roots(`${fixture}/*`)), [alpha, beta, linked]);
    assert.deepEqual(canonical(roots(`${fixture}/{alpha,beta}`)), [alpha, beta]);
    assert.deepEqual(canonical(roots([alpha, beta])), [alpha, beta]);
    assert.deepEqual(roots(`${fixture}/missing-*`), []);
    assert.deepEqual(roots(`!${fixture}/*`), []);
    assert.deepEqual(canonical(roots(`${fixture}/alpha/**`)), [join(alpha, "pages")]);
    const relativePattern = relative(process.cwd(), alpha);
    assert.deepEqual(roots(relativePattern).map((path) => resolve(path)), [alpha]);
    for (const current of [".", "./", "././"]) {
      assert.deepEqual(roots(current).map((path) => resolve(path)), [process.cwd()]);
    }
    assert.deepEqual(roots(`././${relativePattern}`).map((path) => resolve(path)), [alpha]);
    assert.deepEqual(roots(`${relativePattern}/../alpha`).map((path) => resolve(path)), [alpha]);
    assert.deepEqual(roots(`${relativePattern}/**`).map((path) => resolve(path)), [join(alpha, "pages")]);
    assert.deepEqual(canonical(roots(`${fixture}/.hidden`)), [join(fixture, ".hidden")]);
    assert.deepEqual(roots(join(fixture, "not-a-directory")), []);
    assert.deepEqual(canonical(roots(`${fixture}/!(beta|linked)`)), [alpha]);
    assert.deepEqual(canonical(roots(linked)), [linked]);
    assert.deepEqual(canonical(roots(alpha.replace(/\//g, "\\"))), [alpha]);

    const lint = (code, rootDir) => new Linter().verify(code, [{
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { "@next/next": plugin },
      settings: { next: { rootDir } },
      rules: { "@next/next/no-html-link-for-pages": "error" },
    }]);
    for (const rootDir of [alpha, relativePattern, `././${relativePattern}`, `${relativePattern}/../alpha`, `${fixture}/*`, `${fixture}/{alpha,beta}`, [alpha, beta]]) {
      const messages = lint('const link = <a href="/about">About</a>;', rootDir);
      assert.ok(messages.some((message) => message.ruleId === "@next/next/no-html-link-for-pages" && message.severity === 2));
      assert.deepEqual(lint('const link = <a href="https://example.com/about">About</a>;', rootDir), []);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the compatibility override remains pinned to the reviewed Next plugin API", () => {
  assert.equal(pluginRequire("../package.json").version, "16.3.8");
  assert.equal(pluginRequire("fast-glob/package.json").name, "@bubblewash/next-eslint-glob");
  assert.equal(pluginRequire("fast-glob/package.json").version, "1.0.0");
  const adapter = pluginRequire("fast-glob");
  assert.equal(typeof adapter.globSync, "function");
  assert.throws(() => adapter.globSync("*", { onlyDirectories: false }), TypeError);
  assert.throws(() => adapter.globSync("*", { onlyDirectories: true, ignore: "x" }), TypeError);
  assert.throws(() => adapter.globSync(["*"], { onlyDirectories: true }), TypeError);
  assert.throws(() => adapter.globSync("*"), TypeError);
  // A future upstream upgrade must receive an explicit compatibility review.
  const source = readFileSync(join(dirname(require.resolve("@next/eslint-plugin-next")), "utils/get-root-dirs.js"), "utf8");
  assert.match(source, /_fastglob\.globSync/);
  assert.match(source, /onlyDirectories: true/);
});
