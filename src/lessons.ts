import { execFile } from "child_process";
import { readdir, readFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize } from "path";
import { LANG_NAMES, LEVEL_NAMES, walk, type Analysis, type Entry } from "./analyzer";
import type { ProbeResult } from "./milestones";

// ---- Tipos y estado guardado en learning/progreso.json ----------------------------

export interface CodeBlock {
  /** Ruta relativa: igual en el proyecto analizado y en el del alumno. */
  file: string;
  /** Lo que ve el alumno: el tramo de código con las anotaciones como comentarios. */
  display: string;
  /** El tramo limpio de esta lección. */
  shown: string;
  /** Todo el archivo de referencia hasta el final de este tramo (el alumno va construyendo el archivo lección a lección). */
  ref: string;
  /** Líneas del tramo dentro del archivo original y total de líneas. */
  from: number;
  to: number;
  total: number;
  /** Archivo de librería: se copia del proyecto original, no se escribe. */
  copy?: boolean;
  /** `file` es una carpeta de recursos. */
  dir?: boolean;
  /** El tramo empieza dentro de un bloque <?php (para colocar bien los comentarios). */
  phpStart?: boolean;
  /** Notas que no caben como comentarios (JSON): qué hace cada parte, por línea. */
  notes?: { line: number; text: string }[];
}
export interface LessonCommand { cmd: string; why: string }
export interface LessonContent { title: string; objective: string; topics: string[]; scope: string; blocks: CodeBlock[]; checks: string[]; /** Comandos de terminal de esta lección (instalar, compilar, arrancar…). */ commands?: LessonCommand[] }
export interface Issue { where: string; why: string; fix: string }
export interface CheckResult { state: "ok" | "fail" | "unsure"; summary: string; issues: Issue[]; at: number; /** Errores frecuentes reconocidos sin IA, con su arreglo. */ tips?: string[] }
export interface LessonState {
  content?: LessonContent;
  mdFile?: string;
  status: "pending" | "done" | "skipped";
  attempts: number;
  hints: string[];
  chat: { role: "user" | "assistant"; text: string }[];
  solutionShown: boolean;
  last?: CheckResult;
  /** Cuándo abrió y cuándo terminó la lección (para el tiempo real y la racha). */
  startedAt?: number;
  doneAt?: number;
  /** Último hito de fin de módulo probado desde esta lección. */
  probe?: ProbeResult;
}
export interface Progress { v: 1; /** Último repaso de lecciones anteriores. */ regress?: RegressResult; /** Días (AAAA-MM-DD) con actividad, para la racha. */ days?: string[]; /** Identidad del proyecto: reconoce el avance aunque la carpeta se mueva. */ id?: string; root: string; base: string; current: number; lessons: Record<string, LessonState>; updated: number }

/**
 * El avance guardado encaja con el temario actual: las lecciones con contenido apuntan a los mismos archivos y tramos.
 * Si el temario cambió (otro orden o otros archivos), mezclar los dos marcaría lecciones equivocadas como hechas.
 */
export function progressFits(p: { lessons: Record<string, { content?: { blocks: { file: string; from: number }[] } }> }, a: Analysis): boolean {
  const cur = a.curriculum;
  const idx = Object.keys(p.lessons).map(Number);
  if (!cur || !idx.length) return false;
  let checked = 0;
  for (const i of idx) {
    if (i >= cur.length) return false;
    const b = p.lessons[i]?.content?.blocks;
    if (!b?.length) continue;
    const parts = cur[i].parts;
    if (b.length !== parts.length || b.some((x, k) => x.file !== parts[k].file || x.from !== parts[k].from)) return false;
    checked++;
  }
  return checked > 0;
}

export type Ask = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;
export type AskText = Ask;

/** Líneas de referencia por archivo y archivos por lección: lecciones pequeñas. */
const EXCERPT_LINES = 80;
const EXCERPT_CHARS = 4000;
const MAX_BLOCKS = 2;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|rb|go|rs|java|kt|cs|c|h|cpp|vue|svelte|html|css|scss|sass|sql|sh)$/i;

// ---- Utilidades --------------------------------------------------------------------

/** Ruta relativa segura (sin salir de la carpeta del alumno). */
export function safeRel(p: string): string | undefined {
  if (!p || isAbsolute(p) || p.includes("\0")) return undefined;
  const n = normalize(p).split("\\").join("/");
  return n.startsWith("..") || n.includes("/../") ? undefined : n;
}

export function slug(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "leccion";
}

export const lessonFileName = (n: number, title: string) => `${String(n + 1).padStart(2, "0")}-${slug(title)}.md`;

/** Sintaxis de comentario del archivo; undefined si el formato no admite comentarios (JSON). */
export function commentPrefix(file: string): { open: string; close: string } | undefined {
  const e = extname(file).toLowerCase();
  if (e === ".json") return undefined;
  if (/^\.env/.test(basename(file))) return { open: "# ", close: "" };
  if ([".py", ".rb", ".sh"].includes(e)) return { open: "# ", close: "" };
  if (e === ".css") return { open: "/* ", close: " */" };
  if ([".html", ".vue", ".svelte"].includes(e)) return { open: "<!-- ", close: " -->" };
  if (e === ".sql") return { open: "-- ", close: "" };
  return { open: "// ", close: "" };
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return undefined; }
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown, max = 8) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : []);

/** Primeras líneas del archivo, cortando en límite de línea. */
export function excerpt(text: string): string {
  const out: string[] = [];
  let chars = 0;
  for (const line of text.split("\n").slice(0, EXCERPT_LINES)) {
    if (chars + line.length > EXCERPT_CHARS) break;
    out.push(line);
    chars += line.length + 1;
  }
  return out.join("\n").replace(/\s+$/, "");
}

