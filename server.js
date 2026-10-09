import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();

// 1. Validación de seguridad (static_headers de Claude)
const API_KEY = process.env.MCP_API_KEY;
app.use((req, res, next) => {
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (authHeader !== `Bearer ${API_KEY}` && authHeader !== API_KEY) {
    return res.status(401).send('No autorizado');
  }
  next();
});

// 2. Token de Box (Client Credentials Grant) con caché
let cachedToken = null;
let tokenExpiresAt = 0;

async function getBoxToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.BOX_CLIENT_ID,
    client_secret: process.env.BOX_CLIENT_SECRET,
    box_subject_type: 'enterprise',
    box_subject_id: process.env.BOX_ENTERPRISE_ID
  });

  const response = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Error de autenticación Box: ${JSON.stringify(data)}`);
  }
  cachedToken = data.access_token;
  // Renovar 5 minutos antes de que caduque
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 300) * 1000;
  return cachedToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera a que Box tenga lista una representación (texto extraído, JPG...).
// Estado "none" = Box aún no la ha generado: se genera al pedirla, así que
// se solicita y luego se consulta su estado hasta que esté lista (~30 s máx).
async function esperarRepresentacion(rep, auth) {
  let state = rep.status?.state;
  if (state === 'success') return state;
  if (state === 'none') {
    const urlContenido = rep.content.url_template.replace('{+asset_path}', '');
    await fetch(rep.info.url, { headers: auth });
    await fetch(urlContenido, { headers: auth }); // dispara la generación (devuelve 202)
  }
  for (let i = 0; i < 20; i++) {
    const st = await fetch(rep.info.url, { headers: auth }).then((r) => r.json());
    state = st.status?.state;
    if (state === 'success' || state === 'error') break;
    await sleep(1500);
  }
  return state;
}

// Lee el texto de cualquier archivo (PDF, DOCX, XLSX, PPTX...) usando la
// representación "extracted_text" de Box. Para texto plano lee el contenido directo.
async function leerTextoArchivo(fileId, token) {
  const auth = { Authorization: `Bearer ${token}` };
  const TEXTO_PLANO = ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'js', 'php', 'css', 'log', 'yml', 'yaml'];

  const infoRes = await fetch(
    `https://api.box.com/2.0/files/${fileId}?fields=name,extension,representations`,
    { headers: { ...auth, 'x-rep-hints': '[extracted_text]' } }
  );
  if (!infoRes.ok) throw new Error(`No se pudo consultar el archivo: ${infoRes.status} ${infoRes.statusText}`);
  const info = await infoRes.json();
  const ext = (info.extension || '').toLowerCase();

  if (TEXTO_PLANO.includes(ext)) {
    const res = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, { headers: auth });
    if (!res.ok) throw new Error(`No se pudo leer el archivo: ${res.statusText}`);
    return await res.text();
  }

  const rep = info.representations?.entries?.find((e) => e.representation === 'extracted_text');
  if (!rep) {
    return `[${info.name}] Box no ofrece extracción de texto para archivos .${ext}. Si es una imagen, usa ver_imagen.`;
  }

  const state = await esperarRepresentacion(rep, auth);
  if (state !== 'success') {
    return `[${info.name}] Box no ha podido extraer el texto (estado: ${state}).`;
  }

  const url = rep.content.url_template.replace('{+asset_path}', '');
  const textRes = await fetch(url, { headers: auth });
  if (!textRes.ok) throw new Error(`No se pudo descargar el texto extraído: ${textRes.statusText}`);
  return await textRes.text();
}

// Vista previa de una imagen/documento.
// 1) Miniatura JPG de 320 px (los PNG de Box solo existen a 1024/2048 px).
// 2) Si no hay miniatura, representación JPG de 1024x1024.
async function obtenerVistaPrevia(fileId, token) {
  const auth = { Authorization: `Bearer ${token}` };
  const aBase64 = async (res) => Buffer.from(await res.arrayBuffer()).toString('base64');
  let ultimoError = '';

  // 1) Miniatura (202 = Box la está generando; reintentar)
  for (let i = 0; i < 4; i++) {
    const res = await fetch(
      `https://api.box.com/2.0/files/${fileId}/thumbnail.jpg?min_width=320&min_height=320`,
      { headers: auth, redirect: 'manual' }
    );
    if (res.status === 200) return { data: await aBase64(res), mimeType: 'image/jpeg' };
    if (res.status === 202) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    ultimoError = `miniatura: HTTP ${res.status}`;
    break; // 302 = Box no puede generarla (redirige a un icono genérico)
  }

  // 2) Representación JPG 1024x1024
  const infoRes = await fetch(
    `https://api.box.com/2.0/files/${fileId}?fields=name,representations`,
    { headers: { ...auth, 'x-rep-hints': '[jpg?dimensions=1024x1024]' } }
  );
  if (!infoRes.ok) throw new Error(`No se pudo consultar el archivo (${ultimoError}; info: HTTP ${infoRes.status})`);
  const info = await infoRes.json();
  const rep = info.representations?.entries?.find((e) => e.representation === 'jpg');
  if (!rep) throw new Error(`Box no ofrece vista previa para "${info.name}" (${ultimoError})`);

  const state = await esperarRepresentacion(rep, auth);
  if (state !== 'success') throw new Error(`Box no ha podido generar la vista previa de "${info.name}" (estado: ${state})`);

  const imgRes = await fetch(rep.content.url_template.replace('{+asset_path}', ''), { headers: auth });
  if (!imgRes.ok) throw new Error(`No se pudo descargar la vista previa: HTTP ${imgRes.status}`);
  return { data: await aBase64(imgRes), mimeType: 'image/jpeg' };
}

