import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";
import { installGhostcode } from "./ghostBridge";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Code Learning", { log: true });
  const chat = new ChatPanel(context);

  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider("codelearning.chatView", chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("codelearning.openChat", () => chat.openOnRight()),
    vscode.commands.registerCommand("codelearning.focus", () => chat.focusView()),
    vscode.commands.registerCommand("codelearning.installGhostcode", () => installGhostcode()),
    vscode.commands.registerCommand("codelearning.exportProgress", () => chat.exportProgress()),
    vscode.commands.registerCommand("codelearning.askSelection", () => chat.askSelection()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codelearning") || e.affectsConfiguration("ghostcode")) void chat.refresh();
    }),
  );
  log.info("Code Learning activo. Usa codelearning.openChat para abrir a la derecha.");
  // API para otras extensiones (Halo IA de GhostCode): último análisis de proyecto guardado.
  return { getAnalysis: () => chat.getAnalysis() };
}

export function deactivate(): void {}
