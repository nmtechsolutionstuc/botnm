import { listModos } from '../src/services/sheets.js';

const modos = await listModos({ forceRefresh: true });
if (modos.length === 0) {
  console.log('No se encontró ningún modo en la planilla (revisá GOOGLE_SHEET_ID y que la fila 1 tenga los headers correctos).');
} else {
  console.log('Modos encontrados en la planilla:\n');
  console.log(JSON.stringify(modos, null, 2));
}
