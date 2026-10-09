import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();

// 1. Ruta de salud pública (para comprobar en navegador sin clave)
app.get('/health', (req, res) => {
  res.status(200).send('OK - Servidor MCP en marcha');
});

// 2. Validación de seguridad (static_headers de Claude)
const API_KEY = process.env.MCP_API_KEY; 
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Petición recibida: ${req.method} ${req.url}`);
  
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (!API_KEY) {
    console.error('ERROR: MCP_API_KEY no está definida en las variables de entorno.');
    return res.status(500).send('Error de configuración en servidor');
  }

  const expectedBearer = `Bearer ${API_KEY}`;
  if (authHeader !== expectedBearer && authHeader !== API_KEY) {
    console.warn(`Autenticación fallida. Recibido: "${authHeader}" | Esperado: "${expectedBearer}"`);
    return res.status(401).send('No autorizado');
  }
  next();
});

// 3. Función para obtener el token de Box (Client Credentials Grant)
async function getBoxToken() {
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
  return data.access_token;
}

// 4. Servidor MCP y gestor de transportes SSE por sesión
const server = new Server(
  { name: 'box-connector', version: '1.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'listar_carpeta',
        description: '[SOLO LECTURA] Consulta y lista los elementos de una carpeta de Box.',
        inputSchema: {
          type: 'object',
          properties: {
            folder_id: { type: 'string', description: 'ID de la carpeta (por defecto "0" para la raíz)' },
            offset: { type: 'number' },
            limit: { type: 'number' }
          }
        }
      },
      {
        name: 'buscar',
        description: '[SOLO LECTURA] Busca archivos y carpetas por texto o nombre en Box.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Término de búsqueda' },
            ancestor_folder_ids: { type: 'string' }
          },
          required: ['query']
        }
      },
      {
        name: 'leer_archivo',
        description: '[SOLO LECTURA] Lee el contenido de texto de un archivo en Box.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' }
          },
          required: ['file_id']
        }
      },
      {
        name: 'ver_imagen',
        description: '[SOLO LECTURA] Obtiene la miniatura/render de una imagen en Box.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' }
          },
          required: ['file_id']
        }
      },
      {
        name: 'info_archivo',
        description: '[SOLO LECTURA] Consulta metadatos de un archivo.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' }
          },
          required: ['file_id']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const token = await getBoxToken();

  switch (name) {
    case 'listar_carpeta': {
      const folderId = args.folder_id || '0';
      const offset = args.offset || 0;
      const limit = Math.min(args.limit || 100, 1000);
      const res = await fetch(`https://api.box.com/2.0/folders/${folderId}/items?offset=${offset}&limit=${limit}&fields=id,type,name,size,modified_at`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'buscar': {
      let url = `https://api.box.com/2.0/search?query=${encodeURIComponent(args.query)}`;
      if (args.ancestor_folder_ids) {
        url += `&ancestor_folder_ids=${encodeURIComponent(args.ancestor_folder_ids)}`;
      }
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'leer_archivo': {
      const res = await fetch(`https://api.box.com/2.0/files/${args.file_id}/content`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Error al leer archivo: ${res.statusText}`);
      const text = await res.text();
      return { content: [{ type: 'text', text: text.slice(0, 50000) }] };
    }

    case 'ver_imagen': {
      const res = await fetch(`https://api.box.com/2.0/files/${args.file_id}/thumbnail.png?min_height=320&min_width=320`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Error al generar miniatura.');
      const buffer = await res.arrayBuffer();
      return {
        content: [{ type: 'image', data: Buffer.from(buffer).toString('base64'), mimeType: 'image/png' }]
      };
    }

    case 'info_archivo': {
      const res = await fetch(`https://api.box.com/2.0/files/${args.file_id}?fields=id,name,description,size,created_at,modified_at,created_by,path_collection`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    default:
      throw new Error(`Herramienta no encontrada: ${name}`);
  }
});

// 5. Manejo de sesiones SSE
const transports = new Map();

app.get('/mcp', async (req, res) => {
  const sessionId = req.query.sessionId || Math.random().toString(36).substring(2);
  const transport = new SSEServerTransport(`/mcp/messages?sessionId=${sessionId}`, res);
  transports.set(sessionId, transport);

  req.on('close', () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId) || Array.from(transports.values())[0];
  
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('Sesión SSE no encontrada');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP escuchando en el puerto ${PORT}`);
});