/**
 * Para cada línea: ¿empieza dentro de una cadena de varias líneas o de un comentario de bloque?
 * Un comentario puesto ahí cambiaría el texto de la cadena (p. ej. el SQL de una plantilla con comillas invertidas).
 */
export function insideString(code: string, file: string, startsInPhp = false): boolean[] {
  const ext = extname(file).toLowerCase().slice(1);
  const js = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "go", "java", "kt", "cs", "rs", "c", "h", "cpp", "css", "scss", "vue", "svelte"].includes(ext);
  const php = ext === "php";
  const py = ext === "py";
  const lines = code.split("\n");
  const out: boolean[] = [];
  // Estado que cruza líneas: cadena (el cierre), comentario de bloque o heredoc.
  let multi: { close: string; heredoc?: boolean } | undefined;
  let inPhp = startsInPhp || !php;
  for (const line of lines) {
    out.push(!!multi);
    let i = 0;
    while (i < line.length) {
      if (multi) {
        if (multi.heredoc) {
          if (line.trim().replace(/;$/, "") === multi.close) multi = undefined;
          i = line.length;
          continue;
        }
        const at = line.indexOf(multi.close, i);
        // En cadenas con comillas de PHP/JS, la barra invertida escapa el cierre.
        if (at < 0) { i = line.length; continue; }
        if (multi.close.length === 1 && line[at - 1] === "\\" && line[at - 2] !== "\\") { i = at + 1; continue; }
        i = at + multi.close.length;
        multi = undefined;
        continue;
      }
      if (php && !inPhp) {
        const at = line.indexOf("<?", i);
        if (at < 0) { i = line.length; continue; }
        inPhp = true;
        i = at + 2;
        continue;
      }
      const c = line[i];
      const two = line.slice(i, i + 2);
      if (php && two === "?>") { inPhp = false; i += 2; continue; }
      if ((js || php) && two === "//") break;
      if (c === "#" && (php || py)) break;
      if ((js || php) && two === "/*") { multi = { close: "*/" }; i += 2; continue; }
      const heredoc = php ? line.slice(i).match(/^<<<\s*['"]?(\w+)['"]?/) : null;
      if (heredoc) { multi = { close: heredoc[1], heredoc: true }; i = line.length; continue; }
      if (py && (line.startsWith('"""', i) || line.startsWith("'''", i))) { multi = { close: line.slice(i, i + 3) }; i += 3; continue; }
      if (c === "`" && js) { multi = { close: "`" }; i++; continue; }
      if (c === '"' || c === "'") {
        // Una cadena de comillas simples/dobles solo cruza líneas en PHP; en el resto se acaba con la línea.
        let j = i + 1;
        while (j < line.length && (line[j] !== c || line[j - 1] === "\\")) j++;
        if (j >= line.length) { if (php) multi = { close: c }; i = line.length; continue; }
        i = j + 1;
        continue;
      }
      i++;
    }
  }
  return out;
}

/** Inserta las notas del modelo como comentarios encima de cada tramo de código. */
export function annotate(code: string, notes: { from: number; text: string }[], file: string, startsInPhp = false): string {
  const prefix = commentPrefix(file);
  // JSON no admite comentarios: el código se deja intacto y las notas se muestran aparte.
  if (!prefix) return code;
  const { open, close } = prefix;
  const lines = code.split("\n");
  const byLine = new Map<number, string[]>();
  const flags = insideString(code, file, startsInPhp);
  const insideAt = (i: number) => flags[i];
  for (const n of notes) {
    let at = Math.min(Math.max(Math.round(n.from) || 1, 1), lines.length);
    // Dentro de una cadena o comentario de bloque no se puede comentar: la nota sube a donde empieza.
    while (at > 1 && insideAt(at - 1)) at--;
    byLine.set(at, [...(byLine.get(at) ?? []), n.text.replace(/\s+/g, " ").slice(0, 160)]);
  }
  const out: string[] = [];
  // En un .php que mezcla HTML, un «//» suelto se vería en la página: dentro del HTML el comentario va entre <?php … ?>.
  const mixed = extname(file).toLowerCase() === ".php";
  let inPhp = startsInPhp || !mixed;
  lines.forEach((l, i) => {
    const indent = l.match(/^\s*/)?.[0] ?? "";
    for (const t of byLine.get(i + 1) ?? []) out.push(inPhp ? `${indent}${open}${t}${close}` : `${indent}<?php // ${t.replace(/\?>/g, "")} ?>`);
    out.push(l);
    if (mixed) for (const m of l.matchAll(/<\?(?:php|=)|\?>/g)) inPhp = m[0] !== "?>";
  });
  return out.join("\n");
}

// ---- Comandos de terminal de cada lección ---------------------------------------------

/** Comillas simples seguras para el shell. */
const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

const SCRIPT_NAME = /^[\w:.-]{1,30}$/;

/**
 * Comandos que el alumno ejecuta al terminar los archivos de esta lección. Salen de los archivos reales del proyecto
 * (package.json, composer.json, gulpfile…), no de la IA: así no se inventan scripts que no existen.
 */
export function lessonCommands(blocks: CodeBlock[], spec: { module: string }, isLastOfModule: boolean, entries: Map<string, string>, a: Analysis): LessonCommand[] {
  const out: LessonCommand[] = [];
  const add = (cmd: string, why: string) => { if (!out.some((c) => c.cmd === cmd)) out.push({ cmd, why }); };
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(entries.get("package.json") ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {}; } catch { /* sin scripts */ }
  const scriptFor = (re: RegExp) => Object.entries(scripts).find(([n, v]) => SCRIPT_NAME.test(n) && re.test(v))?.[0];
  const build = () => {
    const name = scriptFor(/gulp|sass|vite|webpack/);
    if (name) add(`npm run ${name}`, "Compila los estilos y el JavaScript del proyecto (y se queda vigilando los cambios).");
    else if ([...entries.keys()].some((f) => /(^|\/)gulpfile\./.test(f))) add("npx gulp", "Compila los estilos y el JavaScript con Gulp.");
  };
  for (const b of blocks.filter((x) => x.to >= x.total)) {
    const f = basename(b.file);
    if (f === "composer.json") {
      add("composer validate", "Comprueba que composer.json está bien escrito (sin errores de sintaxis).");
      add("composer install", "Descarga las dependencias de PHP, crea la carpeta vendor/ y el autoload.");
      add("composer update", "(Opcional) Actualiza las dependencias a las últimas versiones que permite composer.json.");
      if (b.ref.includes('"autoload"')) add("composer dump-autoload", "Vuelve a generar el autoload cada vez que agregues una clase nueva.");
    } else if (f === "package.json") {
      add("npm install", "Descarga las dependencias de Node (Gulp, Sass…) en la carpeta node_modules/.");
    } else if (/^gulpfile\./.test(f)) {
      build();
    } else if (/\.sql$/i.test(f)) {
      add(`mysql -u root -p < ${b.file}`, "Crea la base de datos y las tablas ejecutando este archivo en MySQL (te pedirá la contraseña).");
      const db = b.ref.match(/(?:CREATE DATABASE(?: IF NOT EXISTS)?|USE)\s+`?(\w+)`?/i)?.[1];
      if (db) add(`mysql -u root -p -e "SHOW TABLES" ${db}`, "Comprueba que las tablas se crearon.");
    } else if (/(^|\/)public\/index\.php$/.test(b.file)) {
      add("php -S localhost:8000 -t public", "Arranca el servidor de PHP; abre http://localhost:8000 en el navegador.");
    }
  }
  if (isLastOfModule && /estilos|javascript/i.test(spec.module)) build();
  return out;
}

// ---- Generar la lección ------------------------------------------------------------

const numbered = (code: string) => code.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n");

/** Las últimas líneas del archivo del alumno: donde está escribiendo la lección actual. */
export function tail(text: string, lines: number): string {
  return text.split("\n").slice(-Math.max(lines, 20)).join("\n").slice(-5000);
}

export async function generateLesson(o: { analysis: Analysis; index: number; prevTitles: string[]; ask: Ask; signal?: AbortSignal }): Promise<LessonContent> {
  const { analysis: a, index } = o;
  const spec = a.curriculum?.[index];
  if (!spec) throw new Error("esta lección no existe en el temario");
  const entries = new Map((await walk(a.root)).map((e) => [e.path, e.text ?? ""]));
  const blocks: CodeBlock[] = spec.parts.map((p) => {
    if (p.dir) {
      const note = `/* Carpeta de recursos (${p.total} archivos): imágenes o fuentes, no se escriben. Cópiala con el comando de «Terminal». */`;
      return { file: p.file, from: 1, to: p.total, total: p.total, shown: note, ref: note, display: note, copy: true, dir: true };
    }
    const lines = (a.virtual?.[p.file] ?? entries.get(p.file) ?? "").replace(/\s+$/, "").split("\n");
    if (lines.length < p.to) throw new Error(`${p.file} cambió desde el análisis; vuelve a analizar el proyecto`);
    const shown = lines.slice(p.from - 1, p.to).join("\n");
    const note = `/* Librería de terceros de ${p.total} líneas: no se escribe a mano. Cópiala con el comando de la sección «Terminal». */`;
    // ¿El tramo arranca dentro de <?php? Se mira el último «<?php» o «?>» anterior.
    const before = [...lines.slice(0, p.from - 1).join("\n").matchAll(/<\?(?:php|=)|\?>/g)].pop()?.[0];
    return { file: p.file, from: p.from, to: p.to, total: p.total, phpStart: !!before && before !== "?>", shown, ref: lines.slice(0, p.to).join("\n"), display: p.copy ? `${note}\n${lines.slice(0, 3).join("\n")}\n/* … */` : shown, copy: p.copy };
  });
  // Lección solo de copiar: no hace falta modelo.
  if (blocks.every((b) => b.copy)) {
    const b = blocks[0];
    return {
      title: spec.title,
      objective: b.dir ? `Añadir las imágenes y recursos de ${b.file}/ al proyecto. Son archivos que se copian, no se escriben.` : `Añadir ${basename(b.file)} al proyecto. Es una librería externa que el proyecto usa tal cual, así que se copia en vez de escribirla.`,
      topics: [b.dir ? "Recursos del proyecto" : "Librerías de terceros"],
      scope: "Solo copiar el archivo; no hay que entender su contenido línea por línea.",
      blocks,
      checks: [b.dir ? `Comprueba que ${b.file}/ tiene ${b.total} archivos (\`find ${b.file} -type f | wc -l\`).` : `Comprueba que existe ${b.file} y que tiene ${b.total} líneas (\`wc -l ${b.file}\`).`],
      commands: [b.dir
        ? { cmd: `mkdir -p ${q(dirname(b.file))} && cp -r ${q(join(a.root, b.file))} ${q(dirname(b.file) === "." ? "." : dirname(b.file) + "/")}`, why: "Copia las imágenes o fuentes desde el proyecto original a tu proyecto." }
        : { cmd: `mkdir -p ${q(dirname(b.file))} && cp ${q(join(a.root, b.file))} ${q(b.file)}`, why: "Copia la librería desde el proyecto original a tu proyecto." }],
    };
  }

  const system = `Eres un profesor de programación. Preparas UNA lección para un alumno de nivel ${LEVEL_NAMES[a.level] ?? a.level} que reconstruye un proyecto real escribiendo el código él mismo.
Escribe en ${LANG_NAMES[a.language] ?? a.language}. Responde SOLO con JSON válido:
{"title":"título corto","objective":"qué logrará el alumno","topics":["tema 1","tema 2"],"scope":"hasta dónde llega esta lección y qué queda fuera","notes":[{"file":"ruta","from":1,"text":"qué hace el código desde esa línea"}],"checks":["paso para comprobar a mano que funciona"]}
Reglas: "notes" explica cada sección del código recibido (3-8 notas, "from" es el número de línea (de la lista numerada) donde empieza la sección, "file" una de las rutas dadas); "checks" son 2-4 pasos concretos y ejecutables (comandos o qué ver en pantalla). No inventes archivos ni código.`;
  const prompt = `Proyecto: ${a.name} — ${a.type}\nDe qué trata: ${a.summary}\nLección ${index + 1} de ${a.curriculum!.length} · módulo «${spec.module}»: ${spec.title}\nLecciones anteriores: ${o.prevTitles.slice(-6).join("; ") || "ninguna"}\n\n${blocks
    .map((b) => `## ${b.file}${b.total > b.to - b.from + 1 ? ` (líneas ${b.from}-${b.to} de ${b.total})` : ""}\n${numbered(b.shown)}`)
    .join("\n\n")}`;

  let parsed: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 2 && !parsed?.title; attempt++) parsed = parseJson(await o.ask(system, prompt, o.signal).catch(() => ""));

  const notes = (Array.isArray(parsed?.notes) ? (parsed!.notes as Record<string, unknown>[]) : [])
    .map((n) => ({ file: str(n.file), from: Number(n.from), text: str(n.text) }))
    .filter((n) => n.text && Number.isFinite(n.from));
  for (const b of blocks) {
    const mine = notes.filter((n) => !n.file || basename(n.file) === basename(b.file));
    b.display = annotate(b.shown, mine, b.file, b.phpStart);
    if (!commentPrefix(b.file) && !b.copy) b.notes = mine.map((n) => ({ line: Math.round(n.from), text: n.text })).slice(0, 8);
  }
  const checks = strs(parsed?.checks, 5);
  const lastOfModule = a.curriculum![index + 1]?.module !== spec.module;
  return {
    commands: lessonCommands(blocks, spec, lastOfModule, entries, a),
    title: str(parsed?.title) || spec.title,
    objective: str(parsed?.objective) || `Escribir ${spec.title} (${spec.module}).`,
    topics: strs(parsed?.topics, 6),
    scope: str(parsed?.scope),
    blocks,
    checks: checks.length ? checks : defaultChecks(blocks),
  };
}

/** Pasos de comprobación manual por tipo de archivo, para cuando el modelo no los da. */
function defaultChecks(blocks: CodeBlock[]): string[] {
  const out: string[] = [];
  // Solo un archivo completo se puede comprobar con el lenguaje; en tramos intermedios se sigue escribiendo.
  for (const f of blocks.filter((b) => b.to >= b.total).map((b) => b.file)) {
    const e = extname(f).toLowerCase();
    if (e === ".php") out.push(`Ejecuta \`php -l ${f}\`: debe decir «No syntax errors detected».`);
    else if ([".js", ".mjs", ".cjs"].includes(e)) out.push(`Ejecuta \`node --check ${f}\`: no debe mostrar errores.`);
    else if (basename(f) === "composer.json") out.push("Ejecuta `composer validate`: debe decir que composer.json es válido.");
    else if (e === ".json") out.push(`Revisa que ${f} sea JSON válido: sin comas de más y con todas las llaves cerradas.`);
    else if (e === ".py") out.push(`Ejecuta \`python3 -m py_compile ${f}\`: no debe mostrar errores.`);
    else if ([".scss", ".sass", ".css"].includes(e)) out.push(`Compila o abre ${f} en el navegador: los estilos deben aplicarse sin errores.`);
  }
  if (blocks.some((b) => b.to < b.total)) out.push("Este archivo sigue en la próxima lección: escribe este tramo a continuación de lo que ya tienes, sin dejar líneas en blanco de más.");
  out.push("Pulsa «Comprobar» para que se revise tu código.");
  return out;
}

