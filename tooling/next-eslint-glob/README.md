# Next ESLint directory-glob compatibility adapter

Project-scoped workaround, not an upstream Next.js fix or a general fast-glob replacement.

The pinned @next/eslint-plugin-next 16.3.8 consumes fast-glob only through
`globSync(pattern, { onlyDirectories: true })` in dist/utils/get-root-dirs.js.
Its dependency chain fast-glob -> micromatch -> braces includes GHSA-vfj7-8cjw-p6xm.
Registry research on 2026-10-20 found no patched braces release; stable Next ESLint
16.4.2 and canary 16.5.0-canary.19 still included that chain.

The root package's exact-version override routes that one consumer to this local
CommonJS adapter, using glob and minimatch instead. No ESLint rule is removed,
and both full and production audit gates remain unchanged. Unsupported API
options fail explicitly rather than silently changing behavior.

Regression tests exercise literal, wildcard, brace and extglob directory patterns,
relative and absolute paths, '.', './', parent traversal, trailing ** base-directory
exclusion, symlinks, hidden directories, files, missing paths, negative patterns,
separator normalization and actual Next internal-link diagnostics. Existing
`npm test` discovers these tests through tests/*.test.mjs.

Review the adapter and dependency versions on every Next ESLint upgrade. The
version guard deliberately fails tests if the upstream plugin changes. Remove
this override and local package once an upstream dependency fix is available
and full audit and regression gates pass. Do not broaden it to other consumers.

Compatibility is scoped to this project and tested root-directory patterns, not
every fast-glob edge case. Before introducing rootDir patterns combining wildcards
or symlinks with parent traversal (..), add diagnostic fixtures and review their
filesystem semantics. The current project uses the default cwd.

Sources:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/vercel/next.js/tree/canary/packages/eslint-plugin-next
- https://github.com/isaacs/node-glob
- https://github.com/isaacs/minimatch
