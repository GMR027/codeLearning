/** Llamada mínima a Ollama /api/chat (modelos instruct). Sin dependencias. */
export async function ollamaChat(url: string, model: string, prompt: string, signal?: AbortSignal, system = "Eres un profesor de programación. Explica con claridad, en español, con ejemplos cortos."): Promise<string> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: "30m",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() || "(sin respuesta del modelo)";
}

/** Explicación local sin IA (fallback si no hay modelo): heurística simple. */
export function explainOffline(code: string, languageId: string): string {
  const lines = code.split("\n").length;
  const fns = (code.match(/function |=>|def |fn |class /g) || []).length;
  return [
    `**Explicación básica (sin modelo IA)** — ${languageId}, ${lines} línea(s).`,
    ``,
    `- Elementos detectados aprox.: ${fns} función/clase.`,
    `- Instala GhostCode o configura un modelo Ollama para la explicación completa con IA.`,
    ``,
    "```" + languageId,
    code.slice(0, 2000),
    "```",
  ].join("\n");
}

/** Pide una respuesta JSON a Ollama (format: json) con contexto ampliado. Devuelve el texto crudo. */
export async function chatJson(url: string, model: string, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      keep_alive: "30m",
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 2000 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}