// ---- Comprobación, capa 1: determinista -------------------------------------------

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 1 << 20 }, (err, so, se) =>
      resolve({ ok: !err, out: `${so}${se}`.trim(), missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
    ),
  );
}

/** Revisión de sintaxis con las herramientas del propio lenguaje. undefined = correcto o no comprobable. */
export async function syntaxError(abs: string, text: string): Promise<string | undefined> {
  const e = extname(abs).toLowerCase();
  const tidy = (s: string) => s.replace(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), basename(abs)).split("\n").slice(0, 6).join("\n").slice(0, 500);
  if (e === ".php") { const r = await run("php", ["-l", abs]); return r.ok || r.missing ? undefined : tidy(r.out); }
  if ([".js", ".mjs", ".cjs"].includes(e)) { const r = await run("node", ["--check", abs]); return r.ok || r.missing ? undefined : tidy(r.out); }
  if (e === ".py") { const r = await run("python3", ["-m", "py_compile", abs]); return r.ok || r.missing ? undefined : tidy(r.out); }
  if (e === ".json") { try { JSON.parse(text); } catch (err) { return (err as Error).message; } return undefined; }
  if ([".css", ".scss", ".sass"].includes(e) && e !== ".sass") {
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    return open === close ? undefined : `Llaves sin cerrar: hay ${open} «{» y ${close} «}».`;
  }
  return undefined;
}

