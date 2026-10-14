import test from "node:test";
import assert from "node:assert";
import { estimateMinutes, fmtMinutes, paceFactor, realMinutes, streak, touchDay } from "../src/stats";

const at = (day: string) => Date.parse(`${day}T10:00:00`);

test("el tiempo estimado crece con las líneas y baja con el nivel", () => {
  assert.ok(estimateMinutes(60, "beginner") > estimateMinutes(60, "advanced"));
  assert.ok(estimateMinutes(100, "beginner") > estimateMinutes(20, "beginner"));
  assert.strictEqual(estimateMinutes(500, "beginner", true), 2);
});

test("la racha cuenta días seguidos y sigue viva si el último fue ayer", () => {
  const days = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-10", "2026-03-11"];
  assert.deepStrictEqual(streak(days, at("2026-03-11")), { current: 2, best: 3 });
  assert.deepStrictEqual(streak(days, at("2026-03-12")), { current: 2, best: 3 }, "ayer cuenta");
  assert.deepStrictEqual(streak(days, at("2026-03-13")), { current: 0, best: 3 }, "dos días sin estudiar la rompen");
  assert.deepStrictEqual(streak(undefined), { current: 0, best: 0 });
});

test("touchDay no duplica el día", () => {
  const once = touchDay([], at("2026-03-01"));
  assert.deepStrictEqual(touchDay(once, at("2026-03-01")), ["2026-03-01"]);
});

test("el ritmo real solo se usa con suficientes lecciones y lecciones creíbles", () => {
  assert.strictEqual(paceFactor([{ est: 10, actual: 20 }]), 1);
  assert.strictEqual(paceFactor([{ est: 10, actual: 20 }, { est: 10, actual: 20 }, { est: 10, actual: 20 }]), 2);
  assert.strictEqual(realMinutes(0, 5 * 60_000), 5);
  assert.strictEqual(realMinutes(0, 5 * 3600_000), undefined, "una lección abierta toda la noche no cuenta");
  assert.strictEqual(fmtMinutes(130), "2 h 10 min");
  assert.strictEqual(fmtMinutes(25), "25 min");
});
