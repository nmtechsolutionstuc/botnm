import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { env, requireEnv } from '../config.js';

const SHEET_RANGE = 'A:H';
const CACHE_TTL_MS = 30_000;

let sheetsClientPromise = null;
let cache = { data: null, expiresAt: 0 };

function loadServiceAccountCredentials() {
  const inlineJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) return JSON.parse(inlineJson);
  const keyPath = requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  return JSON.parse(readFileSync(keyPath, 'utf-8'));
}

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = loadServiceAccountCredentials();
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
      return google.sheets({ version: 'v4', auth });
    })();
  }
  return sheetsClientPromise;
}

function parseUsuariosPermitidos(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function rowToModo(headers, row) {
  const record = {};
  headers.forEach((header, i) => {
    record[header] = row[i] ?? '';
  });
  return {
    modo: record.modo,
    canalIgBuffer: record.canal_ig_buffer || null,
    canalTiktokBuffer: record.canal_tiktok_buffer || null,
    canalFbBuffer: record.canal_fb_buffer || null,
    promptImagen: record.prompt_imagen || '',
    promptTexto: record.prompt_texto || '',
    datosFijos: record.datos_fijos || '',
    usuariosPermitidos: parseUsuariosPermitidos(record.usuarios_permitidos),
  };
}

async function fetchModos() {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireEnv('GOOGLE_SHEET_ID');
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_RANGE,
  });

  const [headerRow, ...rows] = data.values ?? [];
  if (!headerRow) return [];

  return rows
    .filter((row) => row[0]) // ignora filas sin nombre de modo
    .map((row) => rowToModo(headerRow, row));
}

export async function listModos({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && cache.expiresAt > now) {
    return cache.data;
  }
  const modos = await fetchModos();
  cache = { data: modos, expiresAt: now + CACHE_TTL_MS };
  return modos;
}

export async function getModo(nombre) {
  const modos = await listModos();
  return modos.find((m) => m.modo.toLowerCase() === nombre.toLowerCase()) ?? null;
}

export async function modosPermitidosParaUsuario(telegramUserId) {
  const modos = await listModos();
  const idStr = String(telegramUserId);
  return modos.filter(
    (m) => m.usuariosPermitidos.length === 0 || m.usuariosPermitidos.includes(idStr)
  );
}
