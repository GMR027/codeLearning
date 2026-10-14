import { readdir, readFile, stat } from "fs/promises";
import { basename, join, relative } from "path";

import type { Requirement } from "./requirements";
import { buildCurriculum, type Extras, type LessonSpec } from "./curriculum";
import { buildProfile, profileText, profileType, type ProjectProfile } from "./profile";

export interface Topic { name: string; description: string }
export interface PlanStep { title: string; description: string; files: string[] }
export interface Analysis {
  name: string;
  root: string;
  /** Identidad del proyecto (manifiesto o carpeta): reconoce el avance aunque la carpeta cambie de sitio. */
  id?: string;
  /** Lo deducido leyendo manifiestos y estructura, sin IA. */
  profile?: ProjectProfile;
  type: string;
  summary: string;
  topics: Topic[];
  startHere: string;
  plan: PlanStep[];
  /** "ai" = lo redactó el modelo; "basic" = detección sin IA. */
  source: "ai" | "basic";
  files: number;
  level: string;
  language: string;
  analyzedAt: number;
  /** Lo que hace falta instalar para desarrollar el proyecto (sin estado: el estado se comprueba al mostrarlo). */
  requirements?: Requirement[];
  /** Todas las lecciones, que cubren cada archivo de código del proyecto en orden de construcción. */
  curriculum?: LessonSpec[];
  /** Archivos que no existen en el proyecto pero se enseñan (p. ej. el esquema de la base de datos). */
  virtual?: Record<string, string>;
}

export interface AnalyzeOptions { detect?: (files: Entry[]) => Requirement[]; level: string; language: string; ask: (system: string, prompt: string, signal?: AbortSignal) => Promise<string>; modelLabel: string; onProgress: (msg: string) => void; signal?: AbortSignal }

const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "__pycache__", "venv", ".venv", "coverage", "bin", "obj"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|rb|go|rs|java|kt|cs|c|h|cpp|hpp|swift|vue|svelte|html|css|scss|sass|sql|sh|json|ya?ml|toml|md|env\.example)$/i;
const MANIFESTS = /^(package\.json|composer\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Gemfile|docker-compose\.ya?ml|Dockerfile|tsconfig\.json|vite\.config\.\w+|webpack\.config\.\w+|\.env\.example)$/;
const KEY_FILE = /^(index|main|app|server|extension|program|bootstrap|init|__init__|manage|artisan|router|routes?|config|settings|database|db)\.\w+$/i;
const MAX_FILES = 1500;
const MAX_BYTES = 200_000;
/** Presupuesto de texto para el modelo: cabe en ~8k tokens de contexto. */
const BUDGET = { manifests: 5000, readme: 1800, code: 9000, tree: 3500 };

export interface Entry { path: string; lines: number; text?: string; depth: number }

export async function walk(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await visit(full, depth + 1);
      } else if (e.isFile() && (CODE_EXT.test(e.name) || MANIFESTS.test(e.name) || /^readme/i.test(e.name) || e.name === "Dockerfile")) {
        const st = await stat(full).catch(() => undefined);
        if (!st || st.size > MAX_BYTES) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        if (!text || /\.min\.\w+$/.test(e.name)) continue;
        out.push({ path: relative(root, full).split("\\").join("/"), lines: text.split("\n").length, text, depth });
      }
    }
  };
  await visit(root, 0);
  return out;
}

const ASSET_DIR = /^(img|imgs|images|fonts|icons)$/i;
const ASSET_FILE = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i;
const NO_ASSETS = /(^|\/)(build|dist|out|vendor|node_modules|coverage|\.git)(\/|$)/;

