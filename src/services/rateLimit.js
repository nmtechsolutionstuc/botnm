import { env } from '../config.js';

const MAX_PER_WINDOW = Number(env.IMAGE_RATE_LIMIT_MAX) || 10;
const WINDOW_MS = (Number(env.IMAGE_RATE_LIMIT_WINDOW_MIN) || 60) * 60_000;

const historial = new Map(); // userId -> timestamps[]

/** Devuelve { permitido, restantes, esperarMs } sin consumir el cupo si ya está agotado. */
export function checkLimit(userId) {
  const ahora = Date.now();
  const key = String(userId);
  const previos = (historial.get(key) ?? []).filter((t) => ahora - t < WINDOW_MS);

  if (previos.length >= MAX_PER_WINDOW) {
    const esperarMs = WINDOW_MS - (ahora - previos[0]);
    historial.set(key, previos);
    return { permitido: false, restantes: 0, esperarMs };
  }

  previos.push(ahora);
  historial.set(key, previos);
  return { permitido: true, restantes: MAX_PER_WINDOW - previos.length, esperarMs: 0 };
}
