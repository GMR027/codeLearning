import { fmtMinutes } from "./stats";

export const REPORT_MARKER = "<!-- code-learning:generated -->";

export interface ReportLesson {
  title: string;
  module?: string;
  status: "pending" | "done" | "skipped";
  doneAt?: number;
  /** Minutos reales que llevó (si se midieron). */
  minutes?: number;
  /** Resultado del hito de fin de módulo, si esta lección lo tiene. */
  probe?: "ok" | "fail" | "unsure";
}

export interface ReportInput {
  name: string;
  root: string;
  level?: string;
  lessons: ReportLesson[];
  topics: { name: string; done: number; total: number; pct: number }[];
  overall: number;
  streak: { current: number; best: number };
  activeDays: number;
  spentMin: number;
  remainingMin?: number;
  /** Último repaso de lecciones anteriores. */
  regress?: { checked: number; broken: { n: number; title: string }[] };
  now: number;
}

const bar = (pct: number, width = 20) => "█".repeat(Math.round((pct / 100) * width)) + "░".repeat(width - Math.round((pct / 100) * width));
const date = (t: number) => new Date(t).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
const MARK = { done: "✅", skipped: "⏭️", pending: "⬜" } as const;
const PROBE = { ok: "✅ hito superado", fail: "❌ hito pendiente", unsure: "➖ hito sin probar" } as const;

/** Resumen del avance en Markdown, listo para guardar, compartir o presentar. */
export function renderReport(i: ReportInput): string {
  const done = i.lessons.filter((l) => l.status === "done").length;
  const skipped = i.lessons.filter((l) => l.status === "skipped").length;
  const out = [
    REPORT_MARKER,
    `# Avance — ${i.name}`,
    "",
    `_Generado el ${date(i.now)} con Code Learning._`,
    "",
    `**${i.overall} % completado** · ${done} de ${i.lessons.length} lecciones${skipped ? ` (${skipped} saltadas)` : ""}`,
    "",
    `\`${bar(i.overall, 30)}\``,
    "",
    "## Resumen",
    "",
    "| | |",
    "|---|---|",
    `| Proyecto | \`${i.root}\` |`,
    ...(i.level ? [`| Nivel | ${({ beginner: "Principiante", intermediate: "Intermedio", advanced: "Avanzado" } as Record<string, string>)[i.level] ?? i.level} |`] : []),
    `| Tiempo activo | ${i.spentMin ? fmtMinutes(i.spentMin) : "sin datos"} |`,
    ...(i.remainingMin !== undefined && done < i.lessons.length ? [`| Tiempo restante estimado | ${fmtMinutes(i.remainingMin)} |`] : []),
    `| Días de estudio | ${i.activeDays} |`,
    `| Racha actual / mejor | ${i.streak.current} / ${i.streak.best} días |`,
    "",
  ];
  if (i.topics.length) {
    out.push("## Avance por tema", "", ...i.topics.map((t) => `- **${t.name}** — \`${bar(t.pct, 16)}\` ${t.pct} % (${t.done}/${t.total})`), "");
  }
  const hitos = i.lessons.filter((l) => l.probe);
  if (hitos.length) {
    out.push("## Hitos de módulo", "", ...hitos.map((l) => `- ${l.module ?? l.title}: ${PROBE[l.probe!]}`), "");
  }
  if (i.regress && i.regress.checked) {
    out.push("## Repaso de lecciones anteriores", "");
    out.push(i.regress.broken.length ? `De ${i.regress.checked} lecciones repasadas, ${i.regress.broken.length} dejaron de cumplirse:` : `Las ${i.regress.checked} lecciones repasadas siguen en pie.`, "");
    out.push(...i.regress.broken.map((b) => `- ❌ ${b.n}. ${b.title}`), "");
  }
  out.push("## Lecciones", "");
  let module = "";
  i.lessons.forEach((l, n) => {
    if (l.module && l.module !== module) {
      module = l.module;
      out.push("", `### ${module}`, "");
    }
    const extra = [l.doneAt && l.status === "done" ? date(l.doneAt) : "", l.minutes ? fmtMinutes(l.minutes) : ""].filter(Boolean).join(" · ");
    out.push(`- ${MARK[l.status]} ${n + 1}. ${l.title}${extra ? ` — ${extra}` : ""}`);
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
