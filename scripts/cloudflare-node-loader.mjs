const cloudflareWorkersStub = `data:text/javascript,${encodeURIComponent(`
  export const env = new Proxy({}, {
    get(_target, key) {
      return process.env[String(key)];
    },
  });
`)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: cloudflareWorkersStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
