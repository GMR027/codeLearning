import test from "node:test";
import assert from "node:assert";
import { existsSync } from "fs";
import { analyzeOffline, TIENDA } from "./helpers";

test("perfil de un proyecto Node con Express", async () => {
  const { profile: p } = await analyzeOffline(TIENDA);
  assert.strictEqual(p.id, "tienda-api");
  assert.strictEqual(p.framework, "Express");
  assert.strictEqual(p.languages[0], "JavaScript");
  assert.match(p.architecture ?? "", /rutas, controladores y modelos/);
  assert.strictEqual(p.entry, "server.js");
  assert.deepStrictEqual(p.scripts.map((s) => s.name), ["npm run start", "npm run dev", "npm run test"]);
  assert.ok(p.services.includes("SQLite"), `servicios: ${p.services}`);
  assert.ok(["PORT", "DB_FILE", "API_TOKEN"].every((v) => p.env.includes(v)), `env: ${p.env}`);
});

test("el id no depende de la carpeta", async () => {
  const a = await analyzeOffline(TIENDA);
  assert.strictEqual(a.profile.id, "tienda-api");
});

const APPSALON = "/home/edgar/Documentos/programacion/AppSalon_PHP_MVC_JS_SASS";
test("perfil de un proyecto PHP MVC (si está disponible)", { skip: !existsSync(APPSALON) }, async () => {
  const { profile: p } = await analyzeOffline(APPSALON);
  assert.match(p.architecture ?? "", /^MVC/);
  assert.strictEqual(p.languages[0], "PHP");
  assert.ok(p.services.includes("MySQL / MariaDB"));
  assert.ok(p.warnings.some((w) => /vacíos/.test(w) && /Mail\.php/.test(w)), `avisos: ${p.warnings}`);
});