const codeLines = (t: string) => t.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|#|\/\*|\*|<!--|--)/.test(l)).length;

export interface Layer1 { file: string; problem?: Issue }

async function countAssets(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) n += e.isDirectory() ? await countAssets(join(dir, e.name)) : 1;
  return n;
}

export async function layer1(base: string, block: CodeBlock): Promise<Layer1> {
  const abs = join(base, block.file);
  if (block.dir) {
    const have = await countAssets(abs);
    return have >= block.total * 0.9
      ? { file: block.file }
      : { file: block.file, problem: { where: block.file, why: `La carpeta tiene ${have} archivos y el original ${block.total}.`, fix: "Copia la carpeta con el comando de la sección «Terminal»." } };
  }
  const text = await readFile(abs, "utf8").catch(() => undefined);
  if (text === undefined) return { file: block.file, problem: { where: block.file, why: "El archivo no existe todavía.", fix: "Usa «Abrir archivo» para crearlo y escribe el código de la lección." } };
  if (!text.trim()) return { file: block.file, problem: { where: block.file, why: "El archivo está vacío.", fix: "Escribe el código de la lección en él." } };
  // Archivo .env: los valores son del alumno; solo importa que estén todas las claves.
  if (/^\.env/.test(basename(block.file))) {
    const keys = (t: string) => new Set([...t.matchAll(/^\s*([A-Za-z_][\w.]*)\s*=/gm)].map((m) => m[1]));
    const have = keys(text);
    const missing = [...keys(block.ref)].filter((k) => !have.has(k));
    return missing.length
      ? { file: block.file, problem: { where: block.file, why: `Faltan estas variables: ${missing.join(", ")}.`, fix: "Agrégalas con la forma CLAVE = valor, una por línea (los valores son tuyos)." } }
      : { file: block.file };
  }
  // Un tramo intermedio deja el archivo a medias (clase sin cerrar): la sintaxis se revisa al terminar el archivo.
  const syn = block.to >= block.total && !block.copy ? await syntaxError(abs, text) : undefined;
  if (syn) return { file: block.file, problem: { where: block.file, why: `Error de sintaxis: ${syn}`, fix: "Corrige la línea indicada por el error (revisa llaves, paréntesis, comillas y punto y coma)." } };
  // Una librería copiada: basta con que esté completa.
  if (block.copy) {
    return text.split("\n").length >= block.total * 0.9
      ? { file: block.file }
      : { file: block.file, problem: { where: block.file, why: `El archivo está incompleto: tiene ${text.split("\n").length} líneas y el original ${block.total}.`, fix: "Vuelve a copiarlo con el comando de la sección «Terminal»." } };
  }
  const have = codeLines(text);
  const need = codeLines(block.ref);
  if (need >= 6 && have < need * 0.35) {
    return { file: block.file, problem: { where: block.file, why: `Parece incompleto: tiene ${have} líneas de código y la lección tiene unas ${need}.`, fix: "Sigue escribiendo el código que muestra la lección." } };
  }
  return { file: block.file };
}

