import * as vscode from "vscode";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { chatJson, ollamaChat } from "./ai";

export interface OllamaModel { name: string; size: number; loaded: boolean }

/** A qué IA se llama: un modelo de Ollama o el CLI de OpenCode. */
export type AiTarget =
  | { kind: "ollama"; url: string; model: string; label: string; source: string }
  | { kind: "opencode"; model: string; label: string; source: string };

const DEFAULT_URL = "http://localhost:11434";

function cfg(section: string, key: string, fallback = ""): string {
  return vscode.workspace.getConfiguration(section).get<string>(key, fallback) || fallback;
}

// ---- Ollama ---------------------------------------------------------------------

async function getJson<T>(url: string, path: string, ms = 3000): Promise<T> {
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()) as T;
}

/** Modelos instalados en Ollama, marcando los que están cargados en memoria ahora mismo. */
export async function listOllama(url: string): Promise<OllamaModel[]> {
  const tags = await getJson<{ models?: { name: string; size: number }[] }>(url, "/api/tags");
  const loaded = new Set(
    (await getJson<{ models?: { name: string }[] }>(url, "/api/ps").catch(() => ({ models: [] }))).models?.map((m) => m.name) ?? [],
  );
  return (tags.models ?? []).map((m) => ({ name: m.name, size: m.size, loaded: loaded.has(m.name) }));
}

/** Los modelos «base»/de relleno (FIM) y de embeddings no siguen instrucciones. */
const isChatModel = (n: string) => !/base|embed|fim|starcoder|codestral-mamba/i.test(n);

/**
 * Mejor modelo ya preparado por GhostCode o MagicTools: entre los que tienen cargados en memoria
 * y los que dejaron configurados para chat, el más grande (a igualdad, el cargado).
 */
export function pickBest(models: OllamaModel[], configured: string[]): { model: OllamaModel; why: string } | undefined {
  const usable = models.filter((m) => isChatModel(m.name));
  const ready = usable.filter((m) => m.loaded || configured.includes(m.name));
  const pool = ready.length ? ready : usable;
  const best = [...pool].sort((a, b) => b.size - a.size || Number(b.loaded) - Number(a.loaded))[0];
  if (!best) return undefined;
  return { model: best, why: ready.length ? (best.loaded ? "cargado en Ollama" : "elegido en GhostCode/MagicTools") : "el mayor instalado" };
}

export function ghostUrl(): string {
  return cfg("magictools", "local.url") || cfg("ghostcode", "local.url") || cfg("codelearning", "local.url", DEFAULT_URL);
}

/** Resuelve qué IA usar según el origen elegido en Ajustes. Nunca lanza: si Ollama no responde devuelve un valor por defecto. */
export async function resolveAi(): Promise<AiTarget> {
  const backend = cfg("codelearning", "backend", "auto");
  if (backend === "opencode") {
    const model = cfg("codelearning", "opencode.model");
    return { kind: "opencode", model, label: model || "OpenCode (modelo por defecto)", source: "opencode" };
  }
  const own = cfg("codelearning", "local.model");
  if (backend === "local") {
    const url = cfg("codelearning", "local.url", DEFAULT_URL);
    const model = own || "qwen2.5-coder:3b";
    return { kind: "ollama", url, model, label: model, source: "modelo propio" };
  }
  // auto (también el antiguo valor "ghostcode")
  const url = ghostUrl();
  const configured = [cfg("ghostcode", "local.chatModel"), cfg("magictools", "local.chatModel")].filter(Boolean);
  try {
    const best = pickBest(await listOllama(url), configured);
    if (best) return { kind: "ollama", url, model: best.model.name, label: best.model.name, source: best.why };
  } catch {
    // Ollama apagado: se cae al modelo declarado.
  }
  const model = configured[0] || own || "qwen2.5-coder:3b";
  return { kind: "ollama", url, model, label: model, source: "sin detectar Ollama" };
}

/** IA para redactar las lecciones: el modelo elegido en «Modelo para las notas» si hay uno (solo Ollama), y si no, el mismo del análisis. */
export async function resolveNotesAi(base: AiTarget): Promise<AiTarget> {
  const model = cfg("codelearning", "notesModel");
  if (base.kind !== "ollama" || !model || model === base.model) return base;
  return { ...base, model, label: model, source: "modelo para las notas" };
}

/** Descarga un modelo en Ollama (/api/pull), informando del avance. */
export async function pullModel(url: string, name: string, onProgress: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (j.error) throw new Error(j.error);
      const pct = j.total ? ` ${Math.round(((j.completed ?? 0) / j.total) * 100)}%` : "";
      onProgress(`${j.status ?? ""}${pct}`);
    }
  }
}

// ---- OpenCode -------------------------------------------------------------------

/** Ruta del CLI: el PATH de VS Code a veces no incluye ~/.opencode/bin. */
export function opencodeBin(): string | undefined {
  const home = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(home)) return home;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "opencode");
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

function runCli(bin: string, args: string[], ms: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // cwd = carpeta temporal: el agente no debe tocar ningún proyecto, todo el contexto va en el mensaje.
    const p = spawn(bin, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], signal, timeout: ms });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 || out ? resolve(out) : reject(new Error(err.trim() || `opencode terminó con código ${code}`))));
  });
}

export async function opencodeModels(): Promise<string[]> {
  const bin = opencodeBin();
  if (!bin) return [];
  const out = await runCli(bin, ["models", "--standalone"], 15_000).catch(() => "");
  return out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l));
}

export async function opencodeAsk(model: string, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const bin = opencodeBin();
  if (!bin) throw new Error("OpenCode no está instalado (no se encontró el comando «opencode»)");
  const args = ["run", "--format", "json"];
  if (model) args.push("-m", model);
  args.push(system ? `${system}\n\n${prompt}` : prompt);
  const out = await runCli(bin, args, 300_000, signal);
  let text = "";
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string }; error?: { message?: string; data?: { message?: string } } };
      if (j.type === "error") throw new Error(j.error?.data?.message ?? j.error?.message ?? "error de OpenCode");
      if (j.part?.type === "text" && j.part.text) text += j.part.text;
    } catch (e) {
      if ((e as Error).name !== "SyntaxError") throw e;
    }
  }
  return text.trim();
}

// ---- Llamadas genéricas -----------------------------------------------------------

/** Pide JSON al destino elegido (Ollama con format:json, u OpenCode pidiéndolo en el prompt). */
export function askJson(t: AiTarget, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return t.kind === "ollama" ? chatJson(t.url, t.model, system, prompt, signal) : opencodeAsk(t.model, system, prompt, signal);
}

export function askChat(t: AiTarget, prompt: string, signal?: AbortSignal): Promise<string> {
  return t.kind === "ollama" ? ollamaChat(t.url, t.model, prompt, signal) : opencodeAsk(t.model, "Eres un profesor de programación. Explica con claridad, en español, con ejemplos cortos.", prompt, signal);
}

/** Texto libre con un system prompt propio (pistas, ayuda, comprobaciones). */
export function askText(t: AiTarget, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return t.kind === "ollama" ? ollamaChat(t.url, t.model, prompt, signal, system) : opencodeAsk(t.model, system, prompt, signal);
}