/** Archivos .env y carpetas de imágenes/fuentes del proyecto (lo que no es código pero hace falta para reconstruirlo). */
export async function collectExtras(root: string): Promise<Extras> {
  const extras: Extras = { env: [], assets: [], empty: [] };
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split("\\").join("/");
      if (e.isDirectory()) {
        if (NO_ASSETS.test(rel + "/")) continue;
        if (ASSET_DIR.test(e.name)) {
          const count = await countFiles(full);
          if (count) extras.assets.push({ dir: rel, count });
          continue;
        }
        if (!e.name.startsWith(".")) await visit(full, depth + 1);
      } else if (e.isFile() && CODE_EXT.test(e.name) && !/\.(json|ya?ml|toml|md)$/i.test(e.name) && (await stat(full).catch(() => undefined))?.size === 0) {
        extras.empty!.push(rel);
      } else if (depth <= 2 && /^\.env(\.local)?$/.test(e.name)) {
        const text = await readFile(full, "utf8").catch(() => "");
        if (text.trim() && text.length < 20_000) extras.env.push({ path: rel, text });
      }
    }
  };
  await visit(root, 0);
  extras.assets.sort((a, b) => a.dir.localeCompare(b.dir));
  return extras;
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (ASSET_FILE.test(e.name)) n++;
  }
  return n;
}

// ---- Detección sin IA ------------------------------------------------------------

const LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript (React)", js: "JavaScript", jsx: "JavaScript (React)", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", php: "PHP", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#", c: "C", h: "C", cpp: "C++",
  swift: "Swift", vue: "Vue", svelte: "Svelte", html: "HTML", css: "CSS", scss: "Sass", sass: "Sass", sql: "SQL", sh: "Shell",
};

/** Carpeta/archivo -> tema. El orden numérico es el orden natural para construir un proyecto desde cero. */
const TOPIC_RULES: { re: RegExp; name: string; description: string; order: number }[] = [
  { re: /(^|\/)(config|settings|env|\.env)/i, name: "Ajustes", description: "Configuración y variables de entorno.", order: 1 },
  { re: /(^|\/)(db|database|migrations?|models?|schema|entities)(\/|\.)/i, name: "Datos", description: "Base de datos y modelos.", order: 2 },
  { re: /(^|\/)(server|api|controllers?|routes?|routers?|services?|middleware|backend|src\/.*(server|api))/i, name: "Backend", description: "Lógica del servidor y rutas.", order: 3 },
  { re: /(^|\/)(components?|views?|pages?|templates?|public|assets|styles?|css|sass|scss|frontend|ui|media)(\/|\.)/i, name: "Frontend", description: "Interfaz y estilos.", order: 4 },
  { re: /(^|\/)(tests?|__tests__|spec)(\/|\.)/i, name: "Pruebas", description: "Pruebas automáticas.", order: 5 },
  { re: /(^|\/)(docker|Dockerfile|docker-compose|\.github|deploy|scripts?)/i, name: "Servidor y despliegue", description: "Contenedores, scripts y despliegue.", order: 6 },
];

function detectType(files: Entry[]): string {
  const find = (n: string) => files.find((f) => f.path === n || f.path.endsWith("/" + n));
  const pkg = find("package.json")?.text ?? "";
  const has = (s: string) => pkg.includes(`"${s}"`);
  if (/"engines"\s*:\s*\{[^}]*"vscode"/.test(pkg)) return "Extensión de VS Code";
  if (has("next")) return "Aplicación web con Next.js";
  if (has("react")) return "Aplicación web con React";
  if (has("vue")) return "Aplicación web con Vue";
  if (has("express") || has("fastify") || has("koa")) return "API / servidor Node.js";
  if (find("composer.json")) return "Aplicación PHP";
  if (find("manage.py")) return "Aplicación Django";
  if (find("requirements.txt") || find("pyproject.toml")) return "Proyecto Python";
  if (find("Cargo.toml")) return "Proyecto Rust";
  if (find("go.mod")) return "Proyecto Go";
  if (pkg) return "Proyecto Node.js";
  if (files.some((f) => f.path.endsWith(".html"))) return "Sitio web estático";
  return "Proyecto de software";
}

