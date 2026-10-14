import * as vscode from "vscode";
import type { Analysis } from "./analyzer";
import type { Requirement } from "./requirements";

export const MARKER = "<!-- code-learning:generated -->";
export const LEARNING_FILES = ["temario.md", "plan-de-estudios.md"] as const;

const T = {
  es: { lesson: "Lección", temario: "Temario", project: "Proyecto", type: "Tipo", about: "De qué trata", level: "Nivel", topics: "Temas", reqs: "Requisitos del entorno", ok: "instalado", missing: "falta instalar", plan: "Plan de estudios", start: "Empieza por", progress: "Marca cada paso al terminarlo.", files: "Archivos", source: "Proyecto analizado", levels: { beginner: "Principiante", intermediate: "Intermedio", advanced: "Avanzado" } },
  en: { lesson: "Lesson", temario: "Syllabus", project: "Project", type: "Type", about: "What it is about", level: "Level", topics: "Topics", reqs: "Environment requirements", ok: "installed", missing: "needs installing", plan: "Study plan", start: "Start with", progress: "Tick each step when you finish it.", files: "Files", source: "Analyzed project", levels: { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" } },
  pt: { lesson: "Lição", temario: "Temário", project: "Projeto", type: "Tipo", about: "Do que se trata", level: "Nível", topics: "Temas", reqs: "Requisitos do ambiente", ok: "instalado", missing: "falta instalar", plan: "Plano de estudos", start: "Comece por", progress: "Marque cada passo ao terminar.", files: "Arquivos", source: "Projeto analisado", levels: { beginner: "Iniciante", intermediate: "Intermediário", advanced: "Avançado" } },
  fr: { lesson: "Leçon", temario: "Programme", project: "Projet", type: "Type", about: "De quoi il s'agit", level: "Niveau", topics: "Thèmes", reqs: "Prérequis de l'environnement", ok: "installé", missing: "à installer", plan: "Plan d'étude", start: "Commencez par", progress: "Cochez chaque étape une fois terminée.", files: "Fichiers", source: "Projet analysé", levels: { beginner: "Débutant", intermediate: "Intermédiaire", advanced: "Avancé" } },
} as const;

function profileLines(p: NonNullable<Analysis["profile"]>): string[] {
  const rows: [string, string | undefined][] = [
    ["Lenguajes", p.languages.join(", ")], ["Framework", p.framework], ["Arquitectura", p.architecture], ["Punto de entrada", p.entry && `\`${p.entry}\``],
    ["Servicios", p.services.join(", ")], ["Variables de entorno", p.env.length ? p.env.map((e) => `\`${e}\``).join(", ") : ""],
  ];
  return [...rows.filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`), ...p.warnings.map((w) => `- ⚠️ ${w}`)];
}

export function renderTemario(a: Analysis, reqs: Requirement[]): string {
  const t = T[a.language as keyof typeof T] ?? T.es;
  const lines = [
    MARKER,
    `# ${t.temario} — ${a.name}`,
    "",
    `- **${t.type}:** ${a.type}`,
    `- **${t.level}:** ${t.levels[a.level as keyof typeof t.levels] ?? a.level}`,
    `- **${t.source}:** \`${a.root}\``,
    ...(a.profile ? profileLines(a.profile) : []),
    "",
    `## ${t.about}`,
    "",
    a.summary,
    "",
    `## ${t.topics}`,
    "",
    ...a.topics.map((x) => `- **${x.name}**${x.description ? ` — ${x.description}` : ""}`),
  ];
  if (reqs.length) {
    lines.push("", `## ${t.reqs}`, "", ...reqs.map((r) => `- ${r.installed ? "✅" : "⬜"} **${r.name}** — ${r.installed ? `${t.ok}${r.version ? ` (${r.version})` : ""}` : t.missing}`));
  }
  return lines.join("\n") + "\n";
}

export function renderPlan(a: Analysis, done: ReadonlySet<number> = new Set()): string {
  const t = T[a.language as keyof typeof T] ?? T.es;
  const lines = [MARKER, `# ${t.plan} — ${a.name}`, "", t.progress, ""];
  if (a.startHere) lines.push(`> **${t.start}:** ${a.startHere}`, "");
  if (a.curriculum?.length) {
    // Un apartado por módulo y una casilla por lección: el plan es el temario completo.
    let module = "";
    a.curriculum.forEach((l, i) => {
      if (l.module !== module) {
        module = l.module;
        lines.push(`## ${module}`, "");
      }
      lines.push(`- [${done.has(i) ? "x" : " "}] **${t.lesson} ${i + 1}:** ${l.title} — ${l.parts.map((p) => `\`${p.file}\`${p.total > p.to - p.from + 1 ? ` (${p.from}-${p.to})` : ""}`).join(", ")}`);
    });
    return lines.join("\n") + "\n";
  }
  a.plan.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title}`, "", `- [${done.has(i) ? "x" : " "}] ${p.description || p.title}`);
    if (p.files.length) lines.push(`- ${t.files}: ${p.files.map((f) => `\`${f}\``).join(", ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Crea learning/ en la raíz del proyecto abierto. Nunca pisa un archivo que el usuario haya escrito:
 * solo reemplaza los que llevan la marca de generados por Code Learning.
 */
export async function writeLearning(a: Analysis, reqs: Requirement[]): Promise<{ dir?: string; written: string[]; skipped: string[] }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { written: [], skipped: [] };
  const dir = vscode.Uri.joinPath(folder.uri, "learning");
  await vscode.workspace.fs.createDirectory(dir);
  const files: [string, string][] = [
    ["temario.md", renderTemario(a, reqs)],
    ["plan-de-estudios.md", renderPlan(a)],
  ];
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, content] of files) {
    const uri = vscode.Uri.joinPath(dir, name);
    const existing = await vscode.workspace.fs.readFile(uri).then((b) => new TextDecoder().decode(b), () => undefined);
    if (existing !== undefined && !existing.startsWith(MARKER)) {
      skipped.push(name);
      continue;
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    written.push(name);
  }
  return { dir: dir.fsPath, written, skipped };
}
