import test from "node:test";
import assert from "node:assert";
import { renderReport, REPORT_MARKER } from "../src/report";

test("el informe resume avance, tiempo, racha, temas y lecciones", () => {
  const md = renderReport({
    name: "Tienda",
    root: "/p/tienda",
    level: "beginner",
    lessons: [
      { title: "package.json", module: "Preparar el proyecto", status: "done", doneAt: Date.parse("2026-03-01T10:00:00"), minutes: 6 },
      { title: "server.js", module: "Punto de entrada", status: "pending", probe: "unsure" },
    ],
    topics: [{ name: "Backend", done: 1, total: 2, pct: 50 }],
    overall: 50,
    streak: { current: 2, best: 4 },
    activeDays: 3,
    spentMin: 75,
    remainingMin: 30,
    now: Date.parse("2026-03-05T10:00:00"),
  });
  assert.ok(md.startsWith(REPORT_MARKER));
  for (const s of ["# Avance — Tienda", "**50 % completado**", "1 h 15 min", "Racha actual / mejor | 2 / 4 días", "**Backend**", "✅ 1. package.json", "⬜ 2. server.js", "### Punto de entrada", "hito sin probar"]) {
    assert.ok(md.includes(s), `falta «${s}»`);
  }
});

test("el informe incluye el repaso de lecciones anteriores", () => {
  const base = { name: "T", root: "/p", lessons: [], topics: [], overall: 0, streak: { current: 0, best: 0 }, activeDays: 0, spentMin: 0, now: Date.now() };
  assert.match(renderReport({ ...base, regress: { checked: 5, broken: [{ n: 2, title: "db.js" }] } }), /1 dejaron de cumplirse[\s\S]*❌ 2\. db\.js/);
  assert.match(renderReport({ ...base, regress: { checked: 5, broken: [] } }), /Las 5 lecciones repasadas siguen en pie/);
});
