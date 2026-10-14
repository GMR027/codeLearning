import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bracketBalance, classicTips } from "../src/classics";

const block = (file: string, to = 10, total = 10) => ({ file, from: 1, to, total });
const dir = () => mkdtempSync(join(tmpdir(), "cl-tips-"));

test("cuenta los cierres que faltan o sobran ignorando cadenas y comentarios", () => {
  assert.deepStrictEqual(bracketBalance("function f() {\n  return ')';\n}"), { "{": 0, "(": 0, "[": 0 });
  assert.strictEqual(bracketBalance("function f() {\n  if (x) {\n}")["{"], 1);
  assert.strictEqual(bracketBalance("a(); } // {{{")["{"], -1);
});

test("un archivo con otro nombre en mayúsculas o en otra carpeta se señala", async () => {
  const base = dir();
  mkdirSync(join(base, "models"));
  writeFileSync(join(base, "models", "Producto.js"), "x");
  const t = await classicTips({ base, blocks: [block("models/producto.js")], issues: [] });
  assert.match(t[0], /existe `models\/Producto\.js`/);
  const t2 = await classicTips({ base: dir(), blocks: [block("a/b.js")], issues: [] });
  assert.match(t2[0], /Todavía no existe `a\/b\.js`/);
});

test("reconoce comillas tipográficas, llaves sin cerrar y falta de <?php", async () => {
  const base = dir();
  writeFileSync(join(base, "a.js"), "const x = “hola”;\nfunction f() {\n");
  writeFileSync(join(base, "b.php"), "echo 'hola';\n$x = 1;\n");
  const t = await classicTips({ base, blocks: [block("a.js"), block("b.php")], issues: [] });
  const all = t.join("\n");
  assert.match(all, /comillas tipográficas/);
  assert.match(all, /falta 1 `\}`/);
  assert.match(all, /debe empezar con `<\?php`/);
});

test("traduce mensajes de error de sintaxis a consejos", async () => {
  const base = dir();
  writeFileSync(join(base, "a.php"), "<?php\n$x = 1\n");
  const t = await classicTips({ base, blocks: [block("a.php", 2, 2)], issues: [{ where: "a.php:2", why: "PHP Parse error: syntax error, unexpected end of file, expecting ';'" }] });
  assert.ok(t.some((x) => /llave|paréntesis/.test(x)));
  assert.ok(t.some((x) => /`;`/.test(x)));
});