function basicAnalysis(root: string, files: Entry[], o: AnalyzeOptions): Analysis {
  const counts = new Map<string, number>();
  for (const f of files) {
    const l = LANGS[f.path.split(".").pop()?.toLowerCase() ?? ""];
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const langs = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const type = detectType(files);

  const found = new Map<string, { name: string; description: string; order: number; files: string[] }>();
  for (const f of files) {
    const rule = TOPIC_RULES.find((r) => r.re.test(f.path));
    if (!rule) continue;
    const cur = found.get(rule.name) ?? { name: rule.name, description: rule.description, order: rule.order, files: [] };
    cur.files.push(f.path);
    found.set(rule.name, cur);
  }
  const ordered = [...found.values()].sort((a, b) => a.order - b.order);
  const manifests = files.filter((f) => MANIFESTS.test(basename(f.path)) && f.depth <= 1).map((f) => f.path);
  const plan: PlanStep[] = [
    { title: "Preparar el proyecto", description: "Crear la carpeta, el archivo de dependencias y la estructura base.", files: manifests.slice(0, 5) },
    ...ordered.map((t) => ({ title: t.name, description: t.description, files: t.files.slice(0, 6) })),
  ];
  const entry = files.filter((f) => KEY_FILE.test(basename(f.path))).sort((a, b) => a.depth - b.depth)[0];
  if (entry) plan.push({ title: "Unir todo", description: "Conectar las partes desde el punto de entrada.", files: [entry.path] });
  return {
    name: basename(root),
    root,
    type,
    summary: `${type} con ${files.length} archivos${langs.length ? ` (${langs.slice(0, 3).join(", ")})` : ""}. Análisis básico sin IA: conecta un modelo en Ajustes para una descripción completa.`,
    topics: ordered.map((t) => ({ name: t.name, description: t.description })),
    startHere: manifests[0] ?? plan[1]?.files[0] ?? "",
    plan,
    source: "basic",
    files: files.length,
    level: o.level,
    language: o.language,
    analyzedAt: Date.now(),
  };
}

// ---- Contexto para el modelo ----------------------------------------------------

function head(text: string, lines: number, chars: number): string {
  return text.split("\n").slice(0, lines).join("\n").slice(0, chars);
}

/** Árbol + manifiestos + README + el arranque de los archivos clave (entradas, rutas, config…). */
function buildContext(files: Entry[]): string {
  const tree = files.map((f) => `${f.path} (${f.lines}l)`).join("\n").slice(0, BUDGET.tree);

  let left = BUDGET.manifests;
  const manifests: string[] = [];
  for (const f of files.filter((f) => MANIFESTS.test(basename(f.path)) && f.depth <= 2)) {
    const t = head(f.text ?? "", 60, 1500);
    if (left - t.length < 0) break;
    left -= t.length;
    manifests.push(`### ${f.path}\n${t}`);
  }

  const readme = files.find((f) => /^readme/i.test(basename(f.path)) && f.depth === 0);

  // Archivos clave: los de nombre típico de entrada primero, luego los más cercanos a la raíz y más grandes.
  const score = (f: Entry) => (KEY_FILE.test(basename(f.path)) ? 100 : 0) - f.depth * 10 + Math.min(f.lines, 300) / 30;
  const code = files
    .filter((f) => !MANIFESTS.test(basename(f.path)) && !/\.(md|json|ya?ml|toml)$/i.test(f.path))
    .sort((a, b) => score(b) - score(a));
  let budget = BUDGET.code;
  const snippets: string[] = [];
  for (const f of code) {
    if (budget < 300) break;
    const t = head(f.text ?? "", 45, Math.min(1200, budget));
    budget -= t.length;
    snippets.push(`### ${f.path}\n${t}`);
  }

  return [
    `## Árbol de archivos\n${tree}`,
    `## Manifiestos\n${manifests.join("\n\n")}`,
    readme ? `## README\n${head(readme.text ?? "", 40, BUDGET.readme)}` : "",
    `## Código clave\n${snippets.join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const LANG_NAMES: Record<string, string> = { es: "español", en: "English", pt: "português", fr: "français" };
export const LEVEL_NAMES: Record<string, string> = {
  beginner: "principiante (nunca ha programado; pasos muy pequeños)",
  intermediate: "intermedio (conoce lo básico)",
  advanced: "avanzado (conoce el lenguaje; ir a la arquitectura)",
};

function systemPrompt(o: AnalyzeOptions): string {
  return `Eres un profesor de programación. Analizas un proyecto real para armar un temario con el que un alumno de nivel ${LEVEL_NAMES[o.level] ?? o.level} lo construya DESDE CERO.
Escribe todo en ${LANG_NAMES[o.language] ?? o.language}. Responde SOLO con JSON válido, sin texto extra, con esta forma exacta:
{"name":"nombre del proyecto","type":"tipo de proyecto","summary":"de qué trata, 2-3 frases","topics":[{"name":"Backend","description":"qué hay en este tema"}],"startHere":"por dónde debe empezar el alumno y por qué","plan":[{"title":"paso","description":"qué construye el alumno y qué aprende","files":["ruta/real/del/proyecto"]}]}
El "Perfil detectado" del mensaje es cierto: úsalo tal cual para el tipo, el framework y la arquitectura.
Reglas: "plan" va en el orden real de construcción (de lo primero que se crea hasta lo último), entre 5 y 12 pasos; "files" solo con rutas que existan en el árbol; "topics" son las áreas del proyecto (backend, frontend, servidor, ajustes, datos, pruebas…).`;
}

function parse(raw: string): Omit<Analysis, "root" | "source" | "files" | "level" | "language" | "analyzedAt"> | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const topics = (Array.isArray(j.topics) ? j.topics : [])
      .map((t) => (typeof t === "string" ? { name: t, description: "" } : { name: str((t as Topic)?.name), description: str((t as Topic)?.description) }))
      .filter((t) => t.name);
    const plan = (Array.isArray(j.plan) ? j.plan : [])
      .map((p) => ({
        title: str((p as PlanStep)?.title),
        description: str((p as PlanStep)?.description),
        files: Array.isArray((p as PlanStep)?.files) ? (p as PlanStep).files.filter((f) => typeof f === "string").slice(0, 8) : [],
      }))
      .filter((p) => p.title);
    if (!str(j.type) || !str(j.summary) || !plan.length) return undefined;
    return { name: str(j.name), type: str(j.type), summary: str(j.summary), topics, startHere: str(j.startHere), plan };
  } catch {
    return undefined;
  }
}

export async function analyzeProject(root: string, o: AnalyzeOptions): Promise<Analysis> {
  const files = await walk(root);
  const extras = await collectExtras(root);
  const profile = buildProfile(root, files, { empty: extras.empty, hasSecrets: extras.env.some((e) => /^\s*\w*(pass|secret|token|key)\w*\s*=\s*\S/im.test(e.text)) });
  const result = await analyzeFiles(root, files, o, profile);
  result.id = profile.id;
  result.profile = profile;
  // Lo que se lee en los manifiestos manda sobre lo que adivine un modelo pequeño.
  const known = profileType(profile);
  if (known) result.type = known;
  result.requirements = o.detect?.(files) ?? [];
  // El temario cubre todo el proyecto, no solo unos cuantos archivos que elija el modelo.
  const cur = buildCurriculum(files, result.topics, extras);
  if (cur.lessons.length) {
    result.curriculum = cur.lessons;
    result.virtual = cur.virtual;
    result.plan = cur.modules.map((m) => ({ title: m.title, description: `${m.count} ${m.count === 1 ? "lección" : "lecciones"}`, files: m.files.slice(0, 8) }));
    result.startHere = cur.lessons[0].parts[0].file;
  }
  return result;
}

async function analyzeFiles(root: string, files: Entry[], o: AnalyzeOptions, profile: ProjectProfile): Promise<Analysis> {
  o.onProgress("leyendo el proyecto…");
  if (!files.length) throw new Error(`no se encontró código en ${root}`);
  const basic = basicAnalysis(root, files, o);

  const ctx = `## Perfil detectado (comprobado en los archivos)\n${profileText(profile)}\n\n${buildContext(files)}`;
  const paths = new Set(files.map((f) => f.path));
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    o.onProgress(attempt === 1 ? `analizando ${files.length} archivos con ${o.modelLabel}…` : "el modelo respondió mal, reintentando…");
    try {
      const raw = await o.ask(systemPrompt(o), ctx, o.signal);
      const r = parse(raw);
      if (r) {
        const byBase = new Map<string, string>();
        for (const f of paths) byBase.set(basename(f), f);
        const plan = r.plan.map((p) => {
          // El modelo puede inventar rutas o dejar "files" vacío: se conservan las reales y se rescatan las que menciona en el texto.
          const mentioned = [...`${p.title} ${p.description}`.matchAll(/[\w./-]+\.\w{1,5}/g)].map((m) => (paths.has(m[0]) ? m[0] : byBase.get(basename(m[0]))));
          const files = [...new Set([...p.files.filter((f) => paths.has(f)), ...mentioned.filter((f): f is string => !!f)])].slice(0, 8);
          return { ...p, title: p.title.replace(/^\s*(paso\s*)?\d+\s*[.):-]\s*/i, ""), files };
        });
        // Un modelo pequeño suele dar pocos temas o un tipo genérico: se completa con lo detectado sin IA.
        const names = new Set(r.topics.map((t) => t.name.toLowerCase()));
        const topics = [...r.topics, ...basic.topics.filter((t) => !names.has(t.name.toLowerCase()))];
        return {
          ...r,
          name: r.name || basic.name,
          type: r.type.trim().split(/\s+/).length < 2 ? `${r.type} · ${basic.type}` : r.type,
          topics,
          plan,
          root,
          source: "ai",
          files: files.length,
          level: o.level,
          language: o.language,
          analyzedAt: Date.now(),
        };
      }
    } catch (err) {
      if (o.signal?.aborted) throw err;
      lastError = (err as Error).message;
      if (/fetch failed|ECONNREFUSED|ENOENT|no está instalado/.test(lastError)) break; // Ollama apagado: reintentar no sirve
    }
  }
  if (lastError) basic.summary += ` (Modelo no disponible: ${lastError})`;
  return basic;
}

