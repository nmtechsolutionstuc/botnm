import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATE_FILE = resolve('data/state.json');

function ensureStateFile() {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(STATE_FILE)) writeFileSync(STATE_FILE, '{}', 'utf-8');
}

function readAll() {
  ensureStateFile();
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  ensureStateFile();
  writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), 'utf-8');
}

export function getState(chatId) {
  const all = readAll();
  return all[String(chatId)] ?? null;
}

export function setState(chatId, partialState) {
  const all = readAll();
  const key = String(chatId);
  all[key] = { ...(all[key] ?? {}), ...partialState };
  writeAll(all);
  return all[key];
}

export function clearState(chatId) {
  const all = readAll();
  delete all[String(chatId)];
  writeAll(all);
}
