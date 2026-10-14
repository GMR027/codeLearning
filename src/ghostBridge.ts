import * as vscode from "vscode";

// ID oficial de GhostCode. Si cambia el publisher, el fallback por nombre lo encuentra igual.
export const GHOSTCODE_IDS = ["edgar.ghostcode"];

export interface GhostStatus {
  installed: boolean;
  active: boolean;
  id?: string;
  /** Etiqueta del backend si GhostCode expone API (label del modelo). */
  backendLabel?: string;
  mode?: string;
  localUrl?: string;
  localModel?: string;
  chatModel?: string;
}

/** Busca la extensión GhostCode instalada (ID exacto o cualquier id que contenga "ghostcode"). */
export function findGhostExtension(): vscode.Extension<unknown> | undefined {
  for (const id of GHOSTCODE_IDS) {
    const ext = vscode.extensions.getExtension(id);
    if (ext) return ext;
  }
  return vscode.extensions.all.find((e) => e.id.toLowerCase().includes("ghostcode"));
}

/** Lee la config de GhostCode para reusar su modelo, al estilo Magictools (sin necesidad de API). */
export function readGhostConfig(): Pick<GhostStatus, "mode" | "localUrl" | "localModel" | "chatModel"> {
  const g = vscode.workspace.getConfiguration("ghostcode");
  return {
    mode: g.get<string>("mode", "local"),
    localUrl: g.get<string>("local.url", "http://localhost:11434"),
    localModel: g.get<string>("local.model", "qwen2.5-coder:1.5b-base"),
    chatModel: g.get<string>("local.chatModel", ""),
  };
}

export async function ghostStatus(): Promise<GhostStatus> {
  const ext = findGhostExtension();
  const conf = readGhostConfig();
  if (!ext) return { installed: false, active: false, ...conf };
  let backendLabel: string | undefined;
  try {
    if (!ext.isActive) await ext.activate();
    const api = ext.exports as { backendLabel?: string; backend?: { label?: string } } | undefined;
    backendLabel = api?.backendLabel ?? api?.backend?.label;
  } catch {
    // GhostCode instalado pero falló la activación: igual reusamos su config.
  }
  return { installed: true, active: !!ext.isActive, id: ext.id, backendLabel, ...conf };
}

/** Modelo efectivo a usar: hereda el de GhostCode salvo que el usuario fuerce uno propio. */
export function effectiveModel(): { url: string; model: string; source: "ghostcode" | "propio"; mode: string } {
  const mine = vscode.workspace.getConfiguration("codelearning");
  const backend = mine.get<string>("backend", "auto");
  const myUrl = mine.get<string>("local.url", "http://localhost:11434");
  const myModel = mine.get<string>("local.model", "");
  const g = readGhostConfig();

  if (backend === "local" || (backend === "auto" && !findGhostExtension())) {
    return { url: myUrl, model: myModel || "qwen2.5-coder:1.5b", source: "propio", mode: "local" };
  }
  // ghostcode / auto con GhostCode presente: reusar su instruct si hay, si no su base.
  return {
    url: g.localUrl ?? myUrl,
    model: g.chatModel || myModel || "qwen2.5-coder:1.5b",
    source: "ghostcode",
    mode: g.mode ?? "local",
  };
}

/** Botón "Instalar GhostCode": busca en el Marketplace / Open VSX según el editor. */
export async function installGhostcode(): Promise<void> {
  const ghost = findGhostExtension();
  if (ghost) {
    void vscode.window.showInformationMessage(`GhostCode ya está instalado (${ghost.id}).`);
    return;
  }
  // Abre el buscador de extensiones con el ID exacto. Funciona en VS Code y VSCodium (Open VSX).
  await vscode.commands.executeCommand("workbench.extensions.search", "@id:edgar.ghostcode ghostcode");
  const sel = await vscode.window.showInformationMessage(
    "Instala la extensión “GhostCode — Autocompletado IA” y vuelve aquí. Code Learning reusará su modelo automáticamente.",
    "Ver cómo instalar",
  );
  if (sel === "Ver cómo instalar") {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/GMR027/ghostcode#instalación"),
    );
  }
}
