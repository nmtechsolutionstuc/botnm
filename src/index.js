import express from 'express';
import { env } from './config.js';
import { createBot } from './bot/handlers.js';
import { mediaRouteHandler } from './services/mediaHost.js';

const app = express();
app.get('/health', (_req, res) => res.send('ok'));
app.get('/media/:id', mediaRouteHandler);

const port = env.PORT || 3000;
app.listen(port, () => console.log(`Health check escuchando en :${port}`));

const bot = createBot();
// bot.launch() resuelve la promesa recién cuando el bot se detiene (no al arrancar),
// por eso usamos el callback onLaunch para confirmar que efectivamente conectó.
bot.launch({}, () => console.log('Bot de Telegram conectado, escuchando por long-polling.')).catch((err) => {
  console.error('El bot se detuvo por un error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
