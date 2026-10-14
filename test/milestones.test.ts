import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compareReplies, runProbe, similarity } from "../src/milestones";
import type { Analysis } from "../src/analyzer";

// Servidor sin dependencias: responde distinto según el título que se le pase.
const server = (title: string, extra = "") => `
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/oculto") { res.statusCode = 404; return res.end("no"); }
  res.setHeader("Content-Type", "text/html");
  res.end("<html><body><h1>${title}</h1>${extra}</body></html>");
}).listen(process.env.PORT || 3000);
`;
const mk = (code: string) => {
  const d = mkdtempSync(join(tmpdir(), "cl-probe-"));
  writeFileSync(join(d, "server.js"), code);
  return d;
};
const analysis = (root: string): Analysis => ({ root, profile: { entry: "server.js" } }) as unknown as Analysis;

test("compara respuestas: iguales, casi iguales y distintas", () => {
  const r = (status: number, body: string, location?: string) => ({ status, body, location });
  assert.ok(compareReplies("/", r(200, "<p>Hola   mundo</p>"), r(200, "<p>Hola mundo</p>")).ok);
  assert.ok(compareReplies("/", r(200, "<!-- a --><p>x</p>"), r(200, "<p>x</p>")).ok, "los comentarios HTML no cuentan");
  assert.ok(!compareReplies("/", r(200, "a"), r(404, "a")).ok);
  assert.ok(!compareReplies("/", r(302, "", "/a"), r(302, "", "/b")).ok);
  assert.ok(!compareReplies("/", r(200, "uno dos tres"), r(200, "cuatro cinco seis")).ok);
  assert.strictEqual(similarity("a b c", "a b c"), 1);
});

test("hito: un proyecto igual al original lo supera", async () => {
  const orig = mk(server("Tienda"));
  const mine = mk(server("Tienda"));
  const r = await runProbe({ a: analysis(orig), student: mine });
  assert.strictEqual(r.state, "ok", r.summary);
});

test("hito: un proyecto distinto muestra qué página no coincide", async () => {
  const orig = mk(server("Tienda", "<p>Lista de productos con precios y existencias</p>"));
  const mine = mk(server("Otra cosa"));
  const r = await runProbe({ a: analysis(orig), student: mine });
  assert.strictEqual(r.state, "fail");
  assert.ok(r.lines.some((l) => !l.ok && l.url === "/"));
});

test("hito: si falta el punto de entrada se explica en qué lección se escribe", async () => {
  const orig = mk(server("Tienda"));
  const vacio = mkdtempSync(join(tmpdir(), "cl-probe-"));
  const r = await runProbe({ a: analysis(orig), student: vacio, fileLesson: () => 8 });
  assert.strictEqual(r.state, "unsure");
  assert.match(r.summary, /falta `server\.js`.*lección 9/);
});

test("hito: un proyecto que se rompe al arrancar muestra el error", async () => {
  const orig = mk(server("Tienda"));
  const mine = mk("throw new Error('algo se rompió');");
  const r = await runProbe({ a: analysis(orig), student: mine });
  assert.strictEqual(r.state, "fail");
  assert.match(r.lines[0].detail, /algo se rompió/);
});

test("hito: lee las rutas GET del proyecto original", async () => {
  const { probeUrls } = await import("../src/milestones");
  const d = mk(`const app = require("express")();\napp.get("/ver", f);\napp.get("/item/:id", f);\napp.use("/api/cosas", r);`);
  const u = await probeUrls(d);
  assert.deepStrictEqual(u, ["/", "/ver", "/api/cosas"]);
});

test("los avisos de PHP con otra ruta y otra línea no cuentan como diferencia", () => {
  const w = (path: string, line: number) => ({ status: 200, body: `<b>Warning</b>: Undefined array key "token" in <b>${path}/controllers/LoginController.php</b> on line <b>${line}</b><br /><p>Hola</p>` });
  assert.ok(compareReplies("/recuperar", w("/home/a/AppSalon", 115), w("/home/b/test", 125)).ok);
});
