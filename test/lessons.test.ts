import test from "node:test";
import assert from "node:assert";
import { readFile } from "fs/promises";
import { join } from "path";
import { annotate, progressFits, sameUpToRenaming, structuralDiff } from "../src/lessons";
import type { Analysis } from "../src/analyzer";
import { analyzeOffline, TIENDA } from "./helpers";

test("copiar la lección anotada tal cual es lo mismo que el original", async () => {
  const { curriculum } = await analyzeOffline(TIENDA);
  for (const l of curriculum.lessons) {
    for (const p of l.parts) {
      const lines = (await readFile(join(TIENDA, p.file), "utf8")).replace(/\s+$/, "").split("\n");
      const shown = lines.slice(p.from - 1, p.to).join("\n");
      const display = annotate(shown, [{ from: 1, text: "Nota de ejemplo" }], p.file);
      const d = structuralDiff(shown, display, p.file);
      assert.strictEqual(d.missing.length + d.extra.length, 0, `${p.file}: ${JSON.stringify(d.missing.concat(d.extra).slice(0, 2))}`);
    }
  }
});

test("renombrar variables sigue siendo el mismo código; cambiar la lógica no", () => {
  const ref = "function sumar(a, b) {\n  return a + b;\n}\n";
  assert.ok(sameUpToRenaming(ref, "function sumar(x, y) {\n  return x + y;\n}\n", "a.js"));
  assert.ok(!sameUpToRenaming(ref, "function sumar(x, y) {\n  return x - y;\n}\n", "a.js"));
});

test("código incompleto y código repetido se detectan", async () => {
  const ref = await readFile(join(TIENDA, "controllers/productosController.js"), "utf8");
  const half = ref.split("\n").slice(0, 8).join("\n");
  assert.ok(structuralDiff(ref, half, "x.js").missing.length > 0);
  const twice = ref.replace("function ver", "function ver(req, res) { res.json(1); }\nfunction ver");
  assert.ok(structuralDiff(ref, twice, "x.js").extra.length > 0);
});

const lesson = (file: string, from: number) => ({ content: { blocks: [{ file, from }] } });
const analysis = (parts: [string, number][][]) => ({ curriculum: parts.map((p) => ({ parts: p.map(([file, from]) => ({ file, from })) })) }) as unknown as Analysis;

test("el avance solo encaja con el temario del que salió", () => {
  const a = analysis([[["a.js", 1]], [["b.js", 1]], [["c.js", 1]]]);
  assert.ok(progressFits({ lessons: { 0: lesson("a.js", 1), 1: lesson("b.js", 1) } }, a));
  // Otro orden: marcaría como hecha una lección distinta.
  assert.ok(!progressFits({ lessons: { 0: lesson("b.js", 1), 1: lesson("a.js", 1) } }, a));
  // Otro tramo del mismo archivo.
  assert.ok(!progressFits({ lessons: { 0: lesson("a.js", 40) } }, a));
  // Más lecciones que el temario.
  assert.ok(!progressFits({ lessons: { 5: lesson("a.js", 1) } }, a));
  // Sin lecciones abiertas no hay nada que comparar.
  assert.ok(!progressFits({ lessons: {} }, a));
});

test("las notas nunca se escriben dentro de una cadena de varias líneas", () => {
  const js = "const db = new Db();\ndb.exec(`\n  CREATE TABLE t (\n    id INTEGER\n  )\n`);\nmodule.exports = db;";
  const out = annotate(js, [{ from: 3, text: "Crea la tabla" }, { from: 4, text: "Columna" }], "db.js");
  assert.strictEqual(out.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"), js);
  assert.ok(out.indexOf("// Crea la tabla") < out.indexOf("db.exec(`"), "la nota sube a donde empieza la cadena");
  const py = 'x = 1\nq = """\nSELECT 1\n"""\ny = 2';
  const o2 = annotate(py, [{ from: 3, text: "Consulta" }], "a.py");
  assert.strictEqual(o2.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"), py);
  const php = "<?php\n$q = \"SELECT *\n FROM t\n WHERE 1\";\n$r = <<<SQL\nSELECT 2\nSQL;\necho $q;";
  const o3 = annotate(php, [{ from: 3, text: "a" }, { from: 6, text: "b" }, { from: 8, text: "c" }], "a.php", true);
  assert.strictEqual(o3.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"), php);
  assert.ok(o3.includes("// c"), "fuera de cadenas la nota se queda en su línea");
});

// ---- Repaso de lecciones anteriores ----------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname } from "path";
import { recheckLesson, type CodeBlock, type LessonContent } from "../src/lessons";

/** Lecciones de la tienda con el código tal cual, y una carpeta de alumno con todos los archivos completos. */
async function studentWithAllLessons() {
  const { curriculum } = await analyzeOffline(TIENDA);
  const base = mkdtempSync(join(tmpdir(), "cl-regress-"));
  const contents: LessonContent[] = [];
  for (const l of curriculum.lessons) {
    const blocks: CodeBlock[] = [];
    for (const p of l.parts) {
      const lines = (await readFile(join(TIENDA, p.file), "utf8")).replace(/\s+$/, "").split("\n");
      const shown = lines.slice(p.from - 1, p.to).join("\n");
      blocks.push({ file: p.file, from: p.from, to: p.to, total: p.total, shown, ref: lines.slice(0, p.to).join("\n"), display: shown, copy: p.copy });
      mkdirSync(join(base, dirname(p.file)), { recursive: true });
      writeFileSync(join(base, p.file), annotate(lines.join("\n"), [{ from: 1, text: "Nota" }], p.file) + "\n");
    }
    contents.push({ title: l.title, objective: "", topics: [], scope: "", blocks, checks: [] });
  }
  return { base, contents };
}

test("repaso: con todo el código en su sitio no se rompe ninguna lección", async () => {
  const { base, contents } = await studentWithAllLessons();
  for (const c of contents) assert.deepStrictEqual(await recheckLesson(base, c), [], c.title);
  rmSync(base, { recursive: true, force: true });
});

test("repaso: borrar una función rompe solo la lección que la enseñaba", async () => {
  const { base, contents } = await studentWithAllLessons();
  const f = join(base, "controllers/productosController.js");
  const code = await readFile(f, "utf8");
  writeFileSync(f, code.replace(/function borrar[\s\S]*?\n}\n/, ""));
  const broken = [];
  for (const c of contents) if ((await recheckLesson(base, c)).length) broken.push(c.title);
  assert.deepStrictEqual(broken, [contents.find((c) => c.blocks[0].file === "controllers/productosController.js")!.title]);
  rmSync(base, { recursive: true, force: true });
});

test("repaso: renombrar variables no rompe nada, pero borrar un archivo sí", async () => {
  const { base, contents } = await studentWithAllLessons();
  const f = join(base, "controllers/productosController.js");
  writeFileSync(f, (await readFile(f, "utf8")).replace(/producto\b/g, "item"));
  for (const c of contents) assert.deepStrictEqual(await recheckLesson(base, c), [], `${c.title} tras renombrar`);
  rmSync(join(base, "config/db.js"));
  const issues = await recheckLesson(base, contents.find((c) => c.blocks[0].file === "config/db.js")!);
  assert.match(issues[0].why, /no existe/);
  rmSync(base, { recursive: true, force: true });
});
