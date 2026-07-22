import { Markup } from 'telegraf';
import { getState, setState } from '../state/conversationStore.js';
import { generateImage, editImage, enhanceQuality } from '../services/cloudflare.js';
import { checkLimit } from '../services/rateLimit.js';
import { preguntarModo, descargarArchivoTelegram, reportarError } from './shared.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const pendingByChat = new Map(); // chatId -> { kind, prompt?, originalBuffer?, originalMimeType?, buffer, mimeType }

const MENSAJE_PROCESANDO = {
  generar: 'Generando imagen con IA (Cloudflare)...',
  editar: 'Editando la imagen con IA (Cloudflare)...',
  mejorar: 'Mejorando la nitidez con IA (Cloudflare)...',
};

export function registerImageCommands(bot) {
  bot.command('generar', async (ctx) => {
    const prompt = ctx.message.text.replace(/^\/generar(@\S+)?\s*/, '').trim();
    if (!prompt) {
      await ctx.reply('Usalo así: /generar un gato futurista con lentes de sol');
      return;
    }
    await procesarYMostrar(ctx, ctx.chat.id, 'generar', { prompt });
  });

  bot.action('img:usar', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    const pending = pendingByChat.get(chatId);
    if (!pending?.buffer) {
      await ctx.reply('Ya no tengo esa imagen en memoria, generala de nuevo.');
      return;
    }
    const sent = await ctx.replyWithPhoto({ source: pending.buffer });
    const fileId = sent.photo[sent.photo.length - 1].file_id;
    const current = getState(chatId) ?? { images: [] };
    setState(chatId, { images: [...(current.images ?? []), { fileId, mimeType: 'image/jpeg' }] });
    pendingByChat.delete(chatId);
    await preguntarModo(ctx, chatId);
  });

  bot.action('img:regenerar', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    const pending = pendingByChat.get(chatId);
    if (!pending) {
      await ctx.reply('No tengo con qué regenerar, mandá el comando de nuevo.');
      return;
    }
    await procesarYMostrar(ctx, chatId, pending.kind, pending);
  });

  bot.action('img:cancelar', async (ctx) => {
    await ctx.answerCbQuery();
    pendingByChat.delete(ctx.chat.id);
    await ctx.reply('Cancelado.');
  });
}

/** Se llama desde el handler de fotos para interceptar "/editar" y "/mejorar" mandados como caption. */
export async function maybeHandlePhotoCommand(ctx) {
  const caption = ctx.message.caption?.trim() ?? '';

  if (caption.startsWith('/editar')) {
    const instrucciones = caption.replace(/^\/editar(@\S+)?\s*/, '').trim();
    await manejarEditar(ctx, instrucciones);
    return true;
  }

  if (caption.startsWith('/mejorar')) {
    await manejarMejorar(ctx);
    return true;
  }

  return false;
}

async function manejarEditar(ctx, instrucciones) {
  if (!instrucciones) {
    await ctx.reply('Mandame la foto con la instrucción en el texto, ej: "/editar cambiale el fondo a un estudio blanco".');
    return;
  }
  const validacion = validarFoto(ctx);
  if (!validacion.ok) {
    await ctx.reply(validacion.mensaje);
    return;
  }

  const chatId = ctx.chat.id;
  const best = ctx.message.photo[ctx.message.photo.length - 1];
  const originalBuffer = await descargarArchivoTelegram(ctx, best.file_id);
  await procesarYMostrar(ctx, chatId, 'editar', {
    prompt: instrucciones,
    originalBuffer,
    originalMimeType: 'image/jpeg',
  });
}

async function manejarMejorar(ctx) {
  const validacion = validarFoto(ctx);
  if (!validacion.ok) {
    await ctx.reply(validacion.mensaje);
    return;
  }

  const chatId = ctx.chat.id;
  const best = ctx.message.photo[ctx.message.photo.length - 1];
  const originalBuffer = await descargarArchivoTelegram(ctx, best.file_id);
  await procesarYMostrar(ctx, chatId, 'mejorar', { originalBuffer, originalMimeType: 'image/jpeg' });
}

function validarFoto(ctx) {
  const photo = ctx.message.photo;
  if (!photo?.length) return { ok: false, mensaje: 'Mandame una foto junto con el comando.' };
  const best = photo[photo.length - 1];
  if (best.file_size && best.file_size > MAX_FILE_BYTES) {
    return { ok: false, mensaje: 'La imagen es muy pesada (máximo 8MB). Probá con otra.' };
  }
  return { ok: true };
}

async function procesarYMostrar(ctx, chatId, kind, datos) {
  const rate = checkLimit(ctx.from.id);
  if (!rate.permitido) {
    const minutos = Math.ceil(rate.esperarMs / 60_000);
    await ctx.reply(`Llegaste al límite de pedidos de imagen por ahora. Probá de nuevo en ${minutos} min.`);
    return;
  }

  await ctx.reply(MENSAJE_PROCESANDO[kind]);

  try {
    let resultado;
    if (kind === 'generar') resultado = await generateImage({ prompt: datos.prompt });
    else if (kind === 'editar') resultado = await editImage({ prompt: datos.prompt, imageBuffer: datos.originalBuffer });
    else resultado = await enhanceQuality({ imageBuffer: datos.originalBuffer });

    pendingByChat.set(chatId, { kind, ...datos, buffer: resultado.buffer, mimeType: resultado.mimeType });

    const notaMejorar =
      kind === 'mejorar'
        ? '\n\n(Es una pasada de nitidez con IA generativa, no un upscaler real de resolución.)'
        : '';

    await ctx.replyWithPhoto(
      { source: resultado.buffer },
      {
        caption: `¿Usamos esta imagen?${notaMejorar}`,
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('✅ Usar esta', 'img:usar'),
          Markup.button.callback('🔁 Regenerar', 'img:regenerar'),
          Markup.button.callback('❌ Cancelar', 'img:cancelar'),
        ]).reply_markup,
      }
    );
  } catch (err) {
    await reportarError(ctx, err);
  }
}
