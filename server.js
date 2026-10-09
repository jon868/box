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

// 2. Función para obtener el token de Box (Client Credentials Grant)
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

// 3. Servidor MCP
const server = new Server(
  { name: 'box-connector', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

// Declarar las 5 herramientas disponibles para Claude
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'listar_carpeta',
        description: 'Lista los elementos de una carpeta de Box con paginación',
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
        description: 'Busca archivos y carpetas por texto o nombre en Box',
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
        description: 'Lee el contenido o texto de un archivo en Box',
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
        description: 'Obtiene la vista previa o miniatura de una imagen/render en Box',
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
        description: 'Obtiene metadatos de un archivo (fecha, tamaño, autor, ruta)',
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

// Ejecución de las herramientas según la llamada de Claude
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
      if (!res.ok) {
        throw new Error(`No se pudo leer el archivo: ${res.statusText}`);
      }
      const text = await res.text();
      return { content: [{ type: 'text', text: text.slice(0, 50000) }] };
    }

    case 'ver_imagen': {
      const res = await fetch(`https://api.box.com/2.0/files/${args.file_id}/thumbnail.png?min_height=320&min_width=320`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error('No se pudo generar la vista previa de la imagen.');
      }
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return {
        content: [
          {
            type: 'image',
            data: base64,
            mimeType: 'image/png'
          }
        ]
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

// 4. Transporte HTTP / SSE
let transport;
app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/mcp/messages', res);
  await server.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('Transporte SSE no inicializado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP escuchando en puerto ${PORT}`);
});
