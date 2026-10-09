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

// 3. Definición del servidor MCP
const server = new Server(
  { name: 'box-connector', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Declarar las herramientas disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'listar_carpeta',
        description: 'Lista los elementos dentro de una carpeta de Box',
        inputSchema: {
          type: 'object',
          properties: {
            folder_id: { type: 'string', description: 'ID de la carpeta de Box (usa "0" para la raíz)' }
          }
        }
      }
    ]
  };
});

// Ejecución de las herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'listar_carpeta') {
    const folderId = request.params.arguments?.folder_id || '0';
    const token = await getBoxToken();
    
    const boxRes = await fetch(`https://api.box.com/2.0/folders/${folderId}/items`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const boxData = await boxRes.json();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(boxData, null, 2)
        }
      ]
    };
  }
  throw new Error(`Herramienta no encontrada: ${request.params.name}`);
});

// 4. Transporte HTTP / SSE para Claude
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
