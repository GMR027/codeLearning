import * as vscode from "vscode";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { buildChart, walk, type Analysis } from "./analyzer";
import { buildCurriculum } from "./curriculum";
import { askJson, askText, resolveAi, resolveNotesAi, type AiTarget } from "./models";
import { classicTips } from "./classics";
import { runProbe } from "./milestones";
import { renderReport, REPORT_MARKER } from "./report";
import { estimateMinutes, paceFactor, realMinutes, streak as streakOf, touchDay } from "./stats";
import { renderPlan, MARKER } from "./learning";
import { runInTerminal } from "./requirements";
import {
  checkLesson, generateLesson, progressFits, recheckLesson, lessonFileName, lessonHelp, lessonHint, lessonMarkdown, safeRel,
  type LessonState, type Progress, type RegressItem,
} from "./lessons";

const NEED_FAILS_FOR_SOLUTION = 3;

/** Número de lecciones: el temario completo (o, en análisis antiguos, los pasos del plan). */
const count = (a: Analysis): number => a.curriculum?.length ?? a.plan.length;
/** Avance por tema a partir de lo guardado en progreso.json, sin el proyecto analizado (el tema sale de los archivos de cada lección). */
function savedChart(p: Progress): ReturnType<typeof buildChart> {
  const topics = ["Ajustes", "Datos", "Backend", "Frontend", "Pruebas", "Servidor y despliegue"].map((name) => ({ name, description: "" }));
  const total = Math.max(0, ...Object.keys(p.lessons).map((k) => Number(k) + 1));
  const plan = Array.from({ length: total }, (_, i) => {
    const c = p.lessons[i]?.content;
    return { title: c?.title ?? "", description: c?.objective ?? "", files: c?.blocks.map((b) => b.file) ?? [] };
  });
  const fake = { topics, plan } as unknown as Analysis;
  return buildChart(fake, Array.from({ length: total }, (_, i) => p.lessons[i]?.status ?? "pending"));
}

const titleOf = (a: Analysis, i: number) => a.curriculum?.[i]?.title ?? a.plan[i]?.title ?? `Lección ${i + 1}`;

interface Deps {
  saveAnalysis: (a: Analysis) => Promise<void>;
  getAnalysis: () => Analysis | undefined;
  post: (payload: object) => void;
  requirementsOk: () => boolean;
}

/** Pestaña «Learning»: genera cada lección al abrirla, comprueba el código del alumno y guarda el avance en learning/. */
export class LessonController {
  private progress?: Progress;
  private busy = "";
  private abort?: AbortController;

  constructor(private deps: Deps) {}

  private workspace(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
  private learningDir(): string | undefined {
    const w = this.workspace();
    return w && join(w, "learning");
  }
  private progressFile(): string | undefined {
    const d = this.learningDir();
    return d && join(d, "progreso.json");
  }

  // ---- Persistencia ------------------------------------------------------------

  private async load(): Promise<Progress | undefined> {
    const f = this.progressFile();
    if (!f) return undefined;
    try {
      const p = JSON.parse(await readFile(f, "utf8")) as Progress;
      return p.v === 1 ? p : undefined;
    } catch {
      return undefined;
    }
  }

  private async save(): Promise<void> {
    const f = this.progressFile();
    if (!f || !this.progress) return;
    this.progress.updated = Date.now();
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(this.progress, null, 1));
  }

  private lesson(i: number): LessonState {
    const p = this.progress!;
    return (p.lessons[i] ??= { status: "pending", attempts: 0, hints: [], chat: [], solutionShown: false });
  }

  private doneSet(): Set<number> {
    return new Set(Object.entries(this.progress?.lessons ?? {}).filter(([, l]) => l.status === "done").map(([i]) => Number(i)));
  }

