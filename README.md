# Code Learning 📖

Esqueleto inicial de la herramienta **Code Learning** (proyecto independiente de GhostCode).

- Icono libro (`media/codelearning.svg`).
- Vista en barra de actividad + **chat que se abre a la derecha** (`ViewColumn.Beside`), como un chat de IA, comando `Code Learning: Abrir chat (lado derecho)`.
- Reusa los modelos de **GhostCode** si está instalado (lee su config `ghostcode.*`, al estilo Magictools). Si no, botón **Instalar Ghostcode**.

## Desarrollo

```bash
cd /home/edgar/Documentos/programacion/codelearning
npm install
npm run compile   # dist/extension.js
npm run typecheck
# F5 en VS Code / VSCodium para probar. Mueve la vista a la barra lateral derecha si quieres.
```

## Cómo funciona la integración GhostCode

- `src/ghostBridge.ts`: detecta `edgar.ghostcode` (o cualquier id con “ghostcode”), lee `ghostcode.local.*` y expone `effectiveModel()`.
- `src/ai.ts`: llamada mínima a Ollama `/api/chat` + fallback offline.
- `codelearning.installGhostcode`: abre el buscador de extensiones (`@id:edgar.ghostcode`, vale en Marketplace y Open VSX).

## Pendiente (me dirás cómo se desarrollará)

- Definir lecciones / niveles / quizzes / onboarding.
- Formato del chat, historial, prompts.
