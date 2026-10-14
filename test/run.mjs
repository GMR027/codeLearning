// Compila las pruebas con esbuild (no dependen de vscode) y las ejecuta con el ejecutor de Node.
import * as esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const entries = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
rmSync(".test-dist", { recursive: true, force: true });
await esbuild.build({ entryPoints: entries, bundle: true, platform: "node", target: "node20", format: "cjs", outdir: ".test-dist", logLevel: "warning" });
const r = spawnSync(process.execPath, ["--test", ...readdirSync(".test-dist").map((f) => `.test-dist/${f}`)], { stdio: "inherit" });
process.exit(r.status ?? 1);
