"use strict";

// This is intentionally not a general-purpose fast-glob implementation.
// It supports only the directory lookup used by @next/eslint-plugin-next 16.3.8.
const { statSync } = module.require("node:fs");
const { resolve } = module.require("node:path");
const { globSync: glob } = module.require("glob");
const { minimatch } = module.require("minimatch");

exports.globSync = function globSync(pattern, options) {
  if (typeof pattern !== "string" || !options || options.onlyDirectories !== true || Object.keys(options).length !== 1) {
    throw new TypeError("Next ESLint glob adapter only supports globSync(string, { onlyDirectories: true })");
  }
  if (pattern.startsWith("!") && !pattern.startsWith("!(")) return [];
  const matchPattern = resolve(pattern).replace(/\\/g, "/");
  return glob(pattern, { follow: true, dot: false }).filter((path) => {
    // glob includes the base directory for trailing **; fast-glob does not.
    if (!minimatch(resolve(path).replace(/\\/g, "/"), matchPattern, { dot: false, nonegate: true })) return false;
    try {
      return statSync(path).isDirectory();
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  });
};
