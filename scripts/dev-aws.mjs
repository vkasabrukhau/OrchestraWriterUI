// `npm run dev:aws`: `next dev` with the settings in .env.aws (written by
// scripts/aws-env.sh). Extra arguments go to next dev: `npm run dev:aws -- -p 3001`.
//
// The file is loaded here and the child inherits it, because the obvious
// `node --env-file=.env.aws .../next dev` fails: next dev copies node's flags
// into NODE_OPTIONS for its server process, and node rejects --env-file there.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);

if (!existsSync(".env.aws")) {
  console.error("No .env.aws. Run `npm run aws:env` first (see infra/README.md).");
  process.exit(1);
}
process.loadEnvFile(".env.aws");

const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => next.kill(signal));
next.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
