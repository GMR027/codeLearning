import { basename, dirname, extname } from "path";
import type { Entry, Topic } from "./analyzer";
import { topicOfStep } from "./analyzer";

/** Un tramo de un archivo del proyecto original que el alumno escribe en una lección. */
export interface LessonPart {
  file: string;
  /** Líneas (1 = primera) del tramo dentro del archivo. */
  from: number;
  to: number;
  total: number;
  /** Librería de terceros (normalize.css…): se copia del proyecto original en vez de escribirla a mano. */
  copy?: boolean;
  /** `file` es una carpeta de recursos (imágenes, fuentes) y `total` el número de archivos. */
  dir?: boolean;
}
export interface LessonSpec { module: string; title: string; topic?: string; parts: LessonPart[] }
/** Lo que no es código pero el proyecto necesita: archivos .env y carpetas de imágenes/fuentes. */
export interface Extras { env: { path: string; text: string }[]; assets: { dir: string; count: number }[]; /** Archivos de código vacíos (no tienen lección). */ empty?: string[] }

export interface Curriculum { lessons: LessonSpec[]; modules: { title: string; files: string[]; count: number }[]; virtual: Record<string, string> }

/** Líneas por lección: lo que un alumno puede escribir y entender de una vez. */
const CHUNK_SOFT = 35;
const CHUNK_HARD = 70;
const PACK_MAX = 70;
const SCHEMA_FILE = "database/schema.sql";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|rb|go|rs|java|kt|cs|c|h|cpp|vue|svelte|html|css|scss|sass|sql|sh|json)$/i;
/** Archivos que no se escriben a mano: dependencias, resultados de compilar y librerías copiadas. */
const SKIP = /(^|\/)(package-lock\.json|composer\.lock|yarn\.lock|pnpm-lock\.yaml|tsconfig\.tsbuildinfo)$|(^|\/)(build|dist|out|vendor|node_modules|coverage)\/|\.min\.|\.d\.ts$|\.bak$/i;
/** Librerías copiadas dentro del proyecto: el proyecto las necesita pero nadie las teclea. */
const LIBRARY = /(^|\/)_?normalize(\.min)?\.(s?css)$/i;