  /** El avance guardado pertenece al proyecto analizado. */
  private matches(a: Analysis | undefined): boolean {
    const p = this.progress;
    if (!a || !p) return false;
    // Mismo proyecto: misma carpeta o mismo id (el id sobrevive a mover la carpeta).
    const same = p.root === a.root || (!!p.id && p.id === a.id);
    if (p.id && p.id !== a.id && p.root !== a.root) return false;
    const started = Object.values(p.lessons).some((l) => l.content);
    // Sin lecciones abiertas aún no hay nada que descuadrar. Con lecciones, deben seguir siendo las mismas del temario actual.
    if (!started) return same;
    return progressFits(p, a);
  }

  /** Si el avance se reconoció en otra carpeta, pasa a apuntar a la actual. */
  private async adopt(a: Analysis): Promise<void> {
    const p = this.progress;
    if (!p || !this.matches(a)) return;
    let changed = false;
    if (p.root !== a.root) {
      p.root = a.root;
      changed = true;
    }
    if (a.id && p.id !== a.id) {
      p.id = a.id;
      changed = true;
    }
    const ws = this.workspace();
    if (ws && (!existsSync(p.base) || p.base === a.root)) {
      p.base = a.root === ws ? join(ws, "practica") : ws;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Hay avance guardado pero sin el proyecto analizado: se pueden repasar las lecciones hechas, nada más. */
  private reviewing(): boolean {
    return !!this.progress && !this.matches(this.deps.getAnalysis());
  }

  /** La siguiente lección sin terminar o saltada: hasta ahí se puede navegar. */
  private unlocked(total: number): number {
    for (let i = 0; i < total; i++) if (!["done", "skipped"].includes(this.progress?.lessons[i]?.status ?? "")) return i;
    return total - 1;
  }

  /** Avance por tema (el mismo que dibuja el gráfico), para compartirlo con Halo IA. */
  async chart(): Promise<ReturnType<typeof buildChart> | undefined> {
    const a = this.deps.getAnalysis();
    if (!a) return undefined;
    if (!this.progress) this.progress = await this.load();
    const mine = this.matches(a) ? this.progress : undefined;
    return buildChart(a, Array.from({ length: count(a) }, (_, i) => mine?.lessons[i]?.status ?? "pending"));
  }

  // ---- Tiempo, racha e hitos ----------------------------------------------------------

  /** Minutos estimados de la lección i, según sus líneas y el nivel del alumno. */
  private estimate(a: Analysis, i: number): number {
    const parts = a.curriculum?.[i]?.parts ?? [];
    const lines = parts.reduce((n, x) => n + (x.to - x.from + 1), 0) || 30;
    return estimateMinutes(lines, a.level, parts.length > 0 && parts.every((x) => x.copy));
  }

  /** Tiempo de esta lección, de lo que falta y de lo ya invertido; se ajusta al ritmo real del alumno. */
  private timing(a: Analysis, p: Progress, cur: number): { thisMin: number; remainingMin: number; spentMin: number; paced: boolean } {
    const samples: { est: number; actual: number }[] = [];
    let spent = 0;
    for (const [k, l] of Object.entries(p.lessons)) {
      const actual = realMinutes(l.startedAt, l.doneAt);
      if (l.status === "done" && actual) {
        samples.push({ est: this.estimate(a, Number(k)), actual });
        spent += actual;
      }
    }
    const f = paceFactor(samples);
    let remaining = 0;
    for (let i = 0; i < count(a); i++) if (!["done", "skipped"].includes(p.lessons[i]?.status ?? "")) remaining += this.estimate(a, i) * f;
    return { thisMin: this.estimate(a, cur) * f, remainingMin: remaining, spentMin: spent, paced: samples.length >= 3 };
  }

  /** ¿La lección i cierra un módulo? Ahí se ofrece probar el proyecto. */
  private isModuleEnd(a: Analysis, i: number): boolean {
    const c = a.curriculum;
    return !!c?.[i] && c[i + 1]?.module !== c[i].module;
  }

  /** Vuelve a comprobar, sin IA, todas las lecciones terminadas contra los archivos de ahora y guarda cuáles se rompieron. */
  private async runRegress(): Promise<void> {
    const p = this.progress;
    if (!p) return;
    const broken: RegressItem[] = [];
    let checked = 0;
    for (const [k, l] of Object.entries(p.lessons)) {
      if (l.status !== "done" || !l.content) continue;
      checked++;
      const issues = await recheckLesson(p.base, l.content).catch(() => []);
      if (issues.length) broken.push({ n: Number(k), title: l.content.title, issues });
    }
    p.regress = { at: Date.now(), checked, broken: broken.sort((x, y) => x.n - y.n) };
    await this.save();
  }

  /** Repasa las lecciones anteriores (botón del hito). */
  async regress(): Promise<void> {
    if (this.reviewing()) return;
    await this.withBusy("Repasando las lecciones anteriores…", () => this.runRegress());
  }

  /** Prueba el proyecto del alumno contra el original (hito de fin de módulo). */
  async probe(): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    if (!a || !p || !this.isModuleEnd(a, p.current)) return;
    const l = this.lesson(p.current);
    await this.withBusy("Probando el proyecto…", async () => {
      l.probe = await runProbe({
        a,
        student: p.base,
        fileLesson: (file) => a.curriculum?.findIndex((s) => s.parts.some((x) => x.file === file)),
      });
      await this.save();
    });
  }

  /** Escribe learning/avance.md con el resumen del avance y lo abre. */
  async exportReport(): Promise<void> {
    if (!this.progress) this.progress = await this.load();
    const p = this.progress;
    const dir = this.learningDir();
    if (!p || !dir) {
      void vscode.window.showInformationMessage("Code Learning: no hay avance que exportar todavía (abre la carpeta de trabajo y empieza una lección).");
      return;
    }
    const a = this.deps.getAnalysis();
    const live = !!a && this.matches(a);
    const total = live ? count(a!) : Math.max(0, ...Object.keys(p.lessons).map((k) => Number(k) + 1));
    const statuses = Array.from({ length: total }, (_, i) => p.lessons[i]?.status ?? "pending");
    const chart = live ? buildChart(a!, statuses) : savedChart(p);
    const t = live ? this.timing(a!, p, Math.min(p.current, total - 1)) : undefined;
    const st = streakOf(p.days);
    const lessons = Array.from({ length: total }, (_, i) => {
      const l = p.lessons[i];
      return {
        title: l?.content?.title ?? (live ? titleOf(a!, i) : `Lección ${i + 1}`),
        module: live ? a!.curriculum?.[i]?.module : undefined,
        status: l?.status ?? "pending",
        doneAt: l?.doneAt,
        minutes: realMinutes(l?.startedAt, l?.doneAt),
        probe: l?.probe?.state,
      };
    });
    const spent = lessons.reduce((n, x) => n + (x.minutes ?? 0), 0);
    const md = renderReport({
      name: live ? a!.name : (p.id ?? p.root.split("/").pop() ?? "proyecto"),
      root: p.root,
      level: live ? a!.level : undefined,
      lessons,
      topics: chart.topics,
      overall: chart.overall,
      streak: st,
      activeDays: p.days?.length ?? 0,
      spentMin: t?.spentMin ?? spent,
      remainingMin: t?.remainingMin,
      regress: p.regress && { checked: p.regress.checked, broken: p.regress.broken.map((b) => ({ n: b.n + 1, title: b.title })) },
      now: Date.now(),
    });
    await mkdir(dir, { recursive: true });
    let file = join(dir, "avance.md");
    const existing = await readFile(file, "utf8").catch(() => undefined);
    // Nunca se pisa un archivo del usuario: solo los que lleva la marca de Code Learning.
    if (existing !== undefined && !existing.startsWith(REPORT_MARKER)) file = join(dir, `avance-${new Date().toISOString().slice(0, 10)}.md`);
    await writeFile(file, md);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // ---- Estado hacia la vista -----------------------------------------------------

  async publish(): Promise<void> {
    const a = this.deps.getAnalysis();
    if (!this.progress) this.progress = await this.load();
    if (a) await this.adopt(a);
    // El gráfico de Ajustes: avance por tema (0 % si aún no se empezó).
    const mine = this.matches(a) ? this.progress : undefined;
    if (this.reviewing()) this.deps.post({ type: "chart", name: this.progress!.root.split("/").pop() ?? "", ...savedChart(this.progress!) });
    else this.deps.post({ type: "chart", name: a?.name ?? "", ...(a ? buildChart(a, Array.from({ length: count(a) }, (_, i) => mine?.lessons[i]?.status ?? "pending")) : { topics: [], overall: 0 }) });
    if (this.reviewing()) {
      // Sin el proyecto analizado se enseña lo guardado en learning/progreso.json (solo lectura).
      const p = this.progress!;
      const total = Math.max(0, ...Object.keys(p.lessons).map((k) => Number(k) + 1));
      const cur = Math.min(Math.max(p.current, 0), total - 1);
      this.deps.post({
        type: "lesson", started: true, review: true, foreign: p.root, total, current: cur, unlocked: total - 1,
        titles: Array.from({ length: total }, (_, i) => p.lessons[i]?.content?.title ?? `Lección ${i + 1}`),
        status: Array.from({ length: total }, (_, i) => p.lessons[i]?.status ?? "pending"),
        base: p.base.replace(this.workspace() ?? "", "").replace(/^\//, "") || ".",
        busy: "", canSolution: false, lesson: p.lessons[cur], streak: streakOf(p.days), broken: (p.regress?.broken ?? []).map((b) => b.n),
      });
      return;
    }
    if (!a || !this.progress) {
      this.deps.post({ type: "lesson", started: false, total: a?.plan.length ?? 0 });
      return;
    }
    const p = this.progress;
    const total = count(a);
    const cur = Math.min(p.current, total - 1);
    const l = p.lessons[cur];
    this.deps.post({
      type: "lesson",
      started: true,
      total,
      current: cur,
      unlocked: this.unlocked(total),
      titles: Array.from({ length: total }, (_, i) => p.lessons[i]?.content?.title ?? titleOf(a, i)),
      status: Array.from({ length: total }, (_, i) => p.lessons[i]?.status ?? "pending"),
      base: p.base.replace(this.workspace() ?? "", "").replace(/^\//, "") || ".",
      busy: this.busy,
      canSolution: !!l && l.attempts >= NEED_FAILS_FOR_SOLUTION,
      lesson: l ? { ...l, content: l.content } : undefined,
      regress: p.regress,
      broken: (p.regress?.broken ?? []).map((b) => b.n),
      time: this.timing(a, p, cur),
      streak: streakOf(p.days),
      milestone: this.isModuleEnd(a, cur) ? a.curriculum![cur].module : undefined,
    });
  }

  private async withBusy<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = what;
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), 300_000);
    await this.publish();
    try {
      return await fn(this.abort.signal);
    } catch (err) {
      this.deps.post({ type: "lessonError", text: (err as Error).message });
      return undefined;
    } finally {
      clearTimeout(timer);
      this.busy = "";
      await this.publish();
    }
  }

  private async ai(): Promise<{ target: AiTarget; json: ReturnType<LessonController["asker"]>; text: ReturnType<LessonController["asker"]>; notes: ReturnType<LessonController["asker"]> }> {
    const target = await resolveAi();
    // Las notas de las lecciones pueden usar un modelo mayor que el del análisis.
    return { target, json: this.asker(target, askJson), text: this.asker(target, askText), notes: this.asker(await resolveNotesAi(target), askJson) };
  }
  private asker(t: AiTarget, fn: typeof askJson) {
    return (system: string, prompt: string, signal?: AbortSignal) => fn(t, system, prompt, signal);
  }

  // ---- Acciones --------------------------------------------------------------------

  async start(): Promise<boolean> {
    const a = this.deps.getAnalysis();
    const ws = this.workspace();
    if (!a) { void vscode.window.showInformationMessage("Code Learning: analiza primero un proyecto."); return false; }
    if (!ws) { void vscode.window.showWarningMessage("Code Learning: abre una carpeta de trabajo; ahí escribirás el código."); return false; }
    if (!this.deps.requirementsOk()) {
      void vscode.window.showWarningMessage("Code Learning: instala primero los requisitos del proyecto (pestaña Start).");
      return false;
    }
    // Un análisis hecho con una versión anterior no trae el temario completo: se genera ahora.
    if (!a.curriculum) {
      const cur = buildCurriculum(await walk(a.root), a.topics);
      a.curriculum = cur.lessons;
      a.virtual = cur.virtual;
      await this.deps.saveAnalysis(a);
    }
    this.progress = await this.load();
    if (this.progress && !this.matches(a)) {
      const pick = await vscode.window.showWarningMessage(
        `Ya hay un avance guardado de otro proyecto (${this.progress.root}). ¿Empezar de nuevo con este? Se reemplazará learning/progreso.json.`,
        { modal: true }, "Empezar de nuevo",
      );
      if (pick !== "Empezar de nuevo") return false;
      this.progress = undefined;
    }
    await this.adopt(a);
    // Si el proyecto analizado es la propia carpeta abierta, el alumno escribe en practica/ para no pisar el original.
    const base = a.root === ws ? join(ws, "practica") : ws;
    this.progress ??= { v: 1, id: a.id, root: a.root, base, current: 0, lessons: {}, updated: Date.now() };
    await this.save();
    await this.open(this.progress.current);
    return true;
  }

  async open(n: number): Promise<void> {
    if (this.reviewing()) {
      if (n >= 0 && this.progress!.lessons[n]) this.progress!.current = n;
      return this.publish();
    }
    const a = this.deps.getAnalysis();
    if (!a || !this.progress || n < 0 || n >= count(a)) return;
    if (n > this.unlocked(count(a))) return;
    this.progress.current = n;
    const l = this.lesson(n);
    if (l.status !== "done") l.startedAt ??= Date.now();
    this.progress.days = touchDay(this.progress.days);
    await this.save();
    if (l.content) return this.publish();
    await this.withBusy("Generando la lección…", async (signal) => {
      const ai = await this.ai();
      const prevTitles = Array.from({ length: n }, (_, i) => this.progress!.lessons[i]?.content?.title ?? titleOf(a, i));
      l.content = await generateLesson({ analysis: a, index: n, prevTitles, ask: ai.notes, signal });
      l.mdFile = lessonFileName(n, l.content.title);
      await this.writeMd(n);
      await this.save();
    });
  }

  private async writeMd(n: number): Promise<void> {
    const dir = this.learningDir();
    const l = this.lesson(n);
    if (!dir || !l.content || !l.mdFile) return;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, l.mdFile), lessonMarkdown(n, l.content, l.status));
  }

  /** Marca el avance en plan-de-estudios.md si lo generó Code Learning. */
  private async tickPlan(): Promise<void> {
    const a = this.deps.getAnalysis();
    const dir = this.learningDir();
    if (!a || !dir) return;
    const f = join(dir, "plan-de-estudios.md");
    const cur = await readFile(f, "utf8").catch(() => undefined);
    if (cur?.startsWith(MARKER)) await writeFile(f, renderPlan(a, this.doneSet()));
  }

  async check(): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    if (!a || !p) return;
    const n = p.current;
    const l = this.lesson(n);
    if (!l.content) return;
    await this.withBusy("Comprobando tu código…", async (signal) => {
      const ai = await this.ai();
      const result = await checkLesson(p.base, l.content!, a, ai.json, signal);
      l.last = result;
      if (result.state !== "ok") {
        l.attempts++;
        result.tips = await classicTips({ base: p.base, blocks: l.content!.blocks, issues: result.issues }).catch(() => []);
      }
      if (result.state === "ok") {
        l.status = "done";
        l.doneAt = Date.now();
        p.days = touchDay(p.days);
        await this.writeMd(n);
        await this.tickPlan();
        // Al cerrar un módulo se repasa todo lo anterior: un cambio de ahora puede haber roto una lección vieja.
        if (this.isModuleEnd(a, n)) await this.runRegress();
      }
      await this.save();
    });
    // Lección terminada: pasa sola a la siguiente tras un instante para que se vea el verde.
    if (this.progress?.lessons[n]?.status === "done" && n + 1 < count(a)) {
      setTimeout(() => void this.open(n + 1), 1800);
    }
  }

  /** El alumno da la lección por terminada sin pasar la comprobación. */
  async complete(): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    if (!a || !p) return;
    const n = p.current;
    const l = this.lesson(n);
    if (!l.content || this.busy) return;
    l.status = "done";
    l.doneAt = Date.now();
    p.days = touchDay(p.days);
    await this.writeMd(n);
    await this.tickPlan();
    if (this.isModuleEnd(a, n)) await this.runRegress();
    await this.save();
    await this.publish();
    if (n + 1 < count(a)) setTimeout(() => void this.open(n + 1), 1200);
  }

  async hint(): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    const l = p && this.lesson(p.current);
    if (!a || !p || !l?.content) return;
    await this.withBusy("Pensando una pista…", async (signal) => {
      const level = Math.min(l.hints.length + 1, 3);
      const text = await lessonHint(p.base, l.content!, level, a, (await this.ai()).text, signal);
      if (l.hints.length >= 3) l.hints[2] = text;
      else l.hints.push(text);
      await this.save();
    });
  }

  async help(question: string): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    const l = p && this.lesson(p.current);
    const q = question.trim().slice(0, 1000);
    if (!a || !p || !l?.content || !q) return;
    await this.withBusy("El profesor está pensando…", async (signal) => {
      const answer = await lessonHelp(p.base, l.content!, l.chat, q, a, (await this.ai()).text, signal);
      l.chat.push({ role: "user", text: q }, { role: "assistant", text: answer });
      await this.save();
    });
  }

  async solution(): Promise<void> {
    if (this.reviewing()) return;
    const p = this.progress;
    const l = p && this.lesson(p.current);
    if (!l?.content) return;
    if (l.attempts < NEED_FAILS_FOR_SOLUTION) {
      return void vscode.window.showInformationMessage(`La solución se desbloquea tras ${NEED_FAILS_FOR_SOLUTION} intentos fallidos. Prueba con una pista.`);
    }
    l.solutionShown = true;
    await this.save();
    await this.publish();
  }

  async skip(): Promise<void> {
    if (this.reviewing()) return;
    const a = this.deps.getAnalysis();
    const p = this.progress;
    const l = p && this.lesson(p.current);
    if (!a || !p || !l?.solutionShown) return;
    const pick = await vscode.window.showWarningMessage("¿Saltar esta lección sin completarla? Podrás volver a ella.", { modal: true }, "Saltar");
    if (pick !== "Saltar") return;
    l.status = "skipped";
    await this.save();
    if (p.current + 1 < count(a)) await this.open(p.current + 1);
    else await this.publish();
  }

  /** Ejecuta en la terminal uno de los comandos de la lección (solo los que la lección muestra) desde la carpeta del alumno. */
  runCommand(index: number): void {
    const p = this.progress;
    const cmd = p && this.lesson(p.current).content?.commands?.[index];
    if (p && cmd) runInTerminal(cmd.cmd, p.base);
  }

  /** Crea (vacío) y abre uno de los archivos de la lección en la carpeta del alumno. */
  async openFile(file: string): Promise<void> {
    const p = this.progress;
    const l = p && this.lesson(p.current);
    const rel = safeRel(file);
    if (!p || !rel || !l?.content?.blocks.some((b) => b.file === rel)) return;
    const abs = join(p.base, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "", { flag: "a" });
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { viewColumn: vscode.ViewColumn.One });
  }
}
