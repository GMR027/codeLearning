import { execFile, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createServer, connect } from "net";
import { dirname, join } from "path";
import { walk, type Analysis } from "./analyzer";

/** Hito de fin de módulo: arrancar el proyecto del alumno y el original, y comparar lo que responden. */
export interface ProbeLine { url: string; ok: boolean; detail: string }
export interface ProbeResult { state: "ok" | "fail" | "unsure"; summary: string; lines: ProbeLine[]; at: number }

interface Launch { cmd: string; args: (port: number) => string[]; cwd: string; env: (port: number) => NodeJS.ProcessEnv }

const START_MS = 12_000;
const REQUEST_MS = 8_000;
const MAX_URLS = 8;

function launchFor(a: Analysis, root: string): Launch | undefined {
  const entry = a.profile?.entry;
  if (!entry) return undefined;
  if (entry.endsWith(".php")) {
    return { cmd: "php", args: (p) => ["-S", `127.0.0.1:${p}`, "-t", join(root, dirname(entry))], cwd: root, env: () => ({}) };
  }
  if (/\.(m?js|cjs)$/.test(entry)) return { cmd: process.execPath, args: () => [entry], cwd: root, env: (p) => ({ PORT: String(p) }) };
  return undefined; // TypeScript, Python, Go…: no se arranca solo
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const c = connect({ port, host: "127.0.0.1" });
    c.once("connect", () => { c.destroy(); resolve(true); });
    c.once("error", () => resolve(false));
  });

