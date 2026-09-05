import { spawn } from "node:child_process";

// Accept the preview runner's flags while retaining Next's normal dev options.
const args = process.argv.slice(2).filter(arg => arg !== "--strictPort")
  .map(arg => arg === "--host" ? "--hostname" : arg);
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", ...args], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
