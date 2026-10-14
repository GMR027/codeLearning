/** Tiempo estimado y racha de estudio. Todo sale de datos guardados en progreso.json. */

const PER_LINE: Record<string, number> = { beginner: 0.4, intermediate: 0.25, advanced: 0.15 };

/** Minutos que debería llevar una lección: leerla y escribirla. Copiar una librería o carpeta es casi inmediato. */
export function estimateMinutes(lines: number, level: string, copy = false): number {
  if (copy) return 2;
  return Math.max(3, Math.round(2 + lines * (PER_LINE[level] ?? 0.4)));
}

/** Día local como AAAA-MM-DD. */
export function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Anota que hoy hubo actividad (se conservan los últimos 400 días). */
export function touchDay(days: string[] | undefined, now = Date.now()): string[] {
  const k = dayKey(now);
  const set = new Set(days ?? []);
  set.add(k);
  return [...set].sort().slice(-400);
}

const dayNum = (k: string) => Math.round(Date.parse(`${k}T12:00:00Z`) / 86_400_000);

/** Días seguidos con actividad. La racha sigue viva si el último día fue hoy o ayer. */
export function streak(days: string[] | undefined, now = Date.now()): { current: number; best: number } {
  const nums = [...new Set((days ?? []).map(dayNum))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  nums.forEach((n, i) => {
    run = i > 0 && n === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  const today = dayNum(dayKey(now));
  const last = nums[nums.length - 1];
  const current = last === today || last === today - 1 ? run : 0;
  return { current, best };
}

/** Duración real de una lección, solo si es creíble (entre 1 y 90 minutos: no se dejó abierta toda la noche). */
export function realMinutes(startedAt?: number, doneAt?: number): number | undefined {
  if (startedAt === undefined || doneAt === undefined) return undefined;
  const m = (doneAt - startedAt) / 60_000;
  return m >= 1 && m <= 90 ? m : undefined;
}

/** Cuánto más rápido o lento que lo estimado va el alumno (con al menos 3 lecciones medidas). */
export function paceFactor(samples: { est: number; actual: number }[]): number {
  if (samples.length < 3) return 1;
  const est = samples.reduce((s, x) => s + x.est, 0);
  const act = samples.reduce((s, x) => s + x.actual, 0);
  return Math.min(3, Math.max(0.3, act / est));
}

export function fmtMinutes(m: number): string {
  const r = Math.max(1, Math.round(m));
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
