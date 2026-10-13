// Box_alegria — servidor MCP para Box con cuenta de servicio (Client Credentials Grant)
//
// Todos los usuarios de Claude comparten el mismo acceso a Box: el de la cuenta de
// servicio de la app. Nadie inicia sesión en Box; el servidor obtiene y renueva el token
// por su cuenta. El acceso al servidor se protege con MCP_SECRET.

import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const env = process.env;
const CFG = {
  port: Number(env.PORT || 3000),
  clientId: env.BOX_CLIENT_ID,
  clientSecret: env.BOX_CLIENT_SECRET,
  enterpriseId: env.BOX_ENTERPRISE_ID, // actuar como la cuenta de servicio (recomendado)
  userId: env.BOX_USER_ID, // alternativa: actuar como un usuario concreto de Box
  mcpSecret: env.MCP_SECRET,
  allowNoAuth: env.ALLOW_NO_AUTH === "true",
  enableWrite: env.ENABLE_WRITE === "true",
  allowedFolders: (env.BOX_ALLOWED_FOLDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  apiBase: env.BOX_API_BASE || "https://api.box.com/2.0",
  uploadBase: env.BOX_UPLOAD_BASE || "https://upload.box.com/api/2.0",
  tokenUrl: env.BOX_TOKEN_URL || "https://api.box.com/oauth2/token",
};

function checkConfig() {
  const missing = [];
  if (!CFG.clientId) missing.push("BOX_CLIENT_ID");
  if (!CFG.clientSecret) missing.push("BOX_CLIENT_SECRET");
  if (!CFG.enterpriseId && !CFG.userId) missing.push("BOX_ENTERPRISE_ID (o BOX_USER_ID)");
  if (!CFG.mcpSecret && !CFG.allowNoAuth) missing.push("MCP_SECRET");
  if (CFG.mcpSecret && CFG.mcpSecret.length < 24)
    missing.push("MCP_SECRET (mínimo 24 caracteres)");
  if (missing.length) {
    console.error(`Faltan variables de entorno: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Token de Box (Client Credentials Grant) con caché y renovación automática
// ---------------------------------------------------------------------------
let tokenCache = { token: null, expiresAt: 0 };
let tokenPromise = null;

async function fetchToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CFG.clientId,
    client_secret: CFG.clientSecret,
    box_subject_type: CFG.userId ? "user" : "enterprise",
    box_subject_id: CFG.userId || CFG.enterpriseId,
  });
  const res = await fetch(CFG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `No se pudo obtener el token de Box (${res.status}): ${data.error_description || data.error || "respuesta inesperada"}`
    );
  }
  tokenCache = {
    token: data.access_token,
    // renovar 2 minutos antes de que caduque
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 120) * 1000,
  };
  return tokenCache.token;
}

async function getToken(force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (!tokenPromise) tokenPromise = fetchToken().finally(() => (tokenPromise = null));
  return tokenPromise;
}

// ---------------------------------------------------------------------------
// Cliente HTTP de Box: reintenta en 401 (token) y 429/5xx (límite de peticiones)
// ---------------------------------------------------------------------------
class BoxError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function box(path, { method = "GET", query, body, headers = {}, base, raw = false, redirect } = {}) {
  const url = new URL((base || CFG.apiBase) + path);
  if (query)
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getToken();
    const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers }, redirect };
    if (body !== undefined) {
      if (body instanceof FormData || typeof body === "string" || body instanceof Uint8Array) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] = "application/json";
      }
    }
    const res = await fetch(url, init);

    if (res.status === 401 && attempt === 0) {
      await getToken(true);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 2 ** attempt), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.message || data?.code || res.statusText;
      throw new BoxError(res.status, `Box respondió ${res.status}: ${msg}`, data);
    }
    return data;
  }
  throw new BoxError(503, "Box no responde tras varios reintentos");
}

// ---------------------------------------------------------------------------
// Restricción opcional a carpetas permitidas (BOX_ALLOWED_FOLDER_IDS)
// ---------------------------------------------------------------------------
const ITEM_FIELDS =
  "id,type,name,size,description,created_at,modified_at,path_collection,parent,extension,shared_link,item_status";

function isAllowed(item) {
  if (!CFG.allowedFolders.length) return true;
  if (CFG.allowedFolders.includes(String(item.id)) && item.type === "folder") return true;
  const ancestors = (item.path_collection?.entries || []).map((e) => String(e.id));
  return ancestors.some((id) => CFG.allowedFolders.includes(id));
}

async function getItem(type, id) {
  const item = await box(`/${type}s/${encodeURIComponent(id)}`, { query: { fields: ITEM_FIELDS } });
  if (!isAllowed(item)) throw new BoxError(403, `El ${type === "file" ? "archivo" : "elemento"} ${id} está fuera de las carpetas permitidas`);
  return item;
}

const pathOf = (item) =>
  [...(item.path_collection?.entries || []).map((e) => e.name), item.name].join(" / ");

const slim = (it) => ({
  id: it.id,
  type: it.type,
  name: it.name,
  ...(it.size !== undefined && { size: it.size }),
  ...(it.modified_at && { modified_at: it.modified_at }),
  ...(it.path_collection && { path: pathOf(it) }),
});

// ---------------------------------------------------------------------------
// Utilidades de contenido
// ---------------------------------------------------------------------------
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "css", "js", "ts",
  "py", "yml", "yaml", "ini", "log", "sql", "svg", "srt", "vtt", "rtf",
]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "webp", "heic", "psd", "ai", "eps"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pide una representación (extracted_text, jpg…) y espera a que esté lista.
async function getRepresentation(fileId, hint) {
  const info = await box(`/files/${encodeURIComponent(fileId)}`, {
    query: { fields: "representations" },
    headers: { "x-rep-hints": hint },
  });
  const rep = info?.representations?.entries?.[0];
  if (!rep) return null;

  let status = rep.status?.state;
  let urlTemplate = rep.content?.url_template;
  const deadline = Date.now() + 25_000;
  while (status === "pending" || status === "none") {
    if (Date.now() > deadline) throw new BoxError(504, "Box sigue generando el contenido; vuelve a intentarlo en unos segundos");
    // Pedir la generación (status none) o consultar el progreso (pending)
    const r = await box("", { base: rep.info.url, raw: true });
    const d = await r.json().catch(() => ({}));
    status = d?.status?.state || status;
    urlTemplate = d?.content?.url_template || urlTemplate;
    if (status !== "success") await sleep(1500);
  }
  if (status !== "success") throw new BoxError(422, `Box no pudo generar la representación (${status})`);
  const res = await box("", { base: urlTemplate.replace("{+asset_path}", ""), raw: true });
  if (!res.ok) throw new BoxError(res.status, `Error descargando representación (${res.status})`);
  return res;
}

async function downloadFile(fileId) {
  const res = await box(`/files/${encodeURIComponent(fileId)}/content`, { raw: true });
  if (!res.ok) throw new BoxError(res.status, `Error descargando el archivo (${res.status})`);
  return res;
}

// ---------------------------------------------------------------------------
// Herramientas MCP
// ---------------------------------------------------------------------------
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    console.error("[tool error]", e.message);
    return fail(e);
  }
};

function buildServer() {
  const server = new McpServer({ name: "Box_alegria", version: "2.0.0" });
  const RO = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "box_list_folder",
    {
      title: "Listar carpeta de Box",
      description:
        'Lista el contenido de una carpeta de Box. Usa folder_id "0" para la raíz (o, si hay carpetas restringidas, para ver las carpetas permitidas).',
      inputSchema: {
        folder_id: z.string().default("0").describe("ID de la carpeta. '0' = raíz"),
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      },
      annotations: RO,
    },
    safe(async ({ folder_id, limit, offset }) => {
      if (folder_id === "0" && CFG.allowedFolders.length) {
        const folders = await Promise.all(CFG.allowedFolders.map((id) => getItem("folder", id).catch((e) => ({ id, error: e.message }))));
        return ok({ note: "Carpetas permitidas para este conector", items: folders.map((f) => (f.error ? f : slim(f))) });
      }
      const folder = folder_id === "0" ? { name: "Raíz", path_collection: { entries: [] } } : await getItem("folder", folder_id);
      const data = await box(`/folders/${encodeURIComponent(folder_id)}/items`, {
        query: { limit, offset, fields: "id,type,name,size,modified_at,extension" },
      });
      return ok({
        folder: { id: folder_id, path: pathOf(folder) },
        total_count: data.total_count,
        offset,
        items: data.entries.map(slim),
      });
    })
  );

  server.registerTool(
    "box_search",
    {
      title: "Buscar en Box",
      description:
        "Busca archivos y carpetas en Box por nombre, descripción o contenido. Admite filtrar por tipo, extensión y carpeta.",
      inputSchema: {
        query: z.string().min(1).describe("Texto a buscar. Entre comillas para frase exacta"),
        type: z.enum(["file", "folder", "web_link"]).optional(),
        file_extensions: z.array(z.string()).optional().describe("p. ej. ['pdf','jpg']"),
        ancestor_folder_ids: z.array(z.string()).optional().describe("Limitar la búsqueda a estas carpetas"),
        content_types: z
          .array(z.enum(["name", "description", "file_content", "comments", "tag"]))
          .optional()
          .describe("Dónde buscar. Por defecto, en todo"),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).default(0),
      },
      annotations: RO,
    },
    safe(async ({ query, type, file_extensions, ancestor_folder_ids, content_types, limit, offset }) => {
      let ancestors = ancestor_folder_ids;
      if (CFG.allowedFolders.length) {
        if (ancestors?.length) await Promise.all(ancestors.map((id) => getItem("folder", id)));
        else ancestors = CFG.allowedFolders;
      }
      const data = await box("/search", {
        query: {
          query,
          type,
          file_extensions: file_extensions?.map((e) => e.replace(/^\./, "")).join(","),
          ancestor_folder_ids: ancestors?.join(","),
          content_types: content_types?.join(","),
          limit,
          offset,
          fields: "id,type,name,size,modified_at,path_collection,extension",
        },
      });
      return ok({ total_count: data.total_count, offset, items: data.entries.filter(isAllowed).map(slim) });
    })
  );

  server.registerTool(
    "box_get_item",
    {
      title: "Detalles de un archivo o carpeta",
      description: "Devuelve los metadatos de un archivo o carpeta de Box (ruta, tamaño, fechas, descripción).",
      inputSchema: {
        id: z.string(),
        type: z.enum(["file", "folder"]).default("file"),
      },
      annotations: RO,
    },
    safe(async ({ id, type }) => {
      const it = await getItem(type, id);
      return ok({ ...slim(it), description: it.description || undefined, created_at: it.created_at, extension: it.extension });
    })
  );

  server.registerTool(
    "box_read_file",
    {
      title: "Leer el texto de un archivo",
      description:
        "Devuelve el texto de un archivo de Box: directamente si es texto plano (txt, md, csv, json…) o el texto extraído por Box en PDF, Word, Excel, PowerPoint, etc.",
      inputSchema: {
        file_id: z.string(),
        max_chars: z.number().int().min(1000).max(500_000).default(100_000),
      },
      annotations: RO,
    },
    safe(async ({ file_id, max_chars }) => {
      const f = await getItem("file", file_id);
      const ext = (f.extension || "").toLowerCase();
      let text;
      if (TEXT_EXT.has(ext) && f.size <= 10 * 1024 * 1024) {
        text = await (await downloadFile(file_id)).text();
      } else {
        const res = await getRepresentation(file_id, "[extracted_text]");
        if (!res)
          return fail(
            `Box no ofrece texto extraído para «${f.name}» (.${ext}). Para imágenes usa box_get_image; para otros formatos, box_get_download_link.`
          );
        text = await res.text();
      }
      const truncated = text.length > max_chars;
      return ok(
        `Archivo: ${pathOf(f)} (id ${f.id})\n` +
          (truncated ? `[Mostrando ${max_chars} de ${text.length} caracteres]\n` : "") +
          "\n" +
          text.slice(0, max_chars)
      );
    })
  );

  server.registerTool(
    "box_get_image",
    {
      title: "Ver una imagen",
      description:
        "Devuelve una imagen de Box para que Claude la vea (JPG/PNG/HEIC/PSD/PDF… convertida por Box a JPG). Para el archivo original a máxima calidad usa box_get_download_link.",
      inputSchema: {
        file_id: z.string(),
        size: z.enum(["320", "1024", "2048"]).default("1024").describe("Lado máximo en píxeles"),
      },
      annotations: RO,
    },
    safe(async ({ file_id, size }) => {
      const f = await getItem("file", file_id);
      const res = await getRepresentation(file_id, `[jpg?dimensions=${size}x${size}]`);
      if (!res) return fail(`Box no puede generar una vista previa de «${f.name}».`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          { type: "text", text: `${pathOf(f)} (id ${f.id})` },
          { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    })
  );

  server.registerTool(
    "box_get_download_link",
    {
      title: "Enlace de descarga temporal",
      description:
        "Devuelve una URL temporal (unos 15 minutos) para descargar el archivo original de Box, p. ej. con curl desde el entorno de trabajo de Claude.",
      inputSchema: { file_id: z.string() },
      annotations: RO,
    },
    safe(async ({ file_id }) => {
      const f = await getItem("file", file_id);
      const res = await box(`/files/${encodeURIComponent(file_id)}/content`, { raw: true, redirect: "manual" });
      const url = res.headers.get("location");
      if (!url) throw new BoxError(res.status, `Box no devolvió enlace de descarga (${res.status})`);
      return ok({ name: f.name, size: f.size, path: pathOf(f), download_url: url, expires: "~15 minutos" });
    })
  );

  if (CFG.enableWrite) {
    const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

    server.registerTool(
      "box_create_folder",
      {
        title: "Crear carpeta",
        description: "Crea una carpeta en Box dentro de parent_id. Si ya existe, devuelve la existente.",
        inputSchema: { parent_id: z.string(), name: z.string().min(1).max(255) },
        annotations: RW,
      },
      safe(async ({ parent_id, name }) => {
        await getItem("folder", parent_id);
        try {
          const f = await box("/folders", { method: "POST", body: { name, parent: { id: parent_id } }, query: { fields: ITEM_FIELDS } });
          return ok({ created: true, ...slim(f) });
        } catch (e) {
          const existing = e.data?.context_info?.conflicts?.[0];
          if (e.status === 409 && existing) return ok({ created: false, note: "Ya existía", id: existing.id, name: existing.name });
          throw e;
        }
      })
    );

    server.registerTool(
      "box_upload_file",
      {
        title: "Subir archivo",
        description:
          "Sube un archivo a una carpeta de Box (hasta 50 MB). content va en texto plano o en base64 según encoding. Si ya existe un archivo con ese nombre, sube una versión nueva.",
        inputSchema: {
          folder_id: z.string(),
          name: z.string().min(1).max(255),
          content: z.string(),
          encoding: z.enum(["text", "base64"]).default("text"),
        },
        annotations: RW,
      },
      safe(async ({ folder_id, name, content, encoding }) => {
        await getItem("folder", folder_id);
        const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
        if (bytes.length > 50 * 1024 * 1024) return fail("El archivo supera 50 MB");
        const fd = new FormData();
        fd.append("attributes", JSON.stringify({ name, parent: { id: folder_id } }));
        fd.append("file", new Blob([bytes]), name);
        try {
          const r = await box("/files/content", { method: "POST", base: CFG.uploadBase, body: fd });
          return ok({ uploaded: true, new_version: false, ...slim(r.entries[0]) });
        } catch (e) {
          const existingId = e.data?.context_info?.conflicts?.id;
          if (e.status !== 409 || !existingId) throw e;
          const fd2 = new FormData();
          fd2.append("attributes", JSON.stringify({ name }));
          fd2.append("file", new Blob([bytes]), name);
          const r = await box(`/files/${existingId}/content`, { method: "POST", base: CFG.uploadBase, body: fd2 });
          return ok({ uploaded: true, new_version: true, ...slim(r.entries[0]) });
        }
      })
    );
  }

  return server;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function secretMatches(given) {
  if (CFG.allowNoAuth && !CFG.mcpSecret) return true;
  if (!given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(CFG.mcpSecret).digest();
  return crypto.timingSafeEqual(a, b);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "75mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Comprueba que las credenciales de Box funcionan (protegido igual que /mcp)
app.get(["/health/box/:key", "/health/box"], async (req, res) => {
  const key = req.params.key || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secretMatches(key)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await getToken(true);
    const me = await box("/users/me", { query: { fields: "id,name,login" } });
    res.json({ ok: true, box_user: me, write_enabled: CFG.enableWrite, allowed_folders: CFG.allowedFolders });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

async function handleMcp(req, res) {
  const key = req.params.key || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secretMatches(key)) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  if (req.method !== "POST") {
    // Modo sin estado: no hay stream GET ni sesiones que cerrar
    return res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp error]", e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}

app.all(["/mcp/:key", "/mcp"], handleMcp);

checkConfig();
app.listen(CFG.port, "0.0.0.0", () => {
  console.log(
    `Box_alegria MCP escuchando en :${CFG.port} — escritura ${CFG.enableWrite ? "ACTIVADA" : "desactivada"}` +
      (CFG.allowedFolders.length ? `, carpetas permitidas: ${CFG.allowedFolders.join(", ")}` : ", sin restricción de carpetas")
  );
});