// ---- Comprobación, capa 1b: comparación estructural (ignora nombres) -------------------

const KEYWORDS = new Set(("if else elseif elif for foreach while do switch case break continue return function fn class interface extends implements new public private protected static const let var use namespace import from export default async await try catch finally throw this self parent null true false array int string bool void echo print require require_once include include_once and or not def lambda pass in is None True False isset empty unset list match enum abstract final yield with as of typeof instanceof delete").split(" "));

interface Tok { t: string; at: number }

/** Quita comentarios y reduce el código a símbolos: las palabras reservadas se conservan, los nombres propios pasan a «ID». */
function tokenize(code: string, file: string, alpha = false): Tok[] {
  const e = extname(file).toLowerCase();
  const kind = [".py", ".rb", ".sh"].includes(e) || /^\.env/.test(basename(file)) ? "hash" : e === ".sql" ? "dash" : "slash";
  const src = code
    .replace(/<\?php[ \t]*\/\/[^\n]*?\?>/g, (m) => " ".repeat(m.length)) // anotaciones «<?php // … ?>» dentro del HTML
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(kind === "hash" ? /#.*$/gm : kind === "dash" ? /--.*$/gm : /(^|[^:'"])\/\/.*$/gm, (m, g) => (kind === "slash" ? (g ?? "") : "") + " ".repeat(m.length - (kind === "slash" ? (g ?? "").length : 0)));
  const out: Tok[] = [];
  // Modo alfa: cada nombre propio se numera por orden de aparición (ID1, ID2…), así que renombrar de forma coherente no cambia nada.
  const names = new Map<string, number>();
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\$?[A-Za-z_]\w*|\d+(?:\.\d+)?|=>|->|::|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\S/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const w = m[0];
    const bare = w.replace(/^\$/, "");
    // Variables dentro de cadenas con interpolación ("Hola $nombre", `${x}`): también se numeran.
    const text = alpha && /^["`]/.test(w) ? w.replace(/\$\{?(\w+)/g, (_m, n: string) => { if (n === "this") return _m; if (!names.has(n)) names.set(n, names.size + 1); return `$ID${names.get(n)}`; }) : w;
    // En PHP toda `$variable` es un nombre propio (salvo $this), aunque se llame como una palabra reservada (`$fn`, `$list`).
    const isName = /^\$?[A-Za-z_]/.test(w) && (w.startsWith("$") ? bare !== "this" : !KEYWORDS.has(bare));
    if (isName && alpha && !names.has(bare)) names.set(bare, names.size + 1);
    out.push({ at: m.index, t: /^['"`]/.test(w) ? "STR" + text : isName ? (alpha ? "ID" + names.get(bare) : "ID") : /^\$?[A-Za-z_]/.test(w) ? bare : /^\d/.test(w) ? (alpha ? "NUM" + w : "NUM") : w });
  }
  return out;
}

/**
 * ¿Es el código del alumno el de referencia con otros nombres? Compara los símbolos con los nombres numerados por
 * aparición: cambiar `$cita` por `$mi_cita` en todas partes da lo mismo; usar otra variable en un sitio, no.
 * El alumno puede haber escrito más (la siguiente lección): basta con que el principio coincida.
 */
export function sameUpToRenaming(ref: string, student: string, file: string): boolean {
  const a = tokenize(ref, file, true);
  const b = tokenize(student, file, true);
  if (!a.length || b.length < a.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].t !== b[i].t) return false;
  return true;
}

export interface Diff { similarity: number; missingFrac: number; missing: { text: string; line: number; tokens: number }[]; /** Código del alumno que no está en la referencia, dentro del archivo (no al final). */ extra: { text: string; line: number; tokens: number }[]; literalsMissing: string[]; literalsTotal: number }

/** Qué partes del código de referencia no aparecen en el del alumno (LCS sobre los símbolos). */
export function structuralDiff(ref: string, student: string, file: string): Diff {
  const a = tokenize(ref, file);
  const b = tokenize(student, file);
  const n = a.length;
  const m = b.length;
  // LCS con tabla completa de Uint16 (n*m es pequeño: las lecciones tienen ~80 líneas).
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i].t === b[j].t ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const matched = new Array<boolean>(n).fill(false);
  const matchedB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i].t === b[j].t) { matched[i] = true; matchedB[j] = true; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  const common = matched.filter(Boolean).length;
  const missing: Diff["missing"] = [];
  for (let i = 0; i < n; ) {
    if (matched[i]) { i++; continue; }
    let j = i;
    while (j < n && !matched[j]) j++;
    if (j - i >= 6) {
      const end = j < n ? a[j].at : ref.length;
      missing.push({ text: ref.slice(a[i].at, end).trim().slice(0, 140), line: ref.slice(0, a[i].at).split("\n").length, tokens: j - i });
    }
    i = j;
  }
  // Lo que sobra: símbolos del alumno sin pareja que quedan ANTES de lo último que sí coincide (lo del final puede ser la lección siguiente).
  const extra: Diff["extra"] = [];
  const lastMatch = matchedB.lastIndexOf(true);
  for (let j = 0; j < lastMatch; ) {
    if (matchedB[j]) { j++; continue; }
    let k = j;
    while (k < lastMatch && !matchedB[k]) k++;
    if (k - j >= 8) extra.push({ text: student.slice(b[j].at, k < m ? b[k].at : student.length).trim().slice(0, 140), line: student.slice(0, b[j].at).split("\n").length, tokens: k - j });
    j = k;
  }
  const lits = new Set(a.filter((t) => t.t.startsWith("STR") && t.t.length > 5).map((t) => t.t.slice(3, -1).trim()));
  const have = new Set(b.filter((t) => t.t.startsWith("STR")).map((t) => t.t.slice(3, -1).trim()));
  const literalsMissing = [...lits].filter((l) => l && !have.has(l));
  return { similarity: n + m ? (2 * common) / (n + m) : 1, missingFrac: n ? 1 - common / n : 0, missing, extra, literalsMissing, literalsTotal: lits.size };
}

// ---- Comprobación, capa 2: la IA compara con el proyecto analizado ---------------

export async function layer2(base: string, block: CodeBlock, a: Analysis, ask: Ask, signal?: AbortSignal): Promise<{ state: CheckResult["state"]; summary: string; issues: Issue[] }> {
  const student = await readFile(join(base, block.file), "utf8");
  // Idéntico salvo nombres: no hace falta preguntar a la IA (y así un modelo pequeño no puede suspender código correcto).
  if (sameUpToRenaming(block.ref, student, block.file)) return { state: "ok", summary: "Tu código hace lo mismo que el original.", issues: [] };
  const diff = structuralDiff(block.ref, student.slice(0, 40_000), block.file);
  const missingIssues: Issue[] = [
    ...diff.missing.slice(0, 4).map((x) => ({ where: `${block.file}, referencia línea ${x.line}`, why: `Parece que falta algo equivalente a: ${x.text}`, fix: "Revisa el bloque de la lección que hace eso y escríbelo (puedes usar otros nombres)." })),
    ...diff.literalsMissing.slice(0, 3).map((l) => ({ where: block.file, why: `No aparece el valor «${l}», que sí está en el proyecto original.`, fix: "Los textos, rutas y valores concretos deben ser los mismos aunque cambies los nombres." })),
  ];

  // Código repetido o de más en medio del archivo: se ve sin IA.
  if (diff.extra.length) {
    return {
      state: "fail",
      summary: "Tu archivo tiene código que no está en esta lección.",
      issues: diff.extra.slice(0, 3).map((x) => ({ where: `${block.file}, tu línea ${x.line}`, why: `Hay código de más (¿lo pegaste dos veces?): ${x.text}`, fix: "Borra lo que sobra y deja solo el código de la lección." })),
    };
  }
  // Veredicto sin IA: si falta una parte grande, ya está mal.
  const manyLiterals = diff.literalsTotal >= 3 && diff.literalsMissing.length / diff.literalsTotal > 0.5;
  if (diff.missingFrac > 0.3 || manyLiterals) {
    return { state: "fail", summary: `Tu código se parece solo en un ${Math.round((1 - diff.missingFrac) * 100)}% al esperado.`, issues: missingIssues };
  }

  const system = `Eres un revisor de código para alumnos de nivel ${LEVEL_NAMES[a.level] ?? a.level}. Comparas el código del alumno con el CÓDIGO DE REFERENCIA del proyecto real.
El alumno puede cambiar nombres de variables, funciones, clases y el orden de cosas sin importancia: eso NO es un error. Es un error si falta funcionalidad, si hace algo distinto o si tiene un fallo lógico.
Escribe en ${LANG_NAMES[a.language] ?? a.language}. Responde SOLO con JSON:
{"verdict":"ok"|"fail"|"unsure","summary":"una frase","issues":[{"where":"función o línea","why":"qué está mal y por qué","fix":"cómo corregirlo sin dar todo el código"}]}
Usa "ok" si hace lo mismo que la referencia, "fail" solo si puedes señalar al menos un problema concreto, y "unsure" si no puedes decidirlo.`;
  const hints = missingIssues.length ? `\n\n## POSIBLES FALTANTES (detectados automáticamente)\n${missingIssues.map((i) => `- ${i.why}`).join("\n")}` : "";
  const prompt = `Archivo: ${block.file}${block.total > block.to - block.from + 1 ? ` (esta lección: líneas ${block.from}-${block.to} de ${block.total}; el alumno va escribiendo el archivo por tramos)` : ""}\n\n## CÓDIGO DE REFERENCIA (esta lección)\n${block.shown}\n\n## CÓDIGO DEL ALUMNO (final del archivo)\n${tail(student, (block.to - block.from + 1) * 2)}${hints}`;

  let verdict = "";
  let summary = "";
  let issues: Issue[] = [];
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    const j = parseJson(await ask(system, prompt, signal).catch(() => ""));
    const v = str(j?.verdict);
    if (!["ok", "fail", "unsure"].includes(v)) continue;
    verdict = v;
    summary = str(j?.summary);
    issues = (Array.isArray(j?.issues) ? (j!.issues as Record<string, unknown>[]) : [])
      .map((i) => ({ where: str(i.where) || block.file, why: str(i.why), fix: str(i.fix) }))
      .filter((i) => i.why);
  }
  const differs = diff.missing.length > 0 || diff.literalsMissing.length > 0 || diff.missingFrac > 0.08;
  if (verdict === "fail" && issues.length && differs) return { state: "fail", summary: "Encontré problemas en tu código.", issues };
  // La IA dice que falla pero la comparación no ve diferencias claras: se trata como duda, no como error.
  if (verdict === "fail") return { state: "unsure", summary: "El revisor ve posibles diferencias, pero no pude confirmarlas.", issues };
  // La IA pequeña aprueba de más: si la comparación automática vio un fragmento largo ausente, no se da por buena.
  const big = diff.missing.some((x) => x.tokens >= 8);
  if (verdict === "ok" && !big && !diff.literalsMissing.length) return { state: "ok", summary: summary || "¡Bien hecho!", issues: [] };
  if (big || diff.literalsMissing.length) return { state: "unsure", summary: "Tu código se parece al esperado, pero podría faltar algo. Revisa estos puntos.", issues: missingIssues };
  return { state: "unsure", summary: summary || "No pude confirmar si está bien; revisa la comprobación manual.", issues };
}

