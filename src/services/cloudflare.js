import { env, requireEnv } from '../config.js';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';

/** Permite apagar toda la función de imágenes de Cloudflare sin tocar código (CLOUDFLARE_IMAGES_ENABLED=false). */
export function cloudflareImagesEnabled() {
  return env.CLOUDFLARE_IMAGES_ENABLED !== 'false';
}

async function runWorkersAI(model, body) {
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (!res.ok || json.success === false) {
      const msg = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare Workers AI error (${model}): ${msg}`);
    }
    const base64 = json.result?.image;
    if (!base64) throw new Error(`Cloudflare Workers AI (${model}) no devolvió ninguna imagen.`);
    return { buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg' };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudflare Workers AI error (${model}): HTTP ${res.status} ${text}`.trim());
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType || 'image/png' };
}

/** Genera una imagen nueva a partir de una descripción de texto. */
export async function generateImage({ prompt }) {
  return runWorkersAI(IMAGE_MODEL, { prompt });
}

/**
 * Edita una imagen existente según instrucciones (image-to-image).
 * @param {{ prompt: string, imageBuffer: Buffer, strength?: number }} args
 */
export async function editImage({ prompt, imageBuffer, strength = 0.45 }) {
  return runWorkersAI(EDIT_MODEL, {
    prompt,
    image_b64: imageBuffer.toString('base64'),
    strength,
    num_steps: 20,
  });
}

/**
 * Pasada de "mejora de calidad": no es un upscaler real (Cloudflare no tiene un modelo
 * de super-resolución en su catálogo), es una refinada generativa con strength bajo
 * para no alterar demasiado la composición original.
 * @param {{ imageBuffer: Buffer }} args
 */
export async function enhanceQuality({ imageBuffer }) {
  return editImage({
    prompt: 'Máxima nitidez y calidad, alta resolución, detalles definidos, sin ruido, sin artefactos',
    imageBuffer,
    strength: 0.3,
  });
}
