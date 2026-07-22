import { randomUUID } from 'node:crypto';
import { requireEnv } from '../config.js';

const TTL_MS = 30 * 60 * 1000; // 30 min alcanza para que Buffer lo descargue
const store = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, item] of store) {
    if (item.expiresAt < now) store.delete(id);
  }
}, 5 * 60 * 1000).unref();

/** Guarda una imagen en memoria y devuelve una URL pública temporal para que Buffer la descargue. */
export function registerImage(buffer, mimeType) {
  const id = randomUUID();
  store.set(id, { buffer, mimeType, expiresAt: Date.now() + TTL_MS });
  const baseUrl = requireEnv('PUBLIC_BASE_URL').replace(/\/$/, '');
  return { id, url: `${baseUrl}/media/${id}` };
}

export function getImage(id) {
  return store.get(id) ?? null;
}

export function mediaRouteHandler(req, res) {
  const item = getImage(req.params.id);
  if (!item) {
    res.status(404).send('No encontrado o expirado');
    return;
  }
  res.set('Content-Type', item.mimeType);
  res.send(item.buffer);
}