// ---- Tema de cada lección (para el gráfico de avance) -------------------------------

const SYNONYMS: Record<string, string[]> = {
  backend: ["backend", "servidor", "api", "controlador", "controller", "ruta", "route", "router", "lógica", "logica", "middleware", "endpoint"],
  frontend: ["frontend", "interfaz", "vista", "view", "estilo", "css", "sass", "scss", "html", "ui", "componente", "plantilla", "template", "diseño"],
  datos: ["datos", "base de datos", "database", "modelo", "model", "sql", "migrac", "schema", "entidad", "activerecord"],
  ajustes: ["ajuste", "config", "entorno", "instal", "dependenc", "preparar", "env", "setting", "estructura"],
  pruebas: ["prueba", "test", "spec"],
  despliegue: ["despliegue", "docker", "deploy", "contenedor", "producción", "produccion"],
};

/** Tema al que pertenece un paso del plan: por el nombre del tema y por sinónimos, mirando título, descripción y archivos. */
export function topicOfStep(step: PlanStep, topics: Topic[]): string | undefined {
  const text = `${step.title} ${step.description}`.toLowerCase();
  const files = step.files.join(" ").toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const t of topics) {
    const label = `${t.name} ${t.description}`.toLowerCase();
    let score = 0;
    for (const w of t.name.toLowerCase().split(/[\s,/y]+/).filter((x) => x.length > 3)) {
      if (text.includes(w)) score += 3;
      if (files.includes(w)) score += 2;
    }
    for (const words of Object.values(SYNONYMS)) {
      // El tema pertenece a este grupo si su nombre menciona alguna de sus palabras.
      if (!words.some((w) => t.name.toLowerCase().includes(w))) continue;
      for (const w of words) {
        if (text.includes(w)) score += 1;
        if (files.includes(w)) score += 2;
      }
    }
    if (label && score > (best?.score ?? 0)) best = { name: t.name, score };
  }
  return best?.name;
}

export interface TopicProgress { name: string; done: number; total: number; pct: number }

/** Avance por tema: lecciones terminadas / lecciones del tema. Las que no encajan en ningún tema van a «General». */
export function buildChart(a: Analysis, status: string[]): { topics: TopicProgress[]; overall: number } {
  const map = new Map<string, { done: number; total: number }>(a.topics.map((t) => [t.name, { done: 0, total: 0 }]));
  const specs = a.curriculum?.length ? a.curriculum.map((l) => ({ topic: l.topic })) : a.plan.map((step) => ({ topic: topicOfStep(step, a.topics) }));
  specs.forEach((sp, i) => {
    const name = sp.topic ?? "General";
    const cur = map.get(name) ?? { done: 0, total: 0 };
    cur.total++;
    if (status[i] === "done") cur.done++;
    map.set(name, cur);
  });
  const topics = [...map.entries()].filter(([, v]) => v.total > 0).map(([name, v]) => ({ name, ...v, pct: Math.round((v.done / v.total) * 100) }));
  const total = specs.length;
  const done = status.filter((x) => x === "done").length;
  return { topics, overall: total ? Math.round((done / total) * 100) : 0 };
}