export async function checkLesson(base: string, content: LessonContent, a: Analysis, ask: Ask, signal?: AbortSignal): Promise<CheckResult> {
  const l1 = await Promise.all(content.blocks.map((b) => layer1(base, b)));
  const problems = l1.map((r) => r.problem).filter((p): p is Issue => !!p);
  if (problems.length) return { state: "fail", summary: "Hay problemas que se detectan sin IA.", issues: problems, at: Date.now() };

  const results = [];
  for (const b of content.blocks) {
    if (b.copy || /^\.env/.test(basename(b.file))) results.push({ state: "ok" as const, summary: "", issues: [] as Issue[] });
    else results.push(await layer2(base, b, a, ask, signal));
  }
  const issues = results.flatMap((r) => r.issues);
  const state = results.some((r) => r.state === "fail") ? "fail" : results.some((r) => r.state === "unsure") ? "unsure" : "ok";
  const summary = [...new Set(results.map((r) => r.summary).filter(Boolean))].join(" ") || (state === "ok" ? "¡Bien hecho!" : "");
  return { state, summary, issues, at: Date.now() };
}

// ---- Repaso: ¿sigue en pie lo que se hizo en lecciones anteriores? ------------------------

/** Lección ya hecha que dejó de cumplirse: qué falla, sin IA. */
export interface RegressItem { n: number; title: string; issues: Issue[] }
export interface RegressResult { at: number; checked: number; broken: RegressItem[] }

