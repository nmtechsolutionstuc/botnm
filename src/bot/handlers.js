import { Telegraf, Markup } from 'telegraf';
import { env, requireEnv } from '../config.js';
import { getState, setState, clearState } from '../state/conversationStore.js';
import { getModo, modosPermitidosParaUsuario } from '../services/sheets.js';
import { enhanceImage, generateText, transcribeAudio } from '../services/gemini.js';
import { registerImage } from '../services/mediaHost.js';
import { createPost } from '../services/buffer.js';

const TIMEZONE_UTC_OFFSET = env.TIMEZONE_UTC_OFFSET || '-03:00';
const PHOTO_BATCH_DEBOUNCE_MS = 1500;
const pendingBatchTimers = new Map(); // chatId -> NodeJS.Timeout (no se persiste, vive en memoria)

export function createBot() {
  const bot = new Telegraf(requireEnv('TELEGRAM_BOT_TOKEN'));

  bot.start(async (ctx) => {
    const modos = await modosPermitidosParaUsuario(ctx.from.id).catch(() => []);
    if (modos.length === 0) {
      await ctx.reply(
        'Todavía no tenés ningún modo habilitado en la planilla. Pedile a quien armó el bot que agregue tu Telegram ID.'
      );
      return;
    }
    clearState(ctx.chat.id);
    await ctx.reply(
      '¡Hola! Mandame la(s) foto(s) del producto para armar el posteo. Cuando termines de mandar imágenes, seguimos con el modo.'
    );
  });

  bot.on('photo', async (ctx) => {
    const modosPermitidos = await modosPermitidosParaUsuario(ctx.from.id).catch(() => []);
    if (modosPermitidos.length === 0) {
      await ctx.reply('No tenés modos habilitados para usar este bot todavía.');
      return;
    }

    const chatId = ctx.chat.id;
    const best = ctx.message.photo[ctx.message.photo.length - 1];
    const current = getState(chatId) ?? { images: [] };
    const images = [...(current.images ?? []), { fileId: best.file_id, mimeType: 'image/jpeg' }];
    setState(chatId, { step: 'recibiendo_imagenes', images });

    clearTimeout(pendingBatchTimers.get(chatId));
    pendingBatchTimers.set(
      chatId,
      setTimeout(() => {
        pendingBatchTimers.delete(chatId);
        preguntarModo(ctx, chatId).catch((err) => reportarError(ctx, err));
      }, PHOTO_BATCH_DEBOUNCE_MS)
    );
  });

  bot.action(/^modo:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state?.images?.length) {
      await ctx.reply('Mandame primero una imagen antes de elegir el modo.');
      return;
    }
    const modoNombre = ctx.match[1];
    const permitidos = await modosPermitidosParaUsuario(ctx.from.id);
    if (!permitidos.some((m) => m.modo === modoNombre)) {
      await ctx.reply('Ese modo no está habilitado para vos.');
      return;
    }
    setState(chatId, { modo: modoNombre, step: 'esperando_contenido' });
    await ctx.editMessageText(`Modo: ${modoNombre}. Ahora mandame el texto o un audio con la idea.`);
  });

  bot.on('voice', (ctx) => manejarAudio(ctx, ctx.message.voice.file_id, 'audio/ogg'));
  bot.on('audio', (ctx) => manejarAudio(ctx, ctx.message.audio.file_id, ctx.message.audio.mime_type || 'audio/mpeg'));

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state) return;

    if (state.step === 'esperando_contenido') {
      setState(chatId, { texto: ctx.message.text, step: 'esperando_cuando' });
      await preguntarCuando(ctx);
      return;
    }

    if (state.step === 'esperando_fecha') {
      const dueAt = parseFechaHoraLocal(ctx.message.text);
      if (!dueAt) {
        await ctx.reply('No entendí la fecha. Mandala en formato DD/MM/AAAA HH:mm, ej: 25/12/2026 14:30');
        return;
      }
      setState(chatId, { dueAt, step: 'procesando' });
      await finalizar(ctx, chatId);
    }
  });

  bot.action('cuando:ahora', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    setState(chatId, { cuando: 'ahora', dueAt: null, step: 'procesando' });
    await ctx.editMessageText('Dale, lo mando a la cola de revisión ahora.');
    await finalizar(ctx, chatId);
  });

  bot.action('cuando:programar', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    setState(chatId, { cuando: 'programar', step: 'esperando_fecha' });
    await ctx.editMessageText('Mandame la fecha y hora en formato DD/MM/AAAA HH:mm (hora Argentina).');
  });

  return bot;
}

