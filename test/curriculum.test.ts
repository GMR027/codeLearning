import test from "node:test";
import assert from "node:assert";
import { buildCurriculum } from "../src/curriculum";
import type { Entry } from "../src/analyzer";
import { analyzeOffline, TIENDA } from "./helpers";

const entry = (path: string, text: string): Entry => ({ path, text, lines: text.split("\n").length, depth: path.split("/").length - 1 });

test("el temario cubre cada línea de código exactamente una vez", async () => {
  const { files, curriculum } = await analyzeOffline(TIENDA);
  const seen = new Map<string, number>();
  for (const l of curriculum.lessons) {
    for (const p of l.parts) {
      if (p.copy) continue;
      assert.strictEqual(p.from, (seen.get(p.file) ?? 0) + 1, `${p.file}: el tramo ${p.from}-${p.to} no sigue al anterior`);
      seen.set(p.file, p.to);
    }
  }
  for (const f of files.filter((f) => /\.(js|css|html)$/.test(f.path))) {
    assert.strictEqual(seen.get(f.path), f.text!.replace(/\s+$/, "").split("\n").length, `${f.path} no está completo en el temario`);
  }
});

test("el orden de construcción: configuración, modelos, rutas, controladores, vistas", async () => {
  const { curriculum } = await analyzeOffline(TIENDA);
  const order = curriculum.lessons.map((l) => l.parts[0].file);
  const at = (f: string) => order.indexOf(f);
  assert.ok(at("package.json") < at("config/db.js"));
  assert.ok(at("config/db.js") < at("models/producto.js"));
  assert.ok(at("models/producto.js") < at("controllers/productosController.js"));
  assert.ok(at("public/index.html") >= 0 && at("public/js/app.js") > at("public/index.html"));
});

test("dentro de una etapa, lo que otro archivo usa va primero", () => {
  const c = buildCurriculum(
    [
      entry("controllers/a.js", "const b = require('./b');\nmodule.exports = b;\n"),
      entry("controllers/b.js", "module.exports = {};\n"),
    ],
    [],
  );
  const order = c.lessons.flatMap((l) => l.parts.map((p) => p.file));
  assert.ok(order.indexOf("controllers/b.js") < order.indexOf("controllers/a.js"), order.join(", "));
});

test("las dependencias circulares no se cuelgan ni pierden archivos", () => {
  const c = buildCurriculum(
    [
      entry("controllers/a.js", "const b = require('./b');\nmodule.exports = b;\n"),
      entry("controllers/b.js", "const a = require('./a');\nmodule.exports = a;\n"),
    ],
    [],
  );
  assert.strictEqual(new Set(c.lessons.flatMap((l) => l.parts.map((p) => p.file))).size, 2);
});