/**
 * Vuelve a comprobar una lección terminada contra los archivos de ahora. El archivo pudo crecer con lecciones posteriores,
 * así que solo se mira que el tramo de ESTA lección siga dentro (lo de más no cuenta). Es determinista: no usa IA.
 */
export async function recheckLesson(base: string, content: LessonContent): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const b of content.blocks) {
    const l1 = await layer1(base, b);
    if (l1.problem) { issues.push(l1.problem); continue; }
    if (b.copy || b.dir || /^\.env/.test(basename(b.file))) continue;
    const student = (await readFile(join(base, b.file), "utf8")).slice(0, 60_000);
    const d = structuralDiff(b.shown, student, b.file);
    const gone = d.missing[0];
    if (gone) {
      issues.push({ where: `${b.file}, desde la línea ${gone.line} del tramo`, why: `Ya no está este código de la lección: «${gone.text.replace(/\s+/g, " ").slice(0, 90)}».`, fix: "Vuelve a escribirlo o recupéralo con deshacer (Ctrl+Z) si lo borraste sin querer." });
    } else if (d.missingFrac > 0.3) {
      issues.push({ where: b.file, why: `Falta una parte importante del código de la lección (${Math.round(d.missingFrac * 100)} %).`, fix: "Compara el archivo con el código de la lección y recupera lo que falta." });
    }
  }
  return issues;
}

