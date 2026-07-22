# makebufferbot

Bot de Telegram para MBDA Modas / Qué Pinta / IA / Productos Digitales. Reemplaza el diseño original en Make.com por un bot propio: recibe fotos + texto/audio por Telegram, mejora imagen y texto con Gemini según el "modo" configurado en una Google Sheet, y crea el borrador en Buffer para que lo revises y publiques a mano.

## 1. Cómo funciona

1. Le mandás al bot una o varias fotos.
2. El bot pregunta el **modo** con botones (leídos de la Google Sheet).
3. Mandás el texto o un audio con la idea (se transcribe solo con Gemini).
4. El bot pregunta "Ahora" o "Programar" (con fecha y hora).
5. Gemini mejora la imagen y redacta el texto + hashtags + datos fijos del modo.
6. Se crea el posteo en Buffer en cada canal configurado para ese modo (Instagram/TikTok/Facebook), como pendiente de aprobación — **nunca se autopublica**.
7. El bot te confirma por Telegram qué quedó listo.
8. Entrás a Buffer, revisás y publicás cuando quieras.

## 2. Lo que ya está armado en este repo

- `src/index.js` — arranca el servidor (`/health`, `/media/:id`) y el bot.
- `src/bot/handlers.js` — todo el flujo de conversación.
- `src/services/sheets.js` — lee los modos desde Google Sheets.
- `src/services/gemini.js` — mejora de imagen, generación de texto y transcripción de audio.
- `src/services/buffer.js` — crea los posteos en Buffer (API GraphQL).
- `src/services/mediaHost.js` — sirve temporalmente las imágenes generadas para que Buffer las pueda descargar (Buffer exige una URL pública, no acepta subir bytes directo).
- `src/state/conversationStore.js` — guarda en qué paso está cada conversación (`data/state.json`).

Las 3 keys que ya pasaste (Telegram, Gemini, Buffer) están guardadas en `.env` (no se suben a git).

## 3. Lo que todavía tenés que hacer vos

### 3.1 Google Sheet de "modos"

1. Creá una Google Sheet nueva con esta fila de encabezados exacta en la fila 1:

   ```
   modo | canal_ig_buffer | canal_tiktok_buffer | canal_fb_buffer | prompt_imagen | prompt_texto | datos_fijos | usuarios_permitidos
   ```

2. Completá al menos la fila `tienda` (los `canal_..._buffer` los sacás del paso 3.2). En `usuarios_permitidos` poné tu Telegram ID separado por coma si hay más de uno permitido (vacío = cualquiera puede usar ese modo). Para conseguir tu Telegram ID hablale a `@userinfobot` en Telegram.
3. Copiá el ID de la planilla (la parte de la URL entre `/d/` y `/edit`) y pegalo en `.env` como `GOOGLE_SHEET_ID`.

### 3.2 Cuenta de servicio de Google (para leer la Sheet sin login manual)

1. Andá a [Google Cloud Console](https://console.cloud.google.com/) → creá un proyecto nuevo (gratis).
2. Habilitá la **Google Sheets API** (buscarla en "APIs & Services" → "Enable APIs").
3. "APIs & Services" → "Credentials" → "Create Credentials" → "Service Account". Nombre libre, sin permisos de proyecto adicionales.
4. Entrá a la cuenta de servicio creada → pestaña "Keys" → "Add key" → "JSON". Se descarga un archivo.
5. Renombrá ese archivo a `google-service-account.json` y ponelo en la raíz de este repo (ya está en `.gitignore`, no se sube a git).
6. Copiá el email de la cuenta de servicio (termina en `...gserviceaccount.com`, está en el JSON como `client_email`) y **compartí tu Google Sheet con ese email** (como Editor).

### 3.3 Buffer: canales y aprobación

1. En [buffer.com](https://buffer.com), conectá Instagram, TikTok y Facebook de la tienda (plan free permite hasta 3 canales).
2. En cada canal conectado, activá **"Requiere aprobación"** en su configuración — así el bot puede crear el posteo pero nunca se publica solo.
3. Una vez que tengas `GOOGLE_SHEET_ID` (no hace falta) y el token de Buffer en `.env`, corré:

   ```bash
   npm run list-channels
   ```

   Esto imprime el `id` de cada canal conectado. Copiá esos IDs a las columnas `canal_ig_buffer`, `canal_tiktok_buffer`, `canal_fb_buffer` de la fila correspondiente en la Sheet.

### 3.4 Verificar que la Sheet se lee bien

```bash
npm run list-modos
```

Tiene que imprimir el JSON con la fila `tienda` completa. Si da error, revisá `GOOGLE_SHEET_ID`, que hayas compartido la Sheet con el email de la cuenta de servicio, y que los headers de la fila 1 sean exactos.

## 4. Correr el bot en tu máquina

```bash
npm install   # ya lo corrí yo, pero por si acaso
npm start
```

Mandale una foto al bot por Telegram (buscalo como el usuario que armamos: revisá con `@BotFather` o `/setname` cuál le pusiste) y seguí el flujo. Vas a necesitar `PUBLIC_BASE_URL` apuntando a una URL pública (ver sección de deploy) para que el paso de Buffer funcione — probando en tu máquina sin esa URL, vas a ver que Gemini mejora la imagen pero Buffer va a fallar al no poder descargarla.

## 5. Deploy a Render (para que corra 24/7)

1. Subí este repo a GitHub (privado está bien).
2. En [Render.com](https://render.com), "New" → "Web Service" → conectá el repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Cargá todas las variables de `.env` en la sección "Environment" de Render. Para la cuenta de servicio de Google, **no** uses `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (Render no tiene ese archivo) — en su lugar creá una variable `GOOGLE_SERVICE_ACCOUNT_JSON` y pegá ahí el contenido completo del JSON descargado en el paso 3.2 (el código ya soporta las dos formas: archivo local en tu máquina, variable de entorno en Render).
5. Una vez desplegado, Render te da una URL pública (ej: `https://makebufferbot.onrender.com`). Pegala como `PUBLIC_BASE_URL` en las env vars de Render.
6. **Importante**: el plan free de Render duerme el servicio tras 15 min sin requests entrantes, lo que cortaría el long-polling de Telegram. Solución: creá una cuenta gratis en [UptimeRobot](https://uptimerobot.com) y configurá un monitor HTTP que pegue a `https://tu-app.onrender.com/health` cada 5-10 minutos.

## 6. Agregar modos nuevos (IA, Qué Pinta, Digitales)

Sin tocar código: agregá una fila nueva a la Google Sheet con su propio `prompt_imagen`, `prompt_texto`, `datos_fijos`, canales de Buffer y `usuarios_permitidos`. El bot los va a ofrecer automáticamente como botón la próxima vez que alguien mande una foto (el cache de la Sheet dura 30 segundos).

## 7. Costos reales

| Servicio | Costo | Riesgo de cobro sin querer |
|---|---|---|
| Telegram | $0 siempre | Ninguno |
| Render (plan free) | $0 | Ninguno |
| UptimeRobot (plan free) | $0 | Ninguno |
| Google Sheets + Cloud service account | $0 | Ninguno |
| Gemini API | $0 con límite diario | Ninguno si no cargás tarjeta en Google Cloud |
| Buffer | $0 hasta 3 canales | Se paga solo si sumás más de 3 canales (~$5-6 USD/canal/mes) |

Con 3 canales (ej. IG + TikTok + Facebook de la tienda) el sistema queda en $0 de punta a punta.
