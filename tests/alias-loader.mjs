import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = path.join(process.cwd(), "src");

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const relativePath = specifier.slice(2);
  for (const extension of ["", ".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = path.join(sourceRoot, `${relativePath}${extension}`);
    try {
      await access(candidate);
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    } catch {
      // Try the next supported source extension.
    }
  }

  return nextResolve(specifier, context);
}
