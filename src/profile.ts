import { basename, dirname } from "path";
import type { Entry } from "./analyzer";

/** Lo que se sabe del proyecto leyendo sus manifiestos y su estructura, sin IA. */
export interface ProjectProfile {
  /** Identidad estable del proyecto (nombre del manifiesto o de la carpeta): no cambia si se mueve de sitio. */
  id: string;
  /** Lenguajes principales, el más usado primero. */
  languages: string[];
  framework?: string;
  architecture?: string;
  entry?: string;
  scripts: { name: string; cmd: string }[];
  /** Variables de entorno que el proyecto lee. */
  env: string[];
  services: string[];
  /** Cosas inusuales que el alumno debería saber antes de empezar. */
  warnings: string[];
}

const LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", php: "PHP", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#", c: "C", cpp: "C++", swift: "Swift",
};

const shallow = (files: Entry[], name: string) =>
  files.filter((f) => f.path === name || f.path.endsWith("/" + name)).sort((a, b) => a.depth - b.depth)[0];

function json(f: Entry | undefined): Record<string, any> {
  if (!f?.text) return {};
  try {
    const j = JSON.parse(f.text);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Nombre estable del proyecto: el del manifiesto, o el de la carpeta si no hay. */
export function projectId(root: string, files: Entry[]): string {
  const pkg = json(shallow(files, "package.json")).name;
  const composer = json(shallow(files, "composer.json")).name;
  const py = shallow(files, "pyproject.toml")?.text?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const cargo = shallow(files, "Cargo.toml")?.text?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const go = shallow(files, "go.mod")?.text?.match(/^module\s+(\S+)/m)?.[1];
  const name = [pkg, composer, py, cargo, go].find((x) => typeof x === "string" && x.trim()) ?? basename(root);
  return String(name).trim().toLowerCase();
}

function detectFramework(files: Entry[], pkg: Record<string, any>): string | undefined {
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const d = (n: string) => n in deps;
  if (/"engines"\s*:\s*\{[^}]*"vscode"/.test(shallow(files, "package.json")?.text ?? "")) return "Extensión de VS Code";
  const node: [string, string][] = [
    ["next", "Next.js"], ["nuxt", "Nuxt"], ["@nestjs/core", "NestJS"], ["express", "Express"], ["fastify", "Fastify"], ["koa", "Koa"],
    ["electron", "Electron"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["@angular/core", "Angular"],
  ];
  const n = node.find(([k]) => d(k));
  if (n) return n[1];
  const composer = json(shallow(files, "composer.json"));
  const cdeps = Object.keys({ ...composer.require, ...composer["require-dev"] }).join(" ");
  if (/laravel\/framework/.test(cdeps)) return "Laravel";
  if (/symfony\//.test(cdeps)) return "Symfony";
  if (/slim\/slim/.test(cdeps)) return "Slim";
  const py = [shallow(files, "requirements.txt")?.text, shallow(files, "pyproject.toml")?.text].join("\n").toLowerCase();
  if (/\bdjango\b/.test(py) || shallow(files, "manage.py")) return "Django";
  if (/\bfastapi\b/.test(py)) return "FastAPI";
  if (/\bflask\b/.test(py)) return "Flask";
  const go = shallow(files, "go.mod")?.text ?? "";
  if (/gin-gonic/.test(go)) return "Gin";
  if (/labstack\/echo/.test(go)) return "Echo";
  if (/gofiber/.test(go)) return "Fiber";
  const cargo = shallow(files, "Cargo.toml")?.text ?? "";
  if (/actix-web/.test(cargo)) return "Actix Web";
  if (/\baxum\b/.test(cargo)) return "Axum";
  if (/\brocket\b/.test(cargo)) return "Rocket";
  return undefined;
}

function detectArchitecture(files: Entry[]): string | undefined {
  const dirs = new Set<string>();
  for (const f of files) for (const part of dirname(f.path).toLowerCase().split("/")) dirs.add(part);
  const has = (...n: string[]) => n.some((x) => dirs.has(x));
  if (has("controllers", "controller") && has("models", "model") && has("views", "view", "templates")) return "MVC (modelos, vistas y controladores)";
  if (has("controllers", "routes", "router") && has("models", "model")) return "Servidor con rutas, controladores y modelos";
  if (has("components") && has("pages", "views")) return "Interfaz por componentes y páginas";
  if (has("routes", "router") && has("services")) return "API por capas (rutas y servicios)";
  if (has("cmd") && has("internal", "pkg")) return "Proyecto Go estándar (cmd, internal, pkg)";
  return undefined;
}

const ENTRY_CANDIDATES = [
  "public/index.php", "index.php", "src/index.php", "app.py", "main.py", "manage.py", "server.js", "app.js", "index.js", "src/index.js",
  "src/index.ts", "src/main.ts", "src/server.ts", "src/app.ts", "src/extension.ts", "main.go", "cmd/main.go", "src/main.rs", "src/lib.rs", "index.html",
];

function detectEntry(files: Entry[], pkg: Record<string, any>): string | undefined {
  const paths = new Set(files.map((f) => f.path));
  const main = typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : "";
  const fromStart = /node\s+(\S+\.m?js)/.exec(String(pkg.scripts?.start ?? ""))?.[1];
  for (const c of [fromStart, main, ...ENTRY_CANDIDATES]) {
    if (!c) continue;
    if (paths.has(c)) return c;
    // El main de package.json suele apuntar a lo compilado: se busca su fuente.
    const src = c.replace(/^(dist|out|build)\//, "src/").replace(/\.js$/, ".ts");
    if (paths.has(src)) return src;
  }
  return undefined;
}

function detectEnv(files: Entry[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const t = f.text ?? "";
    if (/\.env(\.example)?$/.test(f.path)) for (const m of t.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=/gm)) out.add(m[1]);
    if (!/\.(js|ts|mjs|cjs|jsx|tsx|php|py|go|rs)$/.test(f.path)) continue;
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]|getenv\(['"]([A-Z][A-Z0-9_]+)['"]\)|\$_(?:ENV|SERVER)\[['"]([A-Z][A-Z0-9_]+)['"]\]|os\.(?:getenv|environ\.get)\(['"]([A-Z][A-Z0-9_]+)['"]|os\.environ\[['"]([A-Z][A-Z0-9_]+)['"]\]|Getenv\("([A-Z][A-Z0-9_]+)"\)/g)) {
      out.add(m.slice(1).find(Boolean)!);
    }
  }
  return [...out].filter((n) => !["NODE_ENV", "PATH", "HOME", "PWD", "SERVER_NAME", "REQUEST_METHOD", "REQUEST_URI", "HTTP_HOST"].includes(n)).slice(0, 30);
}

/** Servicios externos: solo por dependencias, imágenes de docker y llamadas concretas (nunca por palabras sueltas). */
function detectServices(files: Entry[], pkg: Record<string, any>): string[] {
  const out = new Set<string>();
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" ");
  const body = files
    .filter((f) => /\.(php|py|go|rs|ya?ml|toml)$/.test(f.path) || /(requirements\.txt|composer\.json|go\.mod)$/.test(f.path))
    .map((f) => f.text ?? "")
    .join("\n");
  const all = `${deps}\n${body}`;
  if (/\bmysql2?\b|new mysqli|mysqli_connect|pdo[_:]mysql|image:\s*['"]?(mysql|mariadb)|pymysql|mysql-connector/i.test(all)) out.add("MySQL / MariaDB");
  if (/(^|\s)(pg|pg-promise|postgres)(\s|$)|psycopg|image:\s*['"]?postgres|pdo[_:]pgsql|jackc\/pgx/i.test(all)) out.add("PostgreSQL");
  if (/\bmongoose\b|\bmongodb\b|pymongo/i.test(all)) out.add("MongoDB");
  if (/\bsqlite3?\b|better-sqlite3|pdo[_:]sqlite/i.test(all)) out.add("SQLite");
  if (/\bredis\b|ioredis|predis/i.test(all)) out.add("Redis");
  if (/nodemailer|phpmailer|MAIL_HOST|smtp\./i.test(all)) out.add("Correo (SMTP)");
  // En JavaScript solo cuentan los módulos que de verdad se importan.
  const imports = files.filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f.path)).flatMap((f) => [...(f.text ?? "").matchAll(/(?:require\(\s*|from\s+|import\s+)['"]([^'".][^'"]*)['"]/g)].map((m) => m[1]));
  const used = (re: RegExp) => imports.some((i) => re.test(i));
  if (used(/^(mysql2?(\/.*)?|mariadb)$/)) out.add("MySQL / MariaDB");
  if (used(/^(pg|postgres|pg-promise)$/)) out.add("PostgreSQL");
  if (used(/^(mongodb|mongoose)$/)) out.add("MongoDB");
  if (used(/^(node:sqlite|sqlite3?|better-sqlite3)$/)) out.add("SQLite");
  if (used(/^(redis|ioredis)$/)) out.add("Redis");
  if (used(/^nodemailer$/)) out.add("Correo (SMTP)");
  return [...out];
}

function detectScripts(files: Entry[], pkg: Record<string, any>): { name: string; cmd: string }[] {
  const out: { name: string; cmd: string }[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) if (typeof cmd === "string") out.push({ name: `npm run ${name}`, cmd });
  for (const [name, cmd] of Object.entries(json(shallow(files, "composer.json")).scripts ?? {})) {
    if (typeof cmd === "string") out.push({ name: `composer ${name}`, cmd });
  }
  return out.slice(0, 12);
}

/** Avisos: librerías copiadas a mano, secretos a la vista y archivos vacíos. */
function detectWarnings(files: Entry[], empty: string[], secrets: boolean): string[] {
  const out: string[] = [];
  const libs = files.filter((f) => /(^|\/)_?normalize(\.min)?\.(s?css)$/i.test(f.path));
  if (libs.length) out.push(`Incluye librerías de terceros (${libs.map((f) => basename(f.path)).join(", ")}): se copian, no se escriben.`);
  if (empty.length) out.push(`Archivos vacíos que no tendrán lección: ${empty.slice(0, 5).join(", ")}${empty.length > 5 ? "…" : ""}.`);
  if (secrets) out.push("Hay un archivo .env con claves reales: las lecciones lo muestran con los secretos tapados.");
  return out;
}

export interface ProfileExtras { empty?: string[]; hasSecrets?: boolean }

export function buildProfile(root: string, files: Entry[], extras: ProfileExtras = {}): ProjectProfile {
  const pkg = json(shallow(files, "package.json"));
  const counts = new Map<string, number>();
  for (const f of files) {
    const l = LANGS[f.path.split(".").pop()?.toLowerCase() ?? ""];
    if (l) counts.set(l, (counts.get(l) ?? 0) + f.lines);
  }
  return {
    id: projectId(root, files),
    languages: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 3),
    framework: detectFramework(files, pkg),
    architecture: detectArchitecture(files),
    entry: detectEntry(files, pkg),
    scripts: detectScripts(files, pkg),
    env: detectEnv(files),
    services: detectServices(files, pkg),
    warnings: detectWarnings(files, extras.empty ?? [], !!extras.hasSecrets),
  };
}

/** El perfil como texto para el modelo: hechos comprobados, para que no tenga que adivinarlos. */
export function profileText(p: ProjectProfile): string {
  const lines = [
    p.languages.length ? `Lenguajes: ${p.languages.join(", ")}` : "",
    p.framework ? `Framework: ${p.framework}` : "",
    p.architecture ? `Arquitectura: ${p.architecture}` : "",
    p.entry ? `Punto de entrada: ${p.entry}` : "",
    p.services.length ? `Servicios: ${p.services.join(", ")}` : "",
    p.scripts.length ? `Scripts: ${p.scripts.map((s) => s.name).join(", ")}` : "",
    p.env.length ? `Variables de entorno: ${p.env.join(", ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Tipo de proyecto deducido: lo más específico que se sepa. */
export function profileType(p: ProjectProfile): string | undefined {
  if (p.framework === "Extensión de VS Code") return p.framework;
  if (p.framework) return `${p.architecture?.startsWith("MVC") ? "Aplicación MVC" : "Proyecto"} con ${p.framework}${p.languages[0] && !["JavaScript", "TypeScript"].includes(p.languages[0]) ? ` (${p.languages[0]})` : ""}`;
  if (p.architecture?.startsWith("MVC") && p.languages[0]) return `Aplicación MVC en ${p.languages[0]}`;
  return undefined;
}
