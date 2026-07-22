import { Telegraf, Markup } from 'telegraf';
import { env, requireEnv } from '../config.js';
import { getState, setState, clearState } from '../state/conversationStore.js';
import { getModo, modosPermitidosParaUsuario } from '../services/sheets.js';
import { enhanceImage, generateText, transcribeAudio, parseFechaHora } from '../services/gemini.js';
import { registerImage } from '../services/mediaHost.js';
import { createPost } from '../services/buffer.js';
import { preguntarModo, descargarArchivoTelegram, reportarError } from './shared.js';
import { registerImageCommands, maybeHandlePhotoCommand } from './imageCommands.js';
import { editImage as cloudflareEditImage } from '../services/cloudflare.js';

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

  registerImageCommands(bot);

  bot.on('photo', async (ctx) => {
    if (await maybeHandlePhotoCommand(ctx)) return;

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
    setState(chatId, { modo: modoNombre, step: 'esperando_mejora_imagen' });
    await ctx.editMessageText(
      `Modo: ${modoNombre}. ¿Querés que mejore la imagen con IA (Gemini)?`,
      Markup.inlineKeyboard([
        Markup.button.callback('Sí, mejorala', 'mejora:si'),
        Markup.button.callback('No, dejala así', 'mejora:no'),
      ])
    );
  });

  bot.action(/^mejora:(si|no)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (state?.step !== 'esperando_mejora_imagen') return;
    const mejorarImagen = ctx.match[1] === 'si';
    setState(chatId, { mejorarImagen, step: 'esperando_contenido' });
    await ctx.editMessageText('Ahora mandame el texto o un audio con la idea.');
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
      const dueAt = parseFechaHoraLocal(ctx.message.text) ?? (await parseFechaHora({
        texto: ctx.message.text,
        ahoraISO: new Date().toISOString(),
        timezoneOffset: TIMEZONE_UTC_OFFSET,
      }).catch(() => null));

      if (!dueAt) {
        await ctx.reply(
          'No entendí esa fecha. Probá algo como "en 2 horas", "mañana a las 10" o "25/12/2026 14:30".'
        );
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
    setState(chatId, { cuando: 'programar' });
    await ctx.editMessageText(
      '¿Para cuándo?',
      Markup.inlineKeyboard(
        [
          Markup.button.callback('En 5 min', 'rapido:5'),
          Markup.button.callback('En 10 min', 'rapido:10'),
          Markup.button.callback('En 30 min', 'rapido:30'),
          Markup.button.callback('En 1 hora', 'rapido:60'),
          Markup.button.callback('Personalizado', 'rapido:custom'),
        ],
        { columns: 2 }
      )
    );
  });

  bot.action(/^rapido:(\d+|custom)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    const valor = ctx.match[1];

    if (valor === 'custom') {
      setState(chatId, { step: 'esperando_fecha' });
      await ctx.editMessageText(
        'Escribime cuándo, como quieras: "en 3 horas", "mañana a las 9", "25/12/2026 14:30", etc.'
      );
      return;
    }

    const minutos = Number(valor);
    const dueAt = new Date(Date.now() + minutos * 60_000).toISOString();
    setState(chatId, { dueAt, step: 'procesando' });
    await ctx.editMessageText(`Dale, lo programo para dentro de ${minutos} minutos.`);
    await finalizar(ctx, chatId);
  });

  return bot;
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
    let mejoradaConCloudflare = false;
    for (const img of state.images) {
      const original = await descargarArchivoTelegram(ctx, img.fileId);
      if (!state.mejorarImagen) {
        imagenesFinales.push(registerImage(original, img.mimeType));
        continue;
      }
      try {
        const { buffer, mimeType } = await enhanceImage({
          promptImagen: modo.promptImagen,
          imageBuffer: original,
          mimeType: img.mimeType,
        });
        imagenesFinales.push(registerImage(buffer, mimeType));
      } catch (geminiErr) {
        console.error('Gemini no pudo mejorar la imagen, pruebo con Cloudflare:', geminiErr.message);
        try {
          const { buffer, mimeType } = await cloudflareEditImage({
            prompt: modo.promptImagen,
            imageBuffer: original,
          });
          imagenesFinales.push(registerImage(buffer, mimeType));
          mejoradaConCloudflare = true;
        } catch (cfErr) {
          console.error('Cloudflare tampoco pudo mejorar la imagen, uso la original:', cfErr.message);
          mejoraFallo = true;
          imagenesFinales.push(registerImage(original, img.mimeType));
        }
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
      ? '\n⚠️ Ni Gemini ni Cloudflare pudieron mejorar la imagen, así que usé la foto original tal cual.'
      : mejoradaConCloudflare
        ? '\nℹ️ Gemini no estaba disponible para la imagen, la mejoré con Cloudflare en su lugar.'
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

function parseFechaHoraLocal(texto) {
  const match = texto.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:00${TIMEZONE_UTC_OFFSET}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}
