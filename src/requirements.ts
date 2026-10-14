import * as vscode from "vscode";
import { execFile } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { dirname, join } from "path";
import type { Entry } from "./analyzer";

/** Qué hace falta para desarrollar el proyecto. La detección es determinista (no depende de la IA). */
export interface Check {
  /** Comandos que se ejecutan para comprobar la versión. */
  cmds?: string[][];
  /** "all": todos deben existir; "any": basta uno (p. ej. mysql o mariadb). */
  mode?: "all" | "any";
  /** Expresión que debe aparecer en la salida (p. ej. extensiones de «php -m»). */
  match?: string;
  /** Ruta absoluta que debe existir (p. ej. node_modules/sass). */
  path?: string;
}

export interface Requirement {
  id: string;
  name: string;
  /** runtime = lenguaje/herramienta del equipo; database = servidor de datos; dependency = paquete del proyecto. */
  kind: "runtime" | "database" | "tool" | "dependency";
  scope: "system" | "project";
  why: string;
  check: Check;
  /** Solo paquetes npm: nombre, versión pedida y carpeta del package.json. */
  npm?: { name: string; range: string; dir: string };
  installed?: boolean;
  version?: string;
}

export interface InstallOption { label: string; scope: "system" | "global" | "local"; command?: string; cwd?: string; link?: string }

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Un rango de versión que nunca lleva caracteres de shell. */
const NPM_RANGE = /^[\w.^~<>=|* -]{1,40}$/;
/** Herramientas de línea de comandos que tiene sentido instalar en todo el equipo. */
const GLOBAL_CLI = new Set(["sass", "gulp-cli", "typescript", "nodemon", "webpack-cli", "ts-node", "eslint", "prettier", "serve", "vite"]);
const MAX_DEPS = 40;

// ---- Detección ------------------------------------------------------------------

const has = (files: Entry[], re: RegExp) => files.some((f) => re.test(f.path));
const shallowest = (files: Entry[], name: string) =>
  files.filter((f) => f.path === name || f.path.endsWith("/" + name)).sort((a, b) => a.depth - b.depth)[0];

