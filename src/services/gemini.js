import { GoogleGenAI, Modality } from '@google/genai';
import { env, requireEnv } from '../config.js';

let client = null;
function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
  }
  return client;
}

const IMAGE_MODEL = env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
// "gemini-2.5-flash" quedó bloqueado para proyectos nuevos (404 "no longer available to new users").
// Usamos el alias "-latest" para no depender de un nombre de versión puntual que Google puede retirar.
const TEXT_MODEL = env.GEMINI_TEXT_MODEL || 'gemini-flash-latest';

/**
 * Mejora/regenera una imagen a partir del prompt de estilo del modo.
 * @param {{ promptImagen: string, imageBuffer: Buffer, mimeType: string }} args
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
export async function enhanceImage({ promptImagen, imageBuffer, mimeType }) {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptImagen },
          { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
        ],
      },
    ],
    config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    throw new Error('Gemini no devolvió ninguna imagen generada.');
  }
  return {
    buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}

/**
 * Genera el texto del posteo: tono del modo + hashtags + datos fijos.
 * @param {{ promptTexto: string, datosFijos: string, idea: string }} args
 * @returns {Promise<string>}
 */
export async function generateText({ promptTexto, datosFijos, idea }) {
  const ai = getClient();
  const instrucciones = [
    `Redactá un posteo para redes sociales (Instagram/TikTok/Facebook) en español.`,
    `Tono/estilo: ${promptTexto}`,
    datosFijos ? `Datos fijos que hay que incluir siempre: ${datosFijos}` : null,
    `Idea/base para el posteo: ${idea}`,
    `Agregá 3 a 5 hashtags relevantes al final.`,
    `Devolvé solo el texto final del posteo, sin explicaciones ni comillas.`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: instrucciones,
  });
  return response.text.trim();
}

/**
 * Transcribe una nota de voz de Telegram a texto plano en español.
 * @param {{ audioBuffer: Buffer, mimeType: string }} args
 * @returns {Promise<string>}
 */
export async function transcribeAudio({ audioBuffer, mimeType }) {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribí este audio a texto plano en español. Devolvé solo la transcripción.' },
          { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
        ],
      },
    ],
  });
  return response.text.trim();
}

/**
 * Interpreta una fecha/hora escrita libremente ("dentro de 5 horas", "mañana a las 9", "25/12 20:00")
 * y la convierte a ISO 8601 UTC. Devuelve null si no pudo interpretar una fecha futura válida.
 * @param {{ texto: string, ahoraISO: string, timezoneOffset: string }} args
 * @returns {Promise<string|null>}
 */
export async function parseFechaHora({ texto, ahoraISO, timezoneOffset }) {
  const ai = getClient();
  const prompt = [
    `La fecha y hora actual es ${ahoraISO} (offset horario local: ${timezoneOffset}).`,
    `El usuario quiere programar una publicación y escribió: "${texto}"`,
    `Devolvé ÚNICAMENTE la fecha y hora resultante en formato ISO 8601 UTC (terminada en Z), sin texto adicional, sin explicaciones.`,
    `Si no se puede interpretar una fecha/hora futura válida a partir de ese texto, devolvé exactamente: INVALIDO`,
  ].join('\n');

  const response = await ai.models.generateContent({ model: TEXT_MODEL, contents: prompt });
  const raw = response.text.trim();
  if (raw === 'INVALIDO') return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}
