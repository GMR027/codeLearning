import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { findGhostExtension, ghostStatus } from "./ghostBridge";
import { explainOffline } from "./ai";
import { bulkCommands, checkAll, detectRequirements, installOptions, runInTerminal, type Requirement } from "./requirements";
import { LessonController } from "./lessonController";
import { LEARNING_FILES, writeLearning } from "./learning";
import { askChat, askJson, listOllama, opencodeBin, opencodeModels, pullModel, resolveAi, type OllamaModel } from "./models";
import { analyzeProject, type Analysis } from "./analyzer";
import { homedir, totalmem } from "os";
import { isAbsolute, resolve } from "path";
import { stat } from "fs/promises";

const CACHE_KEY = "codelearning.analysis";
const GHOST_KEY = "codelearning.ghostConnected";

/** Panel derecho estilo chat IA: WebviewView (barra lateral) + WebviewPanel en ViewColumn.Beside. */
export class ChatPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private lastCode = "";
  private analyzing = false;
  private pulling = false;
  private reqs: Requirement[] = [];
  private lessons = new LessonController({
    saveAnalysis: (a) => Promise.resolve(this.ctx.globalState.update(CACHE_KEY, a)),
    getAnalysis: () => this.getAnalysis(),
    post: (o) => this.postRaw(o),
    requirementsOk: () => this.reqs.every((r) => r.installed),
  });
  private poll?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private lastShared = "";
  private ocModels?: string[];

  constructor(private ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push({ dispose: () => this.poll && clearInterval(this.poll) });
  }

  // ---- Icono libro: al hacer clic se abre el chat a la DERECHA, sin panel izquierdo ----
  // VS Code obliga a tener una vista para mostrar el icono; esa vista queda vacía
  // y se cierra sola: solo sirve de disparador del panel derecho.
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.launcherHtml(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    // Clic en el libro -> derecha + cerrar la barra lateral (no queda panel izquierdo).
    view.onDidChangeVisibility(() => {
      if (view.visible) this.openRightAndCloseLeft();
    });
  }

  /** Abrir en el lado derecho como un chat de IA (editor Beside, no como GhostCode). */
  openOnRight(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "codelearning.chatPanel",
      "Code Learning",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "codelearning.svg");
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => (this.panel = undefined));
    void this.refresh();
  }

  focusView(): void {
    // No enfocar la vista izquierda: ir directo a la derecha.
    this.openRightAndCloseLeft();
  }

  exportProgress(): Promise<void> {
    return this.lessons.exportReport();
  }

  async askSelection(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const code = ed?.document.getText(ed.selection) || "";
    if (!code) {
      void vscode.window.showInformationMessage("Selecciona código y pulsa “Explicar selección”.");
      return;
    }
    this.lastCode = code;
    this.openOnRight();
    await this.explain(code, ed?.document.languageId ?? "plaintext");
  }

  /** Abre a la derecha y cierra la barra lateral para que no quede panel izquierdo. */
  private openRightAndCloseLeft(): void {
    this.openOnRight();
    // Cierra la sidebar (izquierda o secundaria) sin tocar el panel del editor.
    void vscode.commands.executeCommand("workbench.action.closeSidebar").then(undefined, () => undefined);
    void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => undefined);
  }

  private async onMessage(m: { type: string; text?: string; key?: string; value?: string; id?: string; opt?: number }): Promise<void> {
    if (m.type === "setConfig") {
      // Lista blanca: la webview solo puede tocar estos ajustes.
      const allowed: Record<string, (v: string) => boolean> = {
        backend: (v) => ["auto", "local", "opencode"].includes(v),
        "opencode.model": (v) => v.length < 120 && !/\s/.test(v),
        "local.url": (v) => /^https?:\/\/\S+$/.test(v),
        "local.model": (v) => v.length < 100,
        notesModel: (v) => v.length < 100 && !/\s/.test(v),
        level: (v) => ["beginner", "intermediate", "advanced"].includes(v),
        language: (v) => ["es", "en", "pt", "fr"].includes(v),
      };
      if (m.key && allowed[m.key]?.(m.value ?? "")) {
        await vscode.workspace.getConfiguration("codelearning").update(m.key, m.value, vscode.ConfigurationTarget.Global);
      }
      await this.refresh();
      return;
    }
    if (m.type === "ghostToggle") {
      await this.toggleGhost();
      return;
    }
    if (m.type === "start") {
      if (await this.lessons.start()) this.postRaw({ type: "showTab", tab: "learning" });
      return;
    }
    if (m.type === "lessonOpen") return this.lessons.open(Number(m.value));
    if (m.type === "lessonCheck") return this.lessons.check();
    if (m.type === "lessonHint") return this.lessons.hint();
    if (m.type === "lessonHelp") return this.lessons.help(m.value ?? "");
    if (m.type === "lessonSolution") return this.lessons.solution();
    if (m.type === "lessonSkip") return this.lessons.skip();
    if (m.type === "lessonComplete") return this.lessons.complete();
    if (m.type === "lessonProbe") return this.lessons.probe();
    if (m.type === "lessonRegress") return this.lessons.regress();
    if (m.type === "exportProgress") return this.lessons.exportReport();
    if (m.type === "lessonRun") return this.lessons.runCommand(Number(m.value));
    if (m.type === "lessonOpenFile") return this.lessons.openFile(m.value ?? "");
    if (m.type === "install") {
      await this.install(String(m.id ?? ""), Number(m.opt ?? 0));
      return;
    }
    if (m.type === "installAll") {
      const cmds = bulkCommands(this.reqs);
      if (cmds.length) {
        runInTerminal(cmds.map((c) => `(cd '${c.cwd.replace(/'/g, `'\\''`)}' && ${c.command})`).join(" && "));
        this.watchInstall();
      }
      return;
    }
    if (m.type === "recheck") {
      await this.pushRequirements();
      return;
    }
    if (m.type === "openLearning") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const name = LEARNING_FILES.find((f) => f === m.value);
      if (folder && name) await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "learning", name), { viewColumn: vscode.ViewColumn.One });
      return;
    }
    if (m.type === "pull") {
      await this.pull((m.value ?? "").trim());
      return;
    }
    if (m.type === "testAi") {
      await this.testAi();
      return;
    }
    if (m.type === "analyze") {
      await this.analyze(m.value ?? "");
      return;
    }
    if (m.type === "browse") {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: "Code Learning — carpeta del proyecto a analizar" });
      if (picked?.[0]) await this.analyze(picked[0].fsPath);
      return;
    }
    if (m.type === "workspace") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) await this.analyze(folder.uri.fsPath);
      else void vscode.window.showInformationMessage("Code Learning: no hay ninguna carpeta abierta.");
      return;
    }
    if (m.type === "clearCache") {
      await this.ctx.globalState.update(CACHE_KEY, undefined);
      void vscode.window.showInformationMessage("Code Learning: análisis borrado de la caché.");
      await this.refresh();
      return;
    }
    if (m.type === "openRight") {
      this.openRightAndCloseLeft();
      return;
    }
    if (m.type === "explain") {
      const ed = vscode.window.activeTextEditor;
      const code = ed?.document.getText(ed.selection) || this.lastCode || "";
      await this.explain(code, ed?.document.languageId ?? "plaintext");
    } else if (m.type === "installGhostcode") {
      await vscode.commands.executeCommand("codelearning.installGhostcode");
    } else if (m.type === "refresh") {
      await this.refresh();
    }
  }

  private post(text: string, kind: "answer" | "pending" | "state" = "answer"): void {
    const payload = { type: kind, text };
    if (kind === "state") void this.view?.webview.postMessage(payload);
    void this.panel?.webview.postMessage(payload);
  }

  private postRaw(payload: object): void {
    void this.view?.webview.postMessage(payload);
    void this.panel?.webview.postMessage(payload);
    // Conectado con GhostCode: cuando cambia el avance, Halo IA recibe la actualización (agrupada).
    if ((payload as { type?: string }).type === "chart" && this.ghostConnected()) {
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => void this.shareWithHalo(false), 1500);
    }
  }

  // ---- Conexión con GhostCode (Halo IA) ------------------------------------------------

  private ghostConnected(): boolean {
    return this.ctx.globalState.get<boolean>(GHOST_KEY, false);
  }

  private ghostState(extra: { busy?: boolean; text?: string } = {}): void {
    this.postRaw({ type: "ghost", connected: this.ghostConnected(), installed: !!findGhostExtension(), ...extra });
  }

  private async toggleGhost(): Promise<void> {
    if (this.ghostConnected()) {
      await this.ctx.globalState.update(GHOST_KEY, false);
      this.lastShared = "";
      await vscode.commands.executeCommand("ghostcode.halo.disconnectProject").then(undefined, () => undefined);
      this.ghostState({ text: "Desconectado de Halo IA" });
      return;
    }
    if (!findGhostExtension()) {
      this.ghostState({ text: "GhostCode no está instalado" });
      await vscode.commands.executeCommand("codelearning.installGhostcode");
      return;
    }
    if (!this.getAnalysis()) {
      this.ghostState({ text: "Analiza primero un proyecto en Start" });
      return;
    }
    if (await this.shareWithHalo(true)) {
      await this.ctx.globalState.update(GHOST_KEY, true);
      this.ghostState({ text: "Conectado: Halo IA ya conoce el proyecto" });
      // Abre GhostCode en la pestaña de Halo IA para que se vea la conexión.
      await vscode.commands.executeCommand("ghostcode.halo.reveal").then(undefined, () => undefined);
    }
  }

  /** Envía a Halo IA el proyecto analizado y el avance del alumno. */
  private async shareWithHalo(announce: boolean): Promise<boolean> {
    const a = this.getAnalysis();
    if (!a) return false;
    const chart = await this.lessons.chart();
    const payload = {
      from: "codelearning",
      name: a.name,
      type: a.type,
      summary: a.summary,
      topics: a.topics,
      plan: a.plan.map((p) => p.title),
      level: a.level,
      progress: { overall: chart?.overall ?? 0, topics: (chart?.topics ?? []).map((t) => ({ name: t.name, pct: t.pct })) },
    };
    const key = JSON.stringify([a.root, payload]);
    if (!announce && key === this.lastShared) return true;
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes("ghostcode.halo.connectProject")) {
      this.ghostState({ text: "Actualiza GhostCode: esta versión no admite la conexión" });
      return false;
    }
    if (announce) this.ghostState({ busy: true, text: "Conectando con Halo IA…" });
    try {
      const ok = await vscode.commands.executeCommand<boolean>("ghostcode.halo.connectProject", a.root, payload);
      if (ok) this.lastShared = key;
      else if (announce) this.ghostState({ text: "Halo IA no pudo analizar la carpeta del proyecto" });
      return !!ok;
    } catch (err) {
      if (announce) this.ghostState({ text: `No se pudo conectar: ${(err as Error).message}` });
      return false;
    }
  }

  /** Análisis guardado (compartido con Halo IA de GhostCode vía la API que exporta la extensión). */
  getAnalysis(): Analysis | undefined {
    return this.ctx.globalState.get<Analysis>(CACHE_KEY);
  }

  private async analyze(input: string): Promise<void> {
    if (this.analyzing) return;
    const raw = input.trim();
    if (!raw) {
      void vscode.window.showInformationMessage("Code Learning: escribe la ruta de la carpeta del proyecto.");
      return;
    }
    const expanded = raw.replace(/^~(?=$|\/)/, homedir());
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const root = isAbsolute(expanded) ? expanded : resolve(base, expanded);
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
      void vscode.window.showErrorMessage(`Code Learning: no existe la carpeta ${root}`);
      return;
    }

    this.analyzing = true;
    this.postRaw({ type: "analysis", status: "working", text: "leyendo el proyecto…", path: root });
    const cfg = vscode.workspace.getConfiguration("codelearning");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300_000);
    try {
      const ai = await resolveAi();
      const result = await analyzeProject(root, {
        level: cfg.get<string>("level", "beginner"),
        language: cfg.get<string>("language", "es"),
        ask: (system, prompt, signal) => askJson(ai, system, prompt, signal),
        modelLabel: ai.label,
        detect: (files) => detectRequirements(root, files),
        signal: ctrl.signal,
        onProgress: (text) => this.postRaw({ type: "analysis", status: "working", text, path: root }),
      });
      await this.ctx.globalState.update(CACHE_KEY, result);
      this.postRaw({ type: "analysis", status: "ready", data: result, path: root });
      await this.pushRequirements(result);
      if (this.ghostConnected()) void this.shareWithHalo(false);
      // learning/ en la raíz del proyecto abierto (no en la carpeta analizada).
      const learn = await writeLearning(result, this.reqs).catch((e: Error) => ({ error: e.message }) as const);
      this.postRaw({ type: "learning", noFolder: !vscode.workspace.workspaceFolders?.length, ...learn });
    } catch (err) {
      this.postRaw({ type: "analysis", status: "error", text: (err as Error).message, path: root });
    } finally {
      clearTimeout(timer);
      this.analyzing = false;
    }
  }

  async refresh(): Promise<void> {
    const g = await ghostStatus();
    const ai = await resolveAi();
    const cfg = vscode.workspace.getConfiguration("codelearning");
    const backend = cfg.get<string>("backend", "auto");
    const localUrl = cfg.get<string>("local.url", "http://localhost:11434");
    let installed: OllamaModel[] | null = null;
    try {
      installed = await listOllama(localUrl);
    } catch {
      installed = null; // Ollama apagado
    }
    if (backend === "opencode" && !this.ocModels) this.ocModels = await opencodeModels();
    this.post(
      JSON.stringify({
        ghostInstalled: g.installed,
        backendLabel: g.backendLabel ?? "",
        model: ai.label,
        source: ai.source,
        mode: ai.kind,
        installed,
        hw: { ramGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10 },
        opencode: { found: !!opencodeBin(), models: this.ocModels ?? [] },
        settings: {
          backend: backend === "ghostcode" ? "auto" : backend,
          url: localUrl,
          model: cfg.get<string>("local.model", ""),
          notesModel: cfg.get<string>("notesModel", ""),
          ocModel: cfg.get<string>("opencode.model", ""),
          level: cfg.get<string>("level", "beginner"),
          language: cfg.get<string>("language", "es"),
        },
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
        ghost: { connected: this.ghostConnected(), installed: g.installed },
      }),
      "state",
    );
    const cached = this.getAnalysis();
    if (cached && !this.analyzing) {
      this.postRaw({ type: "analysis", status: "ready", data: cached, path: cached.root });
      await this.pushRequirements(cached);
    }
    else if (!this.analyzing) this.postRaw({ type: "analysis", status: "idle" });
    void this.lessons.publish();
  }

  private async explain(code: string, lang: string): Promise<void> {
    if (!code.trim()) {
      this.post("Selecciona código en el editor y pulsa **Explicar**.");
      return;
    }
    const ai = await resolveAi();
    this.post(`_Explicando con **${ai.label}** (${ai.source})…_`, "pending");
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120_000);
      const answer = await askChat(ai, `Explica este código ${lang}:\n\n${code.slice(0, 8000)}`, ctrl.signal);
      clearTimeout(t);
      this.post(answer || "(sin respuesta del modelo)");
    } catch (err) {
      this.post(`No se pudo contactar con el modelo **${ai.label}** (${(err as Error).message}).\n\n${explainOffline(code, lang)}`);
    }
  }

  /** Comprueba qué hay instalado y envía a la vista la lista de requisitos con sus botones de instalación. */
  private async pushRequirements(a?: Analysis): Promise<void> {
    const defs = (a ?? this.getAnalysis())?.requirements ?? [];
    this.reqs = await checkAll(defs);
    const items = await Promise.all(
      this.reqs.map(async (r) => ({
        id: r.id, name: r.name, kind: r.kind, scope: r.scope, why: r.why, installed: !!r.installed, version: r.version,
        options: r.installed ? [] : (await installOptions(r)).map((o) => ({ label: o.label, scope: o.scope, link: !!o.link, command: o.command ?? o.link ?? "" })),
      })),
    );
    this.postRaw({ type: "requirements", items, bulk: bulkCommands(this.reqs).length > 0 });
    void this.lessons.publish();
  }

  private async install(id: string, opt: number): Promise<void> {
    const req = this.reqs.find((r) => r.id === id);
    const option = req && (await installOptions(req))[opt];
    if (!option) return;
    if (option.link) {
      void vscode.env.openExternal(vscode.Uri.parse(option.link));
      return;
    }
    if (option.command) {
      runInTerminal(option.command, option.cwd);
      this.watchInstall();
    }
  }

  /** La terminal no avisa cuando termina: se vuelve a comprobar cada pocos segundos (máx. 10 min). */
  private watchInstall(): void {
    if (this.poll) clearInterval(this.poll);
    const started = Date.now();
    const missing = () => this.reqs.filter((r) => !r.installed).length;
    const before = missing();
    this.postRaw({ type: "requirements-busy" });
    this.poll = setInterval(() => {
      void this.pushRequirements().then(() => {
        if (missing() < before || Date.now() - started > 600_000) {
          clearInterval(this.poll);
          this.poll = undefined;
          this.postRaw({ type: "requirements-idle" });
        }
      });
    }, 5000);
  }

  /** Descarga un modelo en Ollama (el de «Modelo propio») y refresca la lista. */
  private async pull(name: string): Promise<void> {
    if (this.pulling) return;
    if (!/^[\w.\-/]+(:[\w.\-]+)?$/.test(name)) {
      void vscode.window.showWarningMessage("Code Learning: escribe un nombre de modelo válido, por ejemplo qwen2.5-coder:3b.");
      return;
    }
    this.pulling = true;
    const url = vscode.workspace.getConfiguration("codelearning").get<string>("local.url", "http://localhost:11434");
    try {
      await pullModel(url, name, (text) => this.postRaw({ type: "pull", text: `${name}: ${text}` }));
      await vscode.workspace.getConfiguration("codelearning").update("local.model", name, vscode.ConfigurationTarget.Global);
      this.postRaw({ type: "pull", text: `${name}: listo`, done: true });
    } catch (err) {
      this.postRaw({ type: "pull", text: `No se pudo descargar: ${(err as Error).message}`, done: true });
    } finally {
      this.pulling = false;
      await this.refresh();
    }
  }

  /** Comprueba que la IA elegida responde. */
  private async testAi(): Promise<void> {
    const ai = await resolveAi();
    this.postRaw({ type: "test", text: `Probando ${ai.label}…` });
    try {
      const out = await askChat(ai, "Responde solo con la palabra: ok", AbortSignal.timeout(60_000));
      this.postRaw({ type: "test", text: out ? `✓ ${ai.label} responde` : `✗ ${ai.label} no devolvió texto`, ok: !!out });
    } catch (err) {
      this.postRaw({ type: "test", text: `✗ ${(err as Error).message}`, ok: false });
    }
  }

  /** Vista izquierda vacía: solo dispara la apertura a la derecha (sin textos ni botones). */
  private launcherHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';"></head><body>
<script nonce="${nonce}">const v=acquireVsCodeApi();v.postMessage({type:'openRight'});</script></body></html>`;
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.js"));
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<section class="hero" id="hero">
  <div class="logo"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 0.5 8 2 2-1.5 5-2 8-2V4c-3 0-6 0.5-8 2z"/><path d="M12 6v14"/></svg></div>
  <div class="grow"><h1>Code Learning</h1><div class="status"><span class="dot"></span><span id="statusText">Comprobando…</span></div><div class="detail" id="model"></div></div>
  <span class="chip" id="source" hidden></span>
</section>
<button class="tri-btn" id="btnGhost" type="button" aria-pressed="false">
  <span class="tri-label">Conectar con GhostCode</span>
  <span class="tri-switch" aria-hidden="true"><span class="tri-knob"></span></span>
</button>
<p class="muted tri-msg" id="ghostMsg" hidden></p>
<nav class="tabs" role="tablist">
  <button class="tab" role="tab" data-tab="start" aria-selected="true"><span>Start</span></button>
  <button class="tab" role="tab" data-tab="learning" aria-selected="false"><span>Learning</span></button>
  <button class="tab" role="tab" data-tab="settings" aria-selected="false"><span>Ajustes</span></button>
</nav>
<section class="page" id="page-start">
  <div id="ghostWarn" class="notice" hidden><span class="grow">GhostCode no instalado. Se usará el modelo propio.</span><button class="btn" id="btnInstall">Instalar GhostCode</button></div>
  <div class="stage">
    <div class="book-orb idle" id="orb" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 0.5 8 2 2-1.5 5-2 8-2V4c-3 0-6 0.5-8 2z"/><path d="M12 6v14"/><path class="flip" d="M12 6c2-1.5 4-2 6.5-2v14c-2.5 0-4.5 0.5-6.5 2z"/></svg>
      <span class="orb-label" id="orbLabel">Elige la carpeta de un proyecto para analizarlo</span>
    </div>
    <div class="input-row"><input type="text" id="pathInput" placeholder="~/proyectos/mi-app" spellcheck="false" aria-label="Carpeta del proyecto"><button class="btn" id="btnAnalyze">Analizar</button></div>
    <div class="row-btns"><button class="btn ghost" id="btnBrowse">Elegir carpeta…</button><button class="btn ghost" id="btnWorkspace">Proyecto abierto</button></div>
  </div>
  <section id="result" class="result" hidden></section>
  <main id="chat"></main>
  <footer><button class="btn ghost wide" id="btnExplain">Explicar selección</button><button class="icon-btn" id="btnRefresh" title="Actualizar estado" aria-label="Actualizar estado">↻</button></footer>
</section>
<section class="page" id="page-learning" hidden>
  <div id="lessonEmpty" class="hint">Analiza un proyecto en <b>Start</b>, instala los requisitos y pulsa <b>Comenzar</b>.</div>
  <div id="lessonView" hidden></div>
</section>
<section class="page" id="page-settings" hidden>
  <h2 class="sec">Avance del proyecto</h2>
  <div id="chart" class="chart"><p class="muted">Analiza un proyecto para ver tu avance por temas.</p></div>
  <div class="row-btns"><button class="btn ghost" id="btnExport" title="Guarda learning/avance.md con tu avance, tiempo y racha">Exportar avance</button></div>
  <h2 class="sec">Modelo de IA</h2>
  <label class="field">Origen
    <select id="setBackend">
      <option value="auto">Automático — el mejor que cargó GhostCode / MagicTools</option>
      <option value="local">IA local (Ollama)</option>
      <option value="opencode">OpenCode</option>
    </select>
  </label>
  <p class="notice-line" id="resolved"></p>
  <div data-for="local" hidden>
    <label class="field">Modelo instalado
      <select id="setModelSel"></select>
    </label>
    <label class="field">URL de Ollama
      <input type="text" id="setUrl" placeholder="http://localhost:11434" spellcheck="false">
    </label>
    <label class="field">Cargar otro modelo (se descarga con Ollama)
      <span class="input-row"><input type="text" id="pullName" placeholder="qwen2.5-coder:7b" spellcheck="false"><button class="btn" id="btnPull">Descargar</button></span>
    </label>
    <p class="muted" id="pullStatus"></p>
  </div>
  <div data-for="opencode" hidden>
    <label class="field">Modelo de OpenCode (proveedor/modelo)
      <input type="text" id="setOcModel" list="ocModels" placeholder="vacío = el que tenga OpenCode por defecto" spellcheck="false">
      <datalist id="ocModels"></datalist>
    </label>
    <p class="muted" id="ocStatus"></p>
  </div>
  <div id="notesBox">
    <label class="field">Modelo para las notas de las lecciones
      <select id="setNotesModel"></select>
    </label>
    <p class="muted" id="notesHint"></p>
    <div class="row-btns"><button class="btn ghost" id="btnPullSuggest" hidden></button></div>
    <p class="muted" id="pullStatus2"></p>
  </div>
  <div class="row-btns"><button class="btn ghost" id="btnTest">Probar conexión</button></div>
  <p class="muted" id="testStatus"></p>
  <label class="field">Nivel del alumno
    <select id="setLevel"><option value="beginner">Principiante</option><option value="intermediate">Intermedio</option><option value="advanced">Avanzado</option></select>
  </label>
  <label class="field">Idioma de las lecciones
    <select id="setLanguage"><option value="es">Español</option><option value="en">English</option><option value="pt">Português</option><option value="fr">Français</option></select>
  </label>
  <div class="row-btns">
    <button class="btn ghost" id="btnInstall2">Instalar GhostCode</button>
    <button class="btn ghost" id="btnClearCache" title="Borra el análisis guardado (también para Halo IA)">Limpiar caché</button>
  </div>
</section>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