export function detectRequirements(root: string, files: Entry[]): Requirement[] {
  const out: Requirement[] = [];
  const add = (r: Requirement) => { if (!out.some((x) => x.id === r.id)) out.push(r); };
  const text = (f: Entry) => f.text ?? "";

  // Node.js / npm
  const pkgFile = shallowest(files, "package.json");
  if (pkgFile || has(files, /\.(js|mjs|ts|tsx|jsx|vue|svelte)$/)) {
    add({
      id: "node", name: "Node.js y npm", kind: "runtime", scope: "system",
      why: pkgFile ? "El proyecto usa package.json" : "El proyecto tiene código JavaScript/TypeScript",
      check: { cmds: [["node", "--version"], ["npm", "--version"]], mode: "all" },
    });
  }
  if (pkgFile) {
    const dir = join(root, dirname(pkgFile.path));
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try { pkg = JSON.parse(text(pkgFile)); } catch { /* package.json roto: se omiten las dependencias */ }
    const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([n]) => NPM_NAME.test(n))
      .sort(([a], [b]) => Number(a.startsWith("@types/")) - Number(b.startsWith("@types/")) || a.localeCompare(b))
      .slice(0, MAX_DEPS);
    for (const [name, range] of deps) {
      add({
        id: `npm:${name}`, name, kind: "dependency", scope: "project",
        why: pkg.devDependencies?.[name] ? "Dependencia de desarrollo" : "Dependencia del proyecto",
        check: { path: join(dir, "node_modules", name, "package.json") },
        npm: { name, range: NPM_RANGE.test(range) ? range : "", dir },
      });
    }
  } else if (has(files, /\.(scss|sass)$/)) {
    add({
      id: "tool:sass", name: "sass", kind: "tool", scope: "system", why: "El proyecto tiene archivos .scss",
      check: { cmds: [["sass", "--version"]] },
    });
  }

  // PHP / Composer
  const composer = shallowest(files, "composer.json");
  if (composer || has(files, /\.php$/)) {
    add({ id: "php", name: "PHP", kind: "runtime", scope: "system", why: "El proyecto está escrito en PHP", check: { cmds: [["php", "--version"]] } });
  }
  if (composer) {
    add({ id: "composer", name: "Composer", kind: "tool", scope: "system", why: "El proyecto tiene composer.json", check: { cmds: [["composer", "--version"]] } });
    add({
      id: "composer-deps", name: "Dependencias de Composer", kind: "dependency", scope: "project", why: "Carpeta vendor/ del proyecto",
      check: { path: join(root, dirname(composer.path), "vendor", "autoload.php") },
    });
  }

  // Bases de datos: se deducen del código, de los .env de ejemplo y de docker-compose.
  const body = files.filter((f) => /\.(php|js|ts|py|rb|go|java|cs|ya?ml|json|example|toml|xml)$/.test(f.path) || /requirements\.txt$/.test(f.path)).map(text).join("\n");
  if (/new mysqli|mysqli_connect|pdo[_:]mysql|mysql:(host|dbname)|mysql:\/\/|DB_CONNECTION\s*=\s*mysql|image:\s*['"]?(mysql|mariadb)|["']mysql2?["']\s*:|mysql-connector|pymysql/i.test(body)) {
    add({ id: "mysql", name: "MySQL / MariaDB", kind: "database", scope: "system", why: "El código se conecta a MySQL", check: { cmds: [["mysql", "--version"], ["mariadb", "--version"]], mode: "any" } });
    if (out.some((r) => r.id === "php")) {
      add({ id: "php-mysql", name: "Extensión PHP para MySQL", kind: "runtime", scope: "system", why: "PHP necesita mysqli o pdo_mysql", check: { cmds: [["php", "-m"]], match: "mysqli|pdo_mysql" } });
    }
  }
  if (/pgsql:|postgres(ql)?:\/\/|psycopg|DB_CONNECTION\s*=\s*pgsql|image:\s*['"]?postgres|["']pg["']\s*:/i.test(body)) {
    add({ id: "postgres", name: "PostgreSQL", kind: "database", scope: "system", why: "El código se conecta a PostgreSQL", check: { cmds: [["psql", "--version"]] } });
  }
  if (/mongodb(\+srv)?:\/\/|["']mongoose["']\s*:|pymongo|image:\s*['"]?mongo/i.test(body)) {
    add({ id: "mongodb", name: "MongoDB", kind: "database", scope: "system", why: "El código usa MongoDB", check: { cmds: [["mongod", "--version"]] } });
  }

  // Otros lenguajes
  const py = shallowest(files, "requirements.txt") ?? shallowest(files, "pyproject.toml");
  if (py || has(files, /\.py$/)) {
    add({ id: "python", name: "Python 3 y pip", kind: "runtime", scope: "system", why: "El proyecto está escrito en Python", check: { cmds: [["python3", "--version"], ["python3", "-m", "pip", "--version"]], mode: "all" } });
  }
  if (py && /requirements\.txt$/.test(py.path)) {
    add({ id: "py-deps", name: "Dependencias de Python", kind: "dependency", scope: "project", why: "Entorno virtual .venv del proyecto", check: { path: join(root, dirname(py.path), ".venv") } });
  }
  if (has(files, /(^|\/)go\.mod$/)) add({ id: "go", name: "Go", kind: "runtime", scope: "system", why: "El proyecto tiene go.mod", check: { cmds: [["go", "version"]] } });
  if (has(files, /(^|\/)Cargo\.toml$/)) add({ id: "cargo", name: "Rust (cargo)", kind: "runtime", scope: "system", why: "El proyecto tiene Cargo.toml", check: { cmds: [["cargo", "--version"]] } });
  if (has(files, /(^|\/)(pom\.xml|build\.gradle)$/) || has(files, /\.java$/)) {
    add({ id: "java", name: "Java (JDK) y Maven", kind: "runtime", scope: "system", why: "El proyecto es Java", check: { cmds: [["javac", "-version"], ["mvn", "--version"]], mode: "all" } });
  }
  if (has(files, /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/)) {
    add({ id: "docker", name: "Docker", kind: "tool", scope: "system", why: "El proyecto usa contenedores", check: { cmds: [["docker", "--version"]] } });
  }
  return out;
}

// ---- Comprobación ---------------------------------------------------------------

function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd[0], cmd.slice(1), { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

export async function checkOne(r: Requirement): Promise<Requirement> {
  const c = r.check;
  if (c.path) return { ...r, installed: existsSync(c.path), version: undefined };
  const results = await Promise.all((c.cmds ?? []).map(run));
  const pass = (x: { ok: boolean; out: string }) => x.ok && (!c.match || new RegExp(c.match, "i").test(x.out));
  const installed = c.mode === "any" ? results.some(pass) : results.length > 0 && results.every(pass);
  const first = c.match ? undefined : results.find((x) => x.ok)?.out.match(/\d+(\.\d+)+/)?.[0];
  return { ...r, installed, version: installed ? first : undefined };
}

export const checkAll = (rs: Requirement[]) => Promise.all(rs.map(checkOne));

// ---- Instalación ----------------------------------------------------------------

type Pm = "apt" | "dnf" | "pacman" | "zypper" | "brew";
const PM_BINS: [Pm, string][] = [["apt", "apt-get"], ["dnf", "dnf"], ["pacman", "pacman"], ["zypper", "zypper"], ["brew", "brew"]];

const onPath = (bin: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
export const detectPm = (): Pm | undefined => PM_BINS.find(([, bin]) => onPath(bin))?.[0];

/** Paquetes del sistema por gestor. Lista cerrada: nada de lo que viene del proyecto llega a estos comandos. */
const SYS: Record<string, Partial<Record<Pm, string>>> = {
  node: { apt: "nodejs npm", dnf: "nodejs npm", pacman: "nodejs npm", zypper: "nodejs npm", brew: "node" },
  php: { apt: "php php-cli php-mbstring php-xml", dnf: "php php-cli php-mbstring php-xml", pacman: "php", zypper: "php8", brew: "php" },
  "php-mysql": { apt: "php-mysql", dnf: "php-mysqlnd", zypper: "php8-mysql" },
  composer: { apt: "composer", dnf: "composer", pacman: "composer", zypper: "php-composer2", brew: "composer" },
  mysql: { apt: "mysql-server", dnf: "mysql-server", pacman: "mariadb", zypper: "mariadb", brew: "mysql" },
  postgres: { apt: "postgresql", dnf: "postgresql-server", pacman: "postgresql", zypper: "postgresql-server", brew: "postgresql" },
  python: { apt: "python3 python3-pip python3-venv", dnf: "python3 python3-pip", pacman: "python python-pip", zypper: "python3 python3-pip", brew: "python" },
  go: { apt: "golang", dnf: "golang", pacman: "go", zypper: "go", brew: "go" },
  cargo: { apt: "cargo", dnf: "cargo", pacman: "rust", zypper: "cargo", brew: "rust" },
  java: { apt: "default-jdk maven", dnf: "java-latest-openjdk-devel maven", pacman: "jdk-openjdk maven", zypper: "java-17-openjdk-devel maven", brew: "openjdk maven" },
  docker: { apt: "docker.io docker-compose", dnf: "docker", pacman: "docker docker-compose", zypper: "docker", brew: "--cask docker" },
};
const LINKS: Record<string, string> = {
  mongodb: "https://www.mongodb.com/docs/manual/installation/",
  node: "https://nodejs.org/en/download",
  php: "https://www.php.net/manual/es/install.php",
  mysql: "https://dev.mysql.com/downloads/",
  docker: "https://docs.docker.com/engine/install/",
};

const PM_CMD: Record<Pm, (pkgs: string) => string> = {
  apt: (p) => `sudo apt-get install -y ${p}`,
  dnf: (p) => `sudo dnf install -y ${p}`,
  pacman: (p) => `sudo pacman -S --needed ${p}`,
  zypper: (p) => `sudo zypper install -y ${p}`,
  brew: (p) => `brew install ${p}`,
};

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `npm install -g` necesita sudo si el prefijo de npm no es escribible (Node del sistema). */
async function npmGlobalPrefix(): Promise<string> {
  const { ok, out } = await run(["npm", "config", "get", "prefix"]);
  if (!ok || !out) return "";
  try { accessSync(out, constants.W_OK); return ""; } catch { return "sudo "; }
}

export async function installOptions(r: Requirement): Promise<InstallOption[]> {
  const opts: InstallOption[] = [];
  const pm = detectPm();
  const sys = r.id.startsWith("tool:") ? undefined : SYS[r.id];
  if (r.scope === "system" && sys && pm && sys[pm]) {
    opts.push({ label: "Instalar en el equipo", scope: "system", command: PM_CMD[pm](sys[pm]!) });
  } else if (LINKS[r.id]) {
    opts.push({ label: "Ver cómo instalar", scope: "system", link: LINKS[r.id] });
  }
  if (r.id === "tool:sass") {
    opts.push({ label: "Instalar global", scope: "global", command: `${await npmGlobalPrefix()}npm install -g sass` });
  }
  if (r.npm) {
    const spec = r.npm.range ? `${r.npm.name}@${r.npm.range}` : r.npm.name;
    opts.push({ label: "Instalar en el proyecto", scope: "local", command: `npm install ${q(spec)}`, cwd: r.npm.dir });
    if (GLOBAL_CLI.has(r.npm.name)) {
      opts.push({ label: "Instalar global", scope: "global", command: `${await npmGlobalPrefix()}npm install -g ${r.npm.name}` });
    }
  }
  if (r.id === "composer-deps") opts.push({ label: "Instalar en el proyecto", scope: "local", command: "composer install", cwd: dirname(dirname(r.check.path ?? "")) });
  if (r.id === "py-deps") {
    opts.push({ label: "Instalar en el proyecto", scope: "local", command: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", cwd: dirname(r.check.path ?? "") });
  }
  return opts;
}

/** Instala de una vez todas las dependencias pendientes del proyecto (npm install / composer install). */
export function bulkCommands(rs: Requirement[]): { command: string; cwd: string }[] {
  const out: { command: string; cwd: string }[] = [];
  const seen = new Set<string>();
  for (const r of rs) {
    if (r.installed) continue;
    if (r.npm && !seen.has("n" + r.npm.dir)) { seen.add("n" + r.npm.dir); out.push({ command: "npm install", cwd: r.npm.dir }); }
    if (r.id === "composer-deps") out.push({ command: "composer install", cwd: dirname(dirname(r.check.path ?? "")) });
    if (r.id === "py-deps") out.push({ command: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", cwd: dirname(r.check.path ?? "") });
  }
  return out;
}

/** Ejecuta en la terminal integrada (visible): sudo pide la contraseña ahí, no en nuestra interfaz. */
export function runInTerminal(command: string, cwd?: string): void {
  const term = vscode.window.terminals.find((t) => t.name === "Code Learning" && t.exitStatus === undefined) ?? vscode.window.createTerminal({ name: "Code Learning" });
  term.show();
  term.sendText(cwd ? `cd ${q(cwd)} && ${command}` : command, true);
}
