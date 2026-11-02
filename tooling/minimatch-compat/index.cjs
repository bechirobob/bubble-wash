"use strict";

// Legacy lint plugins call require("minimatch") directly. Keep that interface
// while delegating matching and resource limits to the patched implementation.
const modern = module.require("minimatch-modern");
function callable(api) {
  const match = (path, pattern, options) => (typeof api === "function" ? api : api.minimatch)(path, pattern, options);
  Object.assign(match, api);
  match.defaults = options => callable(api.defaults(options));
  // eslint-plugin-import only uses makeRe(pattern).test(path). Modern minimatch
  // removed regex generation; retain that predicate without building a regex.
  match.makeRe = (pattern, options) => {
    const matcher = new api.Minimatch(pattern, options);
    return { test: path => matcher.match(path) };
  };
  return match;
}
module.exports = callable(modern);