/** Páginas a comparar: la raíz y las rutas GET que se leen en el código del proyecto original. */
export async function probeUrls(root: string): Promise<string[]> {
  const urls = new Set(["/"]);
  const ok = (u: string) => u.length <= 60 && !/[:*{}]/.test(u);
  for (const f of await walk(root)) {
    if (!/\.(js|mjs|cjs|php)$/.test(f.path)) continue;
    const t = f.text ?? "";
    for (const m of t.matchAll(/(?:\.|->)get\(\s*['"`](\/[\w\-/]*)['"`]/g)) if (ok(m[1])) urls.add(m[1]);
    if (!f.path.endsWith(".php")) for (const m of t.matchAll(/\.use\(\s*['"`](\/[\w\-/]+)['"`]\s*,/g)) if (ok(m[1])) urls.add(m[1]);
  }
  return [...urls].slice(0, MAX_URLS);
}

interface Reply { status: number; location?: string; body: string }

/** Arranca el proyecto, pide cada página y lo apaga. */
async function serve(l: Launch, urls: string[]): Promise<{ replies?: Map<string, Reply>; error?: string }> {
  const port = await freePort();
  let out = "";
  let proc: ChildProcess;
  try {
    proc = spawn(l.cmd, l.args(port), { cwd: l.cwd, env: { ...process.env, ...l.env(port) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { error: (e as Error).message };
  }
  let exited = false;
  let spawnError = "";
  proc.stdout?.on("data", (d) => (out = (out + d).slice(-4000)));
  proc.stderr?.on("data", (d) => (out = (out + d).slice(-4000)));
  proc.on("exit", () => (exited = true));
  proc.on("error", (e) => { exited = true; spawnError = (e as NodeJS.ErrnoException).code === "ENOENT" ? `no está instalado «${l.cmd}»` : e.message; });
  const stop = () => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* ya terminó */ } };
  // De lo que escribió el proceso, la última línea que parece un error (las trazas de pila no ayudan al alumno).
  const lastLine = () => {
    const lines = out.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    return (([...lines].reverse().find((l) => /error|exception|fatal|cannot|not found|parse|denied|refused/i.test(l) && !/^at /.test(l)) ?? lines[lines.length - 1]) ?? "").slice(0, 240);
  };
  try {
    let target = port;
    const t0 = Date.now();
    for (;;) {
      if (spawnError) return { error: spawnError };
      if (exited) return { error: lastLine() || "el proyecto se cerró nada más arrancar" };
      if (await portOpen(target)) break;
      // Algunos proyectos ignoran PORT y escriben en qué puerto escuchan.
      const said = out.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|port|puerto)\D{0,6}(\d{4,5})/i)?.[1];
      if (said && Number(said) !== target && (await portOpen(Number(said)))) { target = Number(said); break; }
      if (Date.now() - t0 > START_MS) return { error: `no respondió en ${START_MS / 1000} s. ${lastLine()}`.trim() };
      await new Promise((r) => setTimeout(r, 200));
    }
    const replies = new Map<string, Reply>();
    for (const u of urls) {
      try {
        const res = await fetch(`http://127.0.0.1:${target}${u}`, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_MS) });
        replies.set(u, { status: res.status, location: res.headers.get("location") ?? undefined, body: (await res.text()).slice(0, 300_000) });
      } catch (e) {
        replies.set(u, { status: 0, body: (e as Error).message });
      }
    }
    return { replies };
  } finally {
    stop();
  }
}

/**
 * Lo que no cambia el resultado: comentarios HTML, espacios, y en los avisos de error las rutas absolutas y los números de línea
 * (los comentarios de las lecciones desplazan las líneas y cada proyecto vive en su carpeta).
 */
const normalize = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(?:\/[\w.\-@]+)+\/([\w.\-]+\.(?:php|m?js|cjs|ts|py))/g, "$1")
    .replace(/\bon line (?:<b>)?\d+(?:<\/b>)?/gi, "on line")
    .replace(/(\.(?:php|m?js|ts|py)):\d+(?::\d+)?/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Parecido entre dos respuestas (0-1), por palabras. */
export function similarity(a: string, b: string): number {
  const A = new Set(normalize(a).split(/\W+/).filter(Boolean));
  const B = new Set(normalize(b).split(/\W+/).filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function compareReplies(url: string, orig: Reply | undefined, mine: Reply | undefined): ProbeLine {
  if (!orig || !mine) return { url, ok: false, detail: "sin respuesta" };
  if (orig.status !== mine.status) return { url, ok: false, detail: `el original responde ${orig.status} y el tuyo ${mine.status}` };
  if (orig.location !== mine.location) return { url, ok: false, detail: `redirige a «${mine.location ?? "nada"}» y debería ir a «${orig.location ?? "nada"}»` };
  if (normalize(orig.body) === normalize(mine.body)) return { url, ok: true, detail: `${mine.status}, igual que el original` };
  const sim = similarity(orig.body, mine.body);
  if (sim >= 0.97) return { url, ok: true, detail: `${mine.status}, casi idéntico (${Math.round(sim * 100)} %)` };
  return { url, ok: false, detail: `responde ${mine.status} pero el contenido solo se parece un ${Math.round(sim * 100)} % al del original` };
}

const run = (cmd: string, args: string[], cwd: string, ms: number) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { cwd, timeout: ms, maxBuffer: 1 << 20 }, (err, so, se) => resolve({ ok: !err, out: `${so}${se}`.trim() })),
  );

/**
 * Prueba el proyecto del alumno contra el original. `fileLesson` dice en qué lección se escribe un archivo, para avisar de lo que falta.
 */
export async function runProbe(o: { a: Analysis; student: string; fileLesson?: (file: string) => number | undefined }): Promise<ProbeResult> {
  const at = Date.now();
  const done = (state: ProbeResult["state"], summary: string, lines: ProbeLine[] = []): ProbeResult => ({ state, summary, lines, at });
  const orig = launchFor(o.a, o.a.root);
  const mine = launchFor(o.a, o.student);

  if (!orig || !mine) {
    // Sin servidor que arrancar: se usan las pruebas del propio proyecto, si las tiene.
    const pkg = await readFile(join(o.student, "package.json"), "utf8").then((t) => JSON.parse(t) as { scripts?: Record<string, string> }, () => undefined);
    if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      const r = await run("npm", ["test", "--silent"], o.student, 90_000);
      return r.ok ? done("ok", "Las pruebas del proyecto pasan (`npm test`).") : done("fail", "Las pruebas del proyecto fallan (`npm test`).", [{ url: "npm test", ok: false, detail: r.out.split("\n").slice(-4).join(" ").slice(0, 300) }]);
    }
    return done("unsure", "Este tipo de proyecto no se puede arrancar solo desde aquí. Ejecútalo con los comandos de las lecciones y compara a mano con el original.");
  }

  const entry = o.a.profile!.entry!;
  if (!existsSync(join(o.student, entry))) {
    const n = o.fileLesson?.(entry);
    return done("unsure", `Todavía no se puede arrancar: falta \`${entry}\`${n !== undefined ? ` (se escribe en la lección ${n + 1})` : ""}. Este hito se podrá probar cuando lo tengas.`);
  }

  const urls = await probeUrls(o.a.root);
  const ref = await serve(orig, urls);
  if (!ref.replies) return done("unsure", `El proyecto original no arrancó, así que no hay con qué comparar: ${ref.error}`);
  const you = await serve(mine, urls);
  if (!you.replies) return done("fail", "Tu proyecto no arranca.", [{ url: "(arranque)", ok: false, detail: you.error ?? "sin detalle" }]);

  const lines = urls.map((u) => compareReplies(u, ref.replies!.get(u), you.replies!.get(u)));
  const good = lines.filter((l) => l.ok).length;
  return good === lines.length
    ? done("ok", `Tu proyecto arranca y responde igual que el original en ${good} de ${lines.length} páginas.`, lines)
    : done("fail", `Tu proyecto arranca, pero ${lines.length - good} de ${lines.length} páginas no coinciden con el original.`, lines);
}
