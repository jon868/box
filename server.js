import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const mcp = new McpServer({ name: "box-connector", version: "1.0.0" });

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
  return data.access_token; // Este token dura 60 minutos
}

// 3. Endpoint del transporte MCP (Streamable HTTP / SSE)
let transport;
app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/mcp/messages', res);
  await mcp.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

// Ejemplo: Definir una tool de prueba
mcp.tool("listar_carpeta", "Lista los archivos de una carpeta de Box", async () => {
   const token = await getBoxToken();
   // Aquí iría la llamada a la API normal de Box (https://api.box.com/2.0/...) usando el token
   return { content: [{ type: "text", text: "Conexión a Box exitosa" }] };
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP escuchando en puerto ${PORT}`);
});