// 3. Servidor MCP (se crea uno por cada conexión)
function crearServidor() {
const server = new Server(
  { name: 'box-connector', version: '1.3.0' },
  { capabilities: { tools: {} } }
);

// Anotaciones MCP estándar: indican al cliente que la herramienta solo lee
const SOLO_LECTURA = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'listar_carpeta',
        description: '[SOLO LECTURA] Lista los elementos de una carpeta de Box con paginación.',
        annotations: { title: 'Listar carpeta de Box', ...SOLO_LECTURA },
        inputSchema: {
          type: 'object',
          properties: {
            folder_id: { type: 'string', description: 'ID de la carpeta (por defecto "0" para la raíz)' },
            offset: { type: 'number', description: 'Índice de inicio para paginación (por defecto 0)' },
            limit: { type: 'number', description: 'Número de elementos a recuperar (máx 1000)' }
          }
        }
      },
      {
        name: 'buscar',
        description: '[SOLO LECTURA] Busca archivos y carpetas por texto o nombre en Box.',
        annotations: { title: 'Buscar en Box', ...SOLO_LECTURA },
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Término de búsqueda (ej. "Canarias" o "GESPLAN")' },
            ancestor_folder_ids: { type: 'string', description: 'ID de carpeta raíz donde acotar la búsqueda (opcional)' }
          },
          required: ['query']
        }
      },
      {
        name: 'leer_archivo',
        description: '[SOLO LECTURA] Lee el texto de un archivo de Box (PDF, Word, Excel, PowerPoint, texto plano...).',
        annotations: { title: 'Leer archivo de Box', ...SOLO_LECTURA },
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'ID del archivo en Box' }
          },
          required: ['file_id']
        }
      },
      {
        name: 'ver_imagen',
        description: '[SOLO LECTURA] Obtiene la vista previa o miniatura de una imagen/render en Box.',
        annotations: { title: 'Ver imagen de Box', ...SOLO_LECTURA },
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'ID del archivo de imagen en Box' }
          },
          required: ['file_id']
        }
      },
      {
        name: 'info_archivo',
        description: '[SOLO LECTURA] Consulta metadatos de un archivo (fecha, tamaño, autor, ruta).',
        annotations: { title: 'Info de archivo de Box', ...SOLO_LECTURA },
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'ID del archivo en Box' }
          },
          required: ['file_id']
        }
      }
    ]
  };
});

// Ejecución de las herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const token = await getBoxToken();
  const auth = { Authorization: `Bearer ${token}` };

  switch (name) {
    case 'listar_carpeta': {
      const folderId = args.folder_id || '0';
      const offset = args.offset || 0;
      const limit = Math.min(args.limit || 100, 1000);
      const res = await fetch(
        `https://api.box.com/2.0/folders/${folderId}/items?offset=${offset}&limit=${limit}&fields=id,type,name,size,modified_at`,
        { headers: auth }
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'buscar': {
      let url = `https://api.box.com/2.0/search?query=${encodeURIComponent(args.query)}`;
      if (args.ancestor_folder_ids) {
        url += `&ancestor_folder_ids=${encodeURIComponent(args.ancestor_folder_ids)}`;
      }
      const res = await fetch(url, { headers: auth });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'leer_archivo': {
      const text = await leerTextoArchivo(args.file_id, token);
      return { content: [{ type: 'text', text: text.slice(0, 50000) }] };
    }

    case 'ver_imagen': {
      const { data, mimeType } = await obtenerVistaPrevia(args.file_id, token);
      return { content: [{ type: 'image', data, mimeType }] };
    }

    case 'info_archivo': {
      const res = await fetch(
        `https://api.box.com/2.0/files/${args.file_id}?fields=id,name,description,size,created_at,modified_at,created_by,path_collection`,
        { headers: auth }
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    default:
      throw new Error(`Herramienta no encontrada: ${name}`);
  }
});

return server;
}

// 4. Transporte HTTP / SSE — un transporte por sesión (antes había uno global
// y una segunda conexión pisaba a la primera)
const transports = {};

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await crearServidor().connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('Sesión SSE no encontrada');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP escuchando en puerto ${PORT}`);
});