/** Etapas de construcción de un proyecto desde cero. El número es el orden. */
const STAGES: { re: RegExp; name: string }[] = [
  { re: /^(composer\.json|package\.json|gulpfile\.[\w]+|vite\.config\.\w+|webpack\.config\.\w+|tsconfig\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod)$/, name: "Preparar el proyecto" },
  { re: /(^|\/)(database|db|migrations?)(\/|\.)|\.sql$/i, name: "Base de datos" },
  { re: /(^|\/)(includes?|config|settings|bootstrap)\/|(^|\/)\.env/i, name: "Configuración" },
  { re: /(^|\/)(models?|entities|schemas?)\//i, name: "Modelos" },
  { re: /(^|\/)(router|routes?)(\/|\.)/i, name: "Rutas" },
  { re: /(^|\/)(controllers?|classes|services?|lib|helpers?|middleware)\//i, name: "Controladores y clases" },
  { re: /(^|\/)(views?|templates?|components?|pages?)\//i, name: "Vistas" },
  { re: /(^|\/)(public|pub|www|web)\/[^/]+\.(php|html)$/i, name: "Punto de entrada" },
  { re: /\.(scss|sass|css)$/i, name: "Estilos" },
  { re: /\.(js|mjs|ts|tsx|jsx|vue|svelte)$/i, name: "JavaScript" },
];
const stageOf = (p: string): number => {
  const i = STAGES.findIndex((s) => s.re.test(p) || s.re.test(basename(p)));
  return i < 0 ? STAGES.length : i;
};

/** Dentro de una etapa, primero lo que el resto necesita. */
const FIRST: RegExp[] = [/(^|\/)\.env/,/(^|\/)composer\.json$/, /(^|\/)package\.json$/, /ActiveRecord/i, /(^|\/)_?(variables|mixins|globales)/i, /layout/i, /templates?\//i];
const priority = (p: string) => {
  const i = FIRST.findIndex((r) => r.test(p));
  return i < 0 ? FIRST.length : i;
};

// ---- Orden por dependencias ------------------------------------------------------------

/** Nombres (sin extensión) de los archivos que este código dice usar: require/include/import y clases (`new X`, `X::`, `use A\\X`). */
function referencedNames(text: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => { if (s) out.add(basename(s).replace(/\.\w+$/, "")); };
  for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\b\s*\(?\s*[^'"\n;]*['"]([^'"\n]+)['"]/g)) add(m[1]);
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\(\s*)['"](\.[^'"\n]+)['"]/g)) add(m[1]);
  for (const m of text.matchAll(/^\s*use\s+[\w\\]*?\\(\w+)(?:\s+as\s+\w+)?\s*;/gm)) add(m[1]);
  for (const m of text.matchAll(/\bnew\s+([A-Z]\w*)|\b([A-Z]\w*)::/g)) add(m[1] ?? m[2]);
  return out;
}

/** Dentro de cada etapa, lo que otro archivo necesita va antes que ese archivo (si no hay ciclo). El resto conserva su orden. */
function orderByDependencies<T extends { path: string; lines: string[]; stage: number }>(files: T[]): T[] {
  const out: T[] = [];
  const stages = [...new Set(files.map((f) => f.stage))];
  for (const stage of stages) {
    const group = files.filter((f) => f.stage === stage);
    const byName = new Map<string, T[]>();
    for (const f of group) {
      const n = basename(f.path).replace(/\.\w+$/, "");
      byName.set(n, [...(byName.get(n) ?? []), f]);
    }
    const seen = new Set<T>();
    const visit = (f: T, stack: Set<T>) => {
      if (seen.has(f) || stack.has(f)) return;
      stack.add(f);
      // Solo se siguen referencias a un nombre que identifica un único archivo de la etapa.
      for (const n of referencedNames(f.lines.join("\n"))) {
        const hit = byName.get(n);
        if (hit?.length === 1 && hit[0] !== f) visit(hit[0], stack);
      }
      stack.delete(f);
      seen.add(f);
      out.push(f);
    };
    for (const f of group) visit(f, new Set());
  }
  return out;
}

/** Parte las líneas de un archivo en tramos de ~35-70 líneas, cortando en líneas en blanco. */
export function chunkLines(lines: string[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const size = i - start + 1;
    const lastLine = i === lines.length - 1;
    const blank = !lines[i].trim();
    // Se corta cuando ya hay bastante y la línea es un buen punto de corte, o a las CHUNK_HARD líneas.
    if (!lastLine && ((size >= CHUNK_SOFT && blank && lines[i + 1]?.trim()) || size >= CHUNK_HARD)) {
      out.push([start + 1, i + 1]);
      start = i + 1;
    }
  }
  if (start < lines.length) out.push([start + 1, lines.length]);
  // Un resto de pocas líneas no merece su propia lección: se une al tramo anterior.
  if (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] + 1 <= 8) {
    const last = out.pop()!;
    out[out.length - 1][1] = last[1];
  }
  return out;
}

// ---- Esquema de la base de datos, deducido de los modelos --------------------------

const COLUMN_TYPES: [RegExp, string][] = [
  [/^id$/i, "INT NOT NULL AUTO_INCREMENT"],
  [/^precio|^price|^total$/i, "DECIMAL(8,2) DEFAULT NULL"],
  [/^fecha|date$/i, "DATE DEFAULT NULL"],
  [/^hora|time$/i, "TIME DEFAULT NULL"],
  [/^(admin|confirmado|activo|active|estado|status)$/i, "TINYINT(1) DEFAULT 0"],
  [/^token$/i, "VARCHAR(15) DEFAULT NULL"],
  [/^password|^contrasena|^clave$/i, "VARCHAR(60) DEFAULT NULL"],
  [/^email|^correo/i, "VARCHAR(60) DEFAULT NULL"],
  [/^telefono|^phone|^celular/i, "VARCHAR(15) DEFAULT NULL"],
  [/^nombre|^apellido|^name$/i, "VARCHAR(60) DEFAULT NULL"],
];

interface ModelTable { name: string; columns: string[] }

/** Nombre de modelo y de tabla comparables: «CitaServicio» ≈ «citasServicios». */
const norm = (s: string) => s.toLowerCase().replace(/(es|s)(?=[a-z]|$)/g, "");

/** Tablas y columnas de los modelos estilo ActiveRecord (`$tabla` y `$columnasDB`). */
export function modelTables(files: Entry[]): ModelTable[] {
  const found = new Map<string, { model: string; columns: string[] }[]>();
  for (const f of files) {
    if (!/\.php$/.test(f.path)) continue;
    const t = f.text?.match(/\$tabla\s*=\s*['"](\w+)['"]/)?.[1];
    const cols = f.text?.match(/\$columnasDB\s*=\s*\[([^\]]*)\]/)?.[1];
    if (!t || !cols) continue;
    found.set(t, [...(found.get(t) ?? []), { model: basename(f.path, ".php"), columns: [...cols.matchAll(/['"](\w+)['"]/g)].map((m) => m[1]) }]);
  }
  // Si varios modelos usan la misma tabla (uno suele ser una vista de lectura, como AdminCita), manda el que se llama como ella.
  return [...found.entries()].map(([name, models]) => ({ name, columns: (models.find((m) => norm(m.model) === norm(name)) ?? models[0]).columns }));
}

export function schemaSql(tables: ModelTable[], dbName = "app_db"): string {
  const names = new Set(tables.map((t) => t.name.toLowerCase()));
  const refOf = (col: string): string | undefined => {
    const m = col.match(/^(\w+?)_?Id$/i);
    if (!m) return undefined;
    const base = m[1].toLowerCase();
    return [base + "s", base + "es", base].find((n) => names.has(n));
  };
  // Las tablas a las que otras apuntan se crean antes.
  const deps = (t: ModelTable) => t.columns.map(refOf).filter((x): x is string => !!x && x !== t.name.toLowerCase());
  const ordered: ModelTable[] = [];
  const add = (t: ModelTable, stack: string[] = []) => {
    if (ordered.includes(t) || stack.includes(t.name)) return;
    for (const d of deps(t)) {
      const dep = tables.find((x) => x.name.toLowerCase() === d);
      if (dep) add(dep, [...stack, t.name]);
    }
    ordered.push(t);
  };
  tables.forEach((t) => add(t));

  const out = ["-- Base de datos del proyecto. Cambia el nombre si quieres y ponlo también en tu archivo .env", `CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4;`, `USE ${dbName};`, ""];
  for (const t of ordered) {
    const defs = t.columns.map((c) => `  ${c} ${COLUMN_TYPES.find(([re]) => re.test(c))?.[1] ?? (refOf(c) ? "INT DEFAULT NULL" : "VARCHAR(255) DEFAULT NULL")}`);
    defs.push("  PRIMARY KEY (id)");
    for (const c of t.columns) {
      const r = refOf(c);
      if (r && r !== t.name.toLowerCase()) defs.push(`  FOREIGN KEY (${c}) REFERENCES ${tables.find((x) => x.name.toLowerCase() === r)!.name}(id) ON DELETE SET NULL`);
    }
    out.push(`CREATE TABLE IF NOT EXISTS ${t.name} (`, defs.join(",\n"), ") ENGINE=InnoDB;", "");
  }
  return out.join("\n").trimEnd() + "\n";
}

// ---- Archivos .env: se enseñan sin secretos ------------------------------------------------

/** Deja las claves y los valores que no son secretos (servidor, base de datos, URL); el resto pasa a «tu_valor_aqui». */
export function sanitizeEnv(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
      if (!m) return line.trimEnd();
      const [, key, raw] = m;
      const value = raw.trim();
      const secret = /pass|secret|token|key|api/i.test(key);
      const plain = /^DB_/i.test(key) || /host|port|database|url|dominio|env|debug|charset/i.test(key);
      return `${key} = ${!value ? "" : plain && !secret ? value : "tu_valor_aqui"}`;
    })
    .join("\n")
    .trim();
}

// ---- Temario completo ------------------------------------------------------------

/**
 * Convierte el proyecto en lecciones que lo cubren TODO: cada archivo de código se reparte en tramos pequeños,
 * en el orden en que se construiría desde cero. Los archivos muy cortos se agrupan.
 */
export function buildCurriculum(entries: Entry[], topics: Topic[], extras: Extras = { env: [], assets: [] }): Curriculum {
  const virtual: Record<string, string> = {};
  const files: { path: string; lines: string[]; stage: number }[] = entries
    .filter((e) => CODE.test(e.path) && !SKIP.test(e.path) && (e.text ?? "").trim())
    .map((e) => ({ path: e.path, lines: (e.text ?? "").replace(/\s+$/, "").split("\n"), stage: stageOf(e.path) }));

  // Si los modelos definen tablas, hay una lección que enseña a crear la base de datos.
  // Los .env se enseñan con los secretos tapados.
  let dbName: string | undefined;
  for (const e of extras.env) {
    if (entries.some((x) => x.path === `${e.path}.example`)) continue;
    const clean = sanitizeEnv(e.text);
    if (!clean) continue;
    dbName ??= clean.match(/^DB_(?:DATABASE|NAME)\s*=\s*(\w+)/im)?.[1];
    virtual[e.path] = clean + "\n";
    files.push({ path: e.path, lines: clean.split("\n"), stage: 2 });
  }
  const tables = modelTables(entries);
  if (tables.length && !files.some((f) => /\.sql$/i.test(f.path))) {
    const sql = schemaSql(tables, dbName);
    virtual[SCHEMA_FILE] = sql;
    files.push({ path: SCHEMA_FILE, lines: sql.replace(/\s+$/, "").split("\n"), stage: 1 });
  }

  files.sort((a, b) => a.stage - b.stage || priority(a.path) - priority(b.path) || a.path.localeCompare(b.path));
  const ordered = orderByDependencies(files);

  const lessons: LessonSpec[] = [];
  let pack: { spec: LessonSpec; lines: number; dir: string; stage: number } | undefined;
  for (const f of ordered) {
    const module = STAGES[f.stage]?.name ?? "Otros archivos";
    if (LIBRARY.test(f.path)) {
      // Una lección propia: se copia el archivo completo.
      lessons.push({ module, title: `Copiar ${basename(f.path)}`, parts: [{ file: f.path, from: 1, to: f.lines.length, total: f.lines.length, copy: true }] });
      pack = undefined;
      continue;
    }
    const chunks = chunkLines(f.lines);
    chunks.forEach(([from, to], i) => {
      const part: LessonPart = { file: f.path, from, to, total: f.lines.length };
      const size = to - from + 1;
      const whole = chunks.length === 1;
      const title = whole ? basename(f.path) : `${basename(f.path)} (parte ${i + 1} de ${chunks.length})`;
      // Los archivos cortos y seguidos (mismo tipo de carpeta) comparten lección.
      if (whole && f.stage > 0 && pack && pack.stage === f.stage && pack.dir === dirname(f.path) && pack.lines + size <= PACK_MAX && pack.spec.parts.length < 3) {
        pack.spec.parts.push(part);
        pack.spec.title = pack.spec.parts.map((p) => basename(p.file)).join(" y ");
        pack.lines += size;
        return;
      }
      const spec: LessonSpec = { module, title, parts: [part] };
      lessons.push(spec);
      pack = whole && f.stage > 0 && size <= PACK_MAX / 2 ? { spec, lines: size, dir: dirname(f.path), stage: f.stage } : undefined;
    });
  }
  // Imágenes y fuentes: una lección por carpeta que se copia entera del proyecto original.
  for (const d of extras.assets) {
    lessons.push({ module: "Imágenes y recursos", title: `Copiar la carpeta ${d.dir}`, parts: [{ file: d.dir, from: 1, to: d.count, total: d.count, copy: true, dir: true }] });
  }
  for (const l of lessons) l.topic = topicOfStep({ title: l.module, description: l.parts.map((p) => p.file).join(" "), files: l.parts.map((p) => p.file) }, topics);

  const modules: Curriculum["modules"] = [];
  for (const l of lessons) {
    let m = modules[modules.length - 1];
    if (!m || m.title !== l.module) modules.push((m = { title: l.module, files: [], count: 0 }));
    m.count++;
    for (const p of l.parts) if (!m.files.includes(p.file)) m.files.push(p.file);
  }
  return { lessons, modules, virtual };
}

export const isVirtual = (c: { virtual?: Record<string, string> } | undefined, file: string) => !!c?.virtual && file in c.virtual;
export const ext = (f: string) => extname(f).toLowerCase();