async function preguntarModo(ctx, chatId) {
  const modos = await modosPermitidosParaUsuario(ctx.from.id);
  setState(chatId, { step: 'esperando_modo' });
  const botones = modos.map((m) => Markup.button.callback(m.modo, `modo:${m.modo}`));
  await ctx.reply('¿Qué modo es?', Markup.inlineKeyboard(botones, { columns: 2 }));
}

async function preguntarCuando(ctx) {
  await ctx.reply(
    '¿Cuándo lo publicamos?',
    Markup.inlineKeyboard([
      Markup.button.callback('Ahora', 'cuando:ahora'),
      Markup.button.callback('Programar', 'cuando:programar'),
    ])
  );
}

async function manejarAudio(ctx, fileId, mimeType) {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  if (state?.step !== 'esperando_contenido') return;

  try {
    await ctx.reply('Transcribiendo el audio...');
    const audioBuffer = await descargarArchivoTelegram(ctx, fileId);
    const texto = await transcribeAudio({ audioBuffer, mimeType });
    setState(chatId, { texto, step: 'esperando_cuando' });
    await ctx.reply(`Te escuché: "${texto}"`);
    await preguntarCuando(ctx);
  } catch (err) {
    await reportarError(ctx, err);
  }
}

async function finalizar(ctx, chatId) {
  const state = getState(chatId);
  if (!state?.modo || !state?.images?.length) {
    await ctx.reply('Faltan datos, empezá de nuevo mandando la imagen.');
    clearState(chatId);
    return;
  }

  try {
    await ctx.reply('Armando el posteo con IA, un minuto...');
    const modo = await getModo(state.modo);
    if (!modo) throw new Error(`El modo "${state.modo}" ya no existe en la planilla.`);

    const imagenesFinales = [];
    let mejoraFallo = false;
    for (const img of state.images) {
      const original = await descargarArchivoTelegram(ctx, img.fileId);
      try {
        const { buffer, mimeType } = await enhanceImage({
          promptImagen: modo.promptImagen,
          imageBuffer: original,
          mimeType: img.mimeType,
        });
        imagenesFinales.push(registerImage(buffer, mimeType));
      } catch (err) {
        console.error('Gemini no pudo mejorar la imagen, uso la original:', err.message);
        mejoraFallo = true;
        imagenesFinales.push(registerImage(original, img.mimeType));
      }
    }

    const texto = await generateText({
      promptTexto: modo.promptTexto,
      datosFijos: modo.datosFijos,
      idea: state.texto || '',
    });

    const canales = [
      { red: 'Instagram', id: modo.canalIgBuffer },
      { red: 'TikTok', id: modo.canalTiktokBuffer },
      { red: 'Facebook', id: modo.canalFbBuffer },
    ].filter((c) => c.id);

    if (canales.length === 0) {
      throw new Error(`El modo "${state.modo}" no tiene ningún canal de Buffer configurado.`);
    }

    const resultados = await Promise.allSettled(
      canales.map((c) =>
        createPost({
          channelId: c.id,
          text: texto,
          imageUrls: imagenesFinales.map((i) => i.url),
          dueAt: state.dueAt || null,
        })
      )
    );

    const resumen = canales
      .map((c, i) => {
        const r = resultados[i];
        return r.status === 'fulfilled' ? `✅ ${c.red}` : `❌ ${c.red}: ${r.reason.message}`;
      })
      .join('\n');

    const cuando = state.dueAt ? `programado para ${state.dueAt}` : 'en la cola de revisión (ahora)';
    const avisoImagen = mejoraFallo
      ? '\n⚠️ Gemini no pudo mejorar la imagen (falta facturación habilitada para el modelo de imagen), así que usé la foto original tal cual.'
      : '';
    await ctx.reply(
      `Listo, quedó ${cuando}:\n${resumen}${avisoImagen}\n\nEntrá a Buffer para revisar y publicar cuando quieras.`
    );
  } catch (err) {
    await reportarError(ctx, err);
  } finally {
    clearState(chatId);
  }
}

async function descargarArchivoTelegram(ctx, fileId) {
  const url = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No pude descargar el archivo de Telegram (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function parseFechaHoraLocal(texto) {
  const match = texto.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:00${TIMEZONE_UTC_OFFSET}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}

async function reportarError(ctx, err) {
  console.error(err);
  await ctx.reply(`Uh, algo falló: ${err.message}`);
}