// ---- Pistas y ayuda -----------------------------------------------------------------

const HINT_RULES = [
  "Nivel 1: una pista MUY leve, solo orienta hacia dónde mirar. No muestres código.",
  "Nivel 2: una pista media, nombra el concepto o la función que falta, sin escribir la solución.",
  "Nivel 3: una pista fuerte, explica casi todo el paso en palabras; como mucho una línea de ejemplo.",
];

export async function lessonHint(base: string, content: LessonContent, level: number, a: Analysis, ask: Ask, signal?: AbortSignal): Promise<string> {
  const mine = await Promise.all(content.blocks.map(async (b) => `## ${b.file}\n${tail(await readFile(join(base, b.file), "utf8").catch(() => "(aún no existe)"), (b.to - b.from + 1) * 2)}`));
  const system = `Eres un profesor paciente. Escribe en ${LANG_NAMES[a.language] ?? a.language}. ${HINT_RULES[Math.min(level, 3) - 1]} Máximo 3 frases.`;
  const prompt = `Lección: ${content.title}\nObjetivo: ${content.objective}\n\n## REFERENCIA\n${content.blocks.map((b) => `# ${b.file}\n${b.shown}`).join("\n\n")}\n\n## CÓDIGO DEL ALUMNO\n${mine.join("\n\n")}`;
  return (await ask(system, prompt, signal)).trim() || "Relee el objetivo de la lección y compara tu código con el ejemplo, bloque por bloque.";
}

export async function lessonHelp(base: string, content: LessonContent, chat: LessonState["chat"], question: string, a: Analysis, ask: Ask, signal?: AbortSignal): Promise<string> {
  const mine = await Promise.all(content.blocks.map(async (b) => `## ${b.file}\n${tail(await readFile(join(base, b.file), "utf8").catch(() => "(aún no existe)"), (b.to - b.from + 1) * 2)}`));
  const system = `Eres un profesor de programación paciente para un alumno de nivel ${LEVEL_NAMES[a.level] ?? a.level}. Escribe en ${LANG_NAMES[a.language] ?? a.language}. Responde a su duda de forma clara y breve, con ejemplos cortos. Guíalo: no le des la solución completa de la lección salvo que la pida expresamente.`;
  const history = chat.slice(-6).map((m) => `${m.role === "user" ? "Alumno" : "Profesor"}: ${m.text}`).join("\n");
  const prompt = `Lección: ${content.title}\nObjetivo: ${content.objective}\n\n## REFERENCIA\n${content.blocks.map((b) => `# ${b.file}\n${b.shown}`).join("\n\n")}\n\n## CÓDIGO ACTUAL DEL ALUMNO\n${mine.join("\n\n")}\n\n## CONVERSACIÓN\n${history || "(nueva)"}\n\nAlumno: ${question}`;
  return (await ask(system, prompt, signal)).trim() || "No pude contestar; reformula la pregunta.";
}

// ---- Archivo Markdown de la lección ----------------------------------------------------

export function lessonMarkdown(n: number, c: LessonContent, status: LessonState["status"]): string {
  const fence = (f: string, code: string) => "```" + extname(f).slice(1) + "\n" + code + "\n```";
  return [
    "<!-- code-learning:generated -->",
    `# Lección ${n + 1}: ${c.title}${status === "done" ? " ✅" : ""}`,
    "",
    "## Objetivo",
    "",
    c.objective,
    "",
    ...(c.topics.length ? ["**Temas:**", ...c.topics.map((t) => `- ${t}`), ""] : []),
    ...(c.scope ? [`**Alcance:** ${c.scope}`, ""] : []),
    "## Código",
    "",
    ...c.blocks.flatMap((b) => [
      `### \`${b.file}\`${b.total > b.to - b.from + 1 ? ` (líneas ${b.from}-${b.to} de ${b.total})` : ""}`,
      "",
      fence(b.file, b.display),
      "",
      ...(b.notes?.length ? ["**Qué hace cada parte:**", ...b.notes.map((n) => `- Línea ${n.line}: ${n.text}`), ""] : []),
    ]),
    ...(c.commands?.length ? ["## Terminal", "", "```bash", ...c.commands.map((x) => `${x.cmd}   # ${x.why}`), "```", ""] : []),
    "## Comprobación",
    "",
    ...(c.checks.length ? c.checks.map((x, i) => `${i + 1}. ${x}`) : ["Ejecuta el proyecto y comprueba que se comporta como el original."]),
    "",
  ].join("\n");
}
