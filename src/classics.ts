import { readdir, readFile } from "fs/promises";
import { basename, dirname, extname, join } from "path";

/** Errores de principiante que se reconocen sin IA, con el arreglo directo. */
export interface TipInput {
  /** Carpeta donde escribe el alumno. */
  base: string;
  blocks: { file: string; from: number; to: number; total: number; copy?: boolean; dir?: boolean }[];
  /** Mensajes del comprobador (sintaxis, código de más, etc.). */
  issues: { where: string; why: string }[];
}

/** Cuenta los cierres que sobran (positivo) o faltan (negativo) de { } ( ) [ ], ignorando cadenas y comentarios sencillos. */
export function bracketBalance(code: string): Record<string, number> {
  const bal: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
  const close: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const two = code.slice(i, i + 2);
    if (two === "//" || (c === "#" && !/^#\w+/.test(code.slice(i, i + 12)))) { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (two === "/*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < code.length && code[i] !== c && (c === "`" || code[i] !== "\n")) i += code[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c in bal) bal[c]++;
    else if (c in close) bal[close[c]]--;
    i++;
  }
  return bal;
}

/** Distancia de edición, para encontrar «Producto.js» cuando se pidió «producto.js». */
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Archivo parecido al pedido: mismo nombre con otras mayúsculas, en otra carpeta o con una letra de diferencia. */
async function lookalike(base: string, file: string): Promise<string | undefined> {
  const want = basename(file).toLowerCase();
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length > 40) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || ["node_modules", "vendor", "learning"].includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full, depth + 1);
      else found.push(full.slice(base.length + 1));
    }
  };
  await visit(base, 0);
  return found.find((f) => basename(f).toLowerCase() === want) ?? found.find((f) => lev(basename(f).toLowerCase(), want) <= 1 && extname(f) === extname(file));
}

const SYNTAX: [RegExp, string][] = [
  [/unexpected end of file|Unexpected end of input|unexpected EOF|expected '\}'/i, "Falta cerrar una llave `}` o un paréntesis `)`: cuenta que cada apertura tenga su cierre."],
  [/expecting [`'"]?[;,][`'"]?|missing ;|Expected ';'|expected ';'/i, "Parece faltar un `;` o una `,` al final de la línea anterior a la que señala el error."],
  [/missing \) after argument list|expected '\)'/i, "Hay un paréntesis `)` sin cerrar en una llamada a función."],
  [/Invalid or unexpected token|unterminated string|unexpected T_ENCAPSED|unexpected '"'/i, "Hay unas comillas sin cerrar, o comillas tipográficas (“ ” ‘ ’) en vez de las normales (\" ')."],
  [/IndentationError|unexpected indent|unindent/i, "La sangría de Python debe ser pareja: usa 4 espacios en cada nivel y no mezcles tabuladores."],
  [/JSON|Unexpected token .* in JSON|Expected double-quoted|trailing comma/i, "En JSON no se admiten comas al final, comillas simples ni comentarios; las claves van entre comillas dobles."],
  [/Cannot find module|Class .* not found|No module named/i, "Un archivo que se importa no existe o la ruta está mal escrita; revisa el nombre (mayúsculas incluidas) y ejecuta el comando de instalación de la lección."],
  [/unexpected '?<'?|T_INLINE_HTML/i, "Falta abrir PHP con `<?php` al principio del archivo, o cerraste `?>` antes de tiempo."],
  [/código de más|de más/i, "Parece que pegaste algún tramo dos veces o escribiste código que esta lección no pide."],
];

/** Consejos para el alumno según lo que falló. Máximo 4. */
export async function classicTips(i: TipInput): Promise<string[]> {
  const tips: string[] = [];
  const add = (t: string) => { if (!tips.includes(t)) tips.push(t); };
  const text = i.issues.map((x) => x.why).join("\n");
  for (const [re, tip] of SYNTAX) if (re.test(text)) add(tip);

  for (const b of i.blocks) {
    if (b.copy || b.dir) continue;
    const abs = join(i.base, b.file);
    const code = await readFile(abs, "utf8").catch(() => undefined);
    if (code === undefined) {
      const near = await lookalike(i.base, b.file);
      add(near ? `No encuentro \`${b.file}\`, pero existe \`${near}\`. Los nombres distinguen mayúsculas y carpetas: renómbralo o muévelo a \`${dirname(b.file) === "." ? "la raíz" : dirname(b.file) + "/"}\`.` : `Todavía no existe \`${b.file}\`: créalo en esa ruta exacta (carpetas incluidas).`);
      continue;
    }
    if (!code.trim()) { add(`\`${b.file}\` está vacío: pega o escribe el código de la lección.`); continue; }
    if (/[“”‘’]/.test(code)) add(`\`${b.file}\` tiene comillas tipográficas (“ ” ‘ ’), típicas al copiar de un documento: cámbialas por comillas normales.`);
    if (extname(b.file) === ".php" && !/^\s*(<\?php|<\?=|<!DOCTYPE|<html|<)/i.test(code) && /[;{}]/.test(code.slice(0, 200))) add(`\`${b.file}\` debe empezar con \`<?php\`.`);
    if (/\t/.test(code) && /^ {2,}\S/m.test(code)) add(`\`${b.file}\` mezcla tabuladores y espacios; usa solo uno de los dos para que la sangría quede pareja.`);
    // Solo se cuentan los cierres si el archivo está completo en esta lección.
    if (b.to >= b.total && [".js", ".mjs", ".cjs", ".ts", ".php", ".css", ".scss", ".json", ".go", ".rs", ".java"].includes(extname(b.file).toLowerCase())) {
      const bal = bracketBalance(code);
      for (const [c, n] of Object.entries(bal)) {
        const closeCh = { "{": "}", "(": ")", "[": "]" }[c]!;
        if (n > 0) add(`En \`${b.file}\` falta${n > 1 ? "n" : ""} ${n} \`${closeCh}\` para cerrar los \`${c}\` abiertos.`);
        if (n < 0) add(`En \`${b.file}\` sobra${-n > 1 ? "n" : ""} ${-n} \`${closeCh}\`: hay más cierres que aperturas.`);
      }
    }
  }
  return tips.slice(0, 4);
}
