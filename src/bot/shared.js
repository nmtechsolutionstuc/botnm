import { Markup } from 'telegraf';
import { setState } from '../state/conversationStore.js';
import { modosPermitidosParaUsuario } from '../services/sheets.js';

export async function preguntarModo(ctx, chatId) {
  const modos = await modosPermitidosParaUsuario(ctx.from.id);
  setState(chatId, { step: 'esperando_modo' });
  const botones = modos.map((m) => Markup.button.callback(m.modo, `modo:${m.modo}`));
  await ctx.reply('¿Qué modo es?', Markup.inlineKeyboard(botones, { columns: 2 }));
}

export async function descargarArchivoTelegram(ctx, fileId) {
  const url = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No pude descargar el archivo de Telegram (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function reportarError(ctx, err) {
  console.error(err);
  await ctx.reply(`Uh, algo falló: ${err.message}`);
}
