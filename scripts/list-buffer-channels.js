import { listChannels } from '../src/services/buffer.js';

const channels = await listChannels();
if (channels.length === 0) {
  console.log('No hay canales conectados en Buffer todavía.');
} else {
  console.log('Canales conectados en Buffer:\n');
  for (const c of channels) {
    console.log(`- ${c.name} (${c.service}) -> id: ${c.id}`);
  }
}
