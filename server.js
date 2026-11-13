// Box_alegria — servidor MCP para Box con cuenta de servicio (Client Credentials Grant)
//
// Todos los usuarios de Claude comparten el mismo acceso a Box: el de la cuenta de
// servicio de la app. Nadie inicia sesión en Box; el servidor obtiene y renueva el token
// por su cuenta. El acceso al servidor se protege con MCP_SECRET.
//
// Miniaturas (opcional): con PUBLIC_BASE_URL (URL pública de este servicio, p. ej.
// https://tools-box-mcp.3te3kb.easypanel.host), las conexiones que añadan ?miniaturas=1 a la URL
// (/mcp/<secreto>?miniaturas=1, p. ej. Open WebUI) reciben enlaces firmados
// /thumb/<320|1024>/<id>.jpg?s=<firma> para incrustar la foto como imagen Markdown. Las conexiones
// sin ese parámetro (claude.ai) no cambian.
// La firma usa THUMB_SECRET (o, si no se define, una clave derivada de MCP_SECRET): solo
// funcionan los enlaces que ha generado el propio servidor. Cambiar el secreto invalida todos.

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
  // Índice de fotos etiquetadas (lo genera el servicio de etiquetado: indice.json)
  indiceUrl: env.INDICE_URL,
  indiceUser: env.INDICE_USUARIO,
  indicePassword: env.INDICE_PASSWORD,
  indiceRefrescoMin: Number(env.INDICE_REFRESCO_MIN || 60),
  // Índice de dossieres comerciales (lo genera el servicio box-dossieres: indice_dossieres.json)
  dossieresUrl: env.INDICE_DOSSIERES_URL,
  dossieresUser: env.INDICE_DOSSIERES_USUARIO,
  dossieresPassword: env.INDICE_DOSSIERES_PASSWORD,
  // Catálogos, magazine y presentación corporativa (lo publica box-dossieres: indice_catalogos.json, el mismo
  // catálogo que usa el bot). Si no se define, se usa la URL de dossieres cambiando el nombre del archivo.
  catalogosUrl:
    env.INDICE_CATALOGOS_URL ||
    (env.INDICE_DOSSIERES_URL ? env.INDICE_DOSSIERES_URL.replace(/indice_dossieres\.json/, "indice_catalogos.json") : ""),
  catalogosUser: env.INDICE_CATALOGOS_USUARIO || env.INDICE_DOSSIERES_USUARIO,
  catalogosPassword: env.INDICE_CATALOGOS_PASSWORD || env.INDICE_DOSSIERES_PASSWORD,
  apiBase: env.BOX_API_BASE || "https://api.box.com/2.0",
  uploadBase: env.BOX_UPLOAD_BASE || "https://upload.box.com/api/2.0",
  tokenUrl: env.BOX_TOKEN_URL || "https://api.box.com/oauth2/token",
  // Miniaturas públicas firmadas
  publicBaseUrl: (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
  thumbSecret: env.THUMB_SECRET,
  thumbCacheMb: Number(env.THUMB_CACHE_MB || 64),
};

function checkConfig() {
  const missing = [];
  if (!CFG.clientId) missing.push("BOX_CLIENT_ID");
  if (!CFG.clientSecret) missing.push("BOX_CLIENT_SECRET");
  if (!CFG.enterpriseId && !CFG.userId) missing.push("BOX_ENTERPRISE_ID (o BOX_USER_ID)");
  if (!CFG.mcpSecret && !CFG.allowNoAuth) missing.push("MCP_SECRET");
  if (CFG.mcpSecret && CFG.mcpSecret.length < 24)
    missing.push("MCP_SECRET (mínimo 24 caracteres)");
  if (CFG.thumbSecret && CFG.thumbSecret.length < 24)
    missing.push("THUMB_SECRET (mínimo 24 caracteres)");
  if (CFG.publicBaseUrl && !/^https?:\/\//.test(CFG.publicBaseUrl))
    missing.push("PUBLIC_BASE_URL (debe empezar por https://)");
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
// Miniaturas públicas firmadas (/thumb)
// Para que un cliente de chat (Open WebUI, el bot…) pueda mostrar la foto con
// Markdown sin que el modelo tenga que recibir la imagen.
// ---------------------------------------------------------------------------
const THUMB_SIZES = new Set(["320", "1024"]);
const thumbKey = CFG.thumbSecret
  ? Buffer.from(CFG.thumbSecret)
  : CFG.mcpSecret
    ? crypto.createHmac("sha256", CFG.mcpSecret).update("box-alegria-miniaturas").digest()
    : null;
const miniaturasActivas = Boolean(CFG.publicBaseUrl && thumbKey);

const firmaMiniatura = (fileId, size) =>
  crypto.createHmac("sha256", thumbKey).update(`${fileId}:${size}`).digest("base64url").slice(0, 32);

function urlMiniatura(fileId, size = "320") {
  if (!miniaturasActivas) return undefined;
  const id = String(fileId);
  return `${CFG.publicBaseUrl}/thumb/${size}/${encodeURIComponent(id)}.jpg?s=${firmaMiniatura(id, size)}`;
}

const extensionDe = (it) => String(it?.extension || String(it?.name || "").split(".").pop() || "").toLowerCase();
const esImagen = (it) => it?.type === "file" && IMAGE_EXT.has(extensionDe(it));

// Versión de slim() que añade la miniatura cuando el archivo es una imagen
const slimConMiniatura = (it) => {
  const s = slim(it);
  if (miniaturasActivas && esImagen(it)) s.miniatura = urlMiniatura(it.id, "320");
  return s;
};

// Caché LRU en memoria (por bytes) y deduplicación de peticiones simultáneas
const cacheMiniaturas = new Map();
const miniaturasEnCurso = new Map();
let bytesCacheMiniaturas = 0;
const MAX_CACHE_MINIATURAS = Math.max(8, CFG.thumbCacheMb) * 1024 * 1024;

function guardarMiniatura(clave, buf) {
  if (buf.length > MAX_CACHE_MINIATURAS / 4) return;
  if (cacheMiniaturas.has(clave)) {
    bytesCacheMiniaturas -= cacheMiniaturas.get(clave).length;
    cacheMiniaturas.delete(clave);
  }
  cacheMiniaturas.set(clave, buf);
  bytesCacheMiniaturas += buf.length;
  while (bytesCacheMiniaturas > MAX_CACHE_MINIATURAS) {
    const [k, b] = cacheMiniaturas.entries().next().value;
    cacheMiniaturas.delete(k);
    bytesCacheMiniaturas -= b.length;
  }
}

async function obtenerMiniatura(fileId, size) {
  const clave = `${size}:${fileId}`;
  const enCache = cacheMiniaturas.get(clave);
  if (enCache) {
    // marcar como usada recientemente
    cacheMiniaturas.delete(clave);
    cacheMiniaturas.set(clave, enCache);
    return enCache;
  }
  if (!miniaturasEnCurso.has(clave)) {
    miniaturasEnCurso.set(
      clave,
      (async () => {
        await getItem("file", fileId); // respeta BOX_ALLOWED_FOLDER_IDS
        const res = await getRepresentation(fileId, `[jpg?dimensions=${size}x${size}]`);
        if (!res) throw new BoxError(404, "Box no ofrece vista previa de este archivo");
        const buf = Buffer.from(await res.arrayBuffer());
        guardarMiniatura(clave, buf);
        return buf;
      })().finally(() => miniaturasEnCurso.delete(clave))
    );
  }
  return miniaturasEnCurso.get(clave);
}

// ---------------------------------------------------------------------------
// Índice de fotos etiquetadas (buscar_fotos)
// ---------------------------------------------------------------------------
const FLOTA = ["13,80", "Airstream", "CajaMar", "Camión rígido", "Cotazero", "Furgón", "Plataformas", "Semirremolque", "Set TV"];
const PLANOS = ["exterior del vehículo", "interior del vehículo", "evento con público", "montaje o producción", "detalle", "retrato o equipo", "otro"];
const LINEAS = ["Roadshow", "Acciones pedagógicas y sensibilización", "Marca y patrocinio", "Promoción y producto", "Manufacturing", "Agencia"];
const PARADAS = new Set(
  "de la el los las del y en un una con para por al a o u que se sin sobre entre tipo foto fotos imagen imagenes".split(" ")
);
const norm = (t) =>
  String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const palabras = (t) => norm(t).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 1 && !PARADAS.has(w));

let indice = { fotos: [], generado: null, cargadoEn: null, error: null };

async function cargarIndice() {
  if (!CFG.indiceUrl) return;
  try {
    const headers = {};
    if (CFG.indiceUser)
      headers.Authorization = "Basic " + Buffer.from(`${CFG.indiceUser}:${CFG.indicePassword || ""}`).toString("base64");
    const res = await fetch(CFG.indiceUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const fotos = (data.fotos || []).map((f) => ({
      ...f,
      // texto ya normalizado por campos, con peso distinto en la puntuación
      _alto: new Set(palabras([f.marca, f.cliente, (f.palabras || []).join(" "), f.vehiculo, f.vehiculo_campana].join(" "))),
      _medio: new Set(palabras([f.descripcion, f.campana, (f.lineas || []).join(" "), f.plano, f.tipo_vehiculo].join(" "))),
      _bajo: new Set(palabras([f.nombre, f.carpetas].join(" "))),
    }));
    indice = { fotos, generado: data.generado || null, cargadoEn: new Date().toISOString(), error: null };
    console.log(`Índice de fotos cargado: ${fotos.length} fotos (generado ${indice.generado})`);
  } catch (e) {
    indice.error = e.message;
    console.error("[índice] no se pudo cargar:", e.message, indice.fotos.length ? "(sigo con el anterior)" : "");
  }
}

// Coincidencia flexible: exacta, o por prefijo en palabras de 4+ letras (singular/plural, género…)
function puntuar(f, terminos) {
  let total = 0;
  let encontrados = 0;
  for (const t of terminos) {
    let p = 0;
    for (const [conj, peso] of [[f._alto, 3], [f._medio, 2], [f._bajo, 1]]) {
      if (conj.has(t)) p = Math.max(p, peso);
      else if (t.length >= 4) for (const w of conj) if (w.length >= 4 && (w.startsWith(t) || t.startsWith(w))) { p = Math.max(p, peso - 0.5); break; }
    }
    if (p) encontrados++;
    total += p;
  }
  return { total, encontrados };
}

// ---------------------------------------------------------------------------
// Índice de dossieres comerciales (buscar_dossieres)
// ---------------------------------------------------------------------------
let dossieres = { lista: [], generado: null, cargadoEn: null, error: null };

async function cargarDossieres() {
  if (!CFG.dossieresUrl) return;
  try {
    const headers = {};
    if (CFG.dossieresUser)
      headers.Authorization =
        "Basic " + Buffer.from(`${CFG.dossieresUser}:${CFG.dossieresPassword || ""}`).toString("base64");
    const res = await fetch(CFG.dossieresUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const lista = (data.dossieres || []).map((d) => ({
      ...d,
      _anio: Number(String(d.anio || "").match(/(19|20)\d{2}/)?.[0]) || Number(String(d.fecha || "").slice(0, 4)) || null,
      _alto: new Set(palabras([d.titulo, d.cliente, d.campana, d.palabras_clave].join(" "))),
      _medio: new Set(palabras([d.tematicas, d.formato, d.vehiculos, d.publico, d.resumen].join(" "))),
      _bajo: new Set(palabras((d.archivos || []).map((a) => `${a.nombre} ${a.carpeta || ""}`).join(" "))),
    }));
    dossieres = { lista, generado: data.generado || null, cargadoEn: new Date().toISOString(), error: null };
    console.log(`Índice de dossieres cargado: ${lista.length} dossieres (generado ${dossieres.generado})`);
  } catch (e) {
    dossieres.error = e.message;
    console.error("[dossieres] no se pudo cargar:", e.message, dossieres.lista.length ? "(sigo con el anterior)" : "");
  }
}

// ---------------------------------------------------------------------------
// Catálogos, magazine y presentación corporativa (buscar_catalogos)
// Misma lógica que catalogos.buscar() del bot de box-dossieres.
// ---------------------------------------------------------------------------
let catalogos = { lista: [], formatos: {}, generado: null, cargadoEn: null, error: null };

async function cargarCatalogos() {
  if (!CFG.catalogosUrl) return;
  try {
    const headers = {};
    if (CFG.catalogosUser)
      headers.Authorization =
        "Basic " + Buffer.from(`${CFG.catalogosUser}:${CFG.catalogosPassword || ""}`).toString("base64");
    const res = await fetch(CFG.catalogosUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    catalogos = {
      lista: data.catalogos || [],
      formatos: data.formatos || {},
      generado: data.generado || null,
      cargadoEn: new Date().toISOString(),
      error: null,
    };
    console.log(`Índice de catálogos cargado: ${catalogos.lista.length} catálogos (generado ${catalogos.generado})`);
  } catch (e) {
    catalogos.error = e.message;
    console.error("[catálogos] no se pudo cargar:", e.message, catalogos.lista.length ? "(sigo con el anterior)" : "");
  }
}

const VACIAS_CAT = new Set(
  ("a al algo algun alguna algunos ante con como contra cual de del desde donde dossier dossieres dosier dosieres el " +
    "ella en entre era es esa ese esta este esto hay la las le lo los mas me mi muy nos o para pero por que quiero se " +
    "sea si sin sobre su sus tenemos tiene todo tu un una uno unos y ya busco buscame dame hazme ejemplo ejemplos " +
    "campana campanas hicimos hecho tengo tenga catalogo catalogos ultimo ultima version pasame manda").split(" ")
);
const anioEdicion = (e) => Number(String(e.edicion).match(/(19|20)\d{2}/)?.[0]) || 0;

function buscarCatalogos(consulta = "", idioma = null) {
  const q = norm(consulta).split(/\s+/).filter((p) => p.length >= 3 && !VACIAS_CAT.has(p));
  const ni = idioma ? norm(idioma).slice(0, 4) : null;
  const salida = [];
  for (const c of catalogos.lista) {
    const apodos = (c.ediciones || []).flatMap((e) => [e.nombre || "", ...(e.alias || [])]);
    const texto = norm([c.id, c.titulo, c.tipo, c.describe || "", ...(c.palabras || []), ...apodos].join(" "));
    if (q.length && !q.some((p) => texto.includes(p))) continue;
    if (c.solo_si_lo_piden && !q.some((p) => norm((c.palabras || []).join(" ")).includes(p))) continue;
    const eds = [];
    for (const e of [...(c.ediciones || [])].filter((e) => (e.archivos || []).length).sort((x, y) => anioEdicion(y) - anioEdicion(x))) {
      const archivos = e.archivos.filter((a) => !ni || norm(a.idioma).includes(ni));
      if (archivos.length)
        eds.push({
          edicion: e.edicion,
          nombre: e.nombre || "",
          nota: e.nota || "",
          tambien_llamado: e.alias || [],
          archivos: archivos.map((a) => ({
            id: a.id,
            idioma: a.idioma || "sin confirmar",
            formato: a.formato,
            mb: a.mb,
            enlace: `https://app.box.com/file/${a.id}`,
          })),
        });
    }
    if (eds.length)
      salida.push({
        catalogo: c.id,
        titulo: c.titulo,
        tipo: c.tipo,
        describe: c.describe || "",
        elegir_edicion: Boolean(c.elegir_edicion),
        solo_si_lo_piden: Boolean(c.solo_si_lo_piden),
        ediciones: eds,
      });
  }
  return salida;
}

// Una línea por catálogo para la descripción de la herramienta (como el system prompt del bot): así Claude sabe
// qué existe y reconoce los nombres propios ("el Piti", "el Juncal") sin buscar antes.
function resumenCatalogos() {
  const lineas = [];
  for (const c of catalogos.lista) {
    const eds = [...(c.ediciones || [])].filter((e) => (e.archivos || []).length).sort((x, y) => anioEdicion(y) - anioEdicion(x));
    if (!eds.length) continue;
    if (c.solo_si_lo_piden) {
      lineas.push(`${c.titulo} (solo si lo piden por su nombre)`);
      continue;
    }
    const nombres = eds
      .filter((e) => e.nombre)
      .map((e) => `${e.edicion} ${e.nombre}${(e.alias || []).length ? ` (también ${e.alias.join(", ")})` : ""}`);
    lineas.push(nombres.length ? `${c.titulo}: ${nombres.join(", ")}` : `${c.titulo} (última edición ${eds[0].edicion})`);
  }
  return lineas.length ? " Catálogos que hay ahora: " + lineas.join("; ") + "." : "";
}

const contar = (lista, clave) => {
  const c = new Map();
  for (const f of lista) for (const v of [].concat(clave(f) || [])) if (v) c.set(v, (c.get(v) || 0) + 1);
  return Object.fromEntries([...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
};

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

// conMiniaturas: solo para clientes que muestran imágenes Markdown externas (Open WebUI…), pedido con
// ?miniaturas=1 en la URL del conector. claude.ai no las carga, así que allí todo sigue como antes.
function buildServer({ conMiniaturas = false } = {}) {
  const server = new McpServer({ name: "Box_alegria", version: "2.0.0" });
  const M = miniaturasActivas && conMiniaturas;
  const lista = (it) => (M ? slimConMiniatura(it) : slim(it));
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
        items: data.entries.map(lista),
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
      return ok({ total_count: data.total_count, offset, items: data.entries.filter(isAllowed).map(lista) });
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
        "Devuelve una imagen de Box para que Claude la vea (JPG/PNG/HEIC/PSD/PDF… convertida por Box a JPG). " +
        "Úsala cuando tú necesites ver la foto para comprobar o describir algo. " +
        (M
          ? "Para ENSEÑÁRSELA al usuario no hace falta: incrusta su 'miniatura' en Markdown, ![nombre](miniatura), " +
            "que algunos clientes de chat no muestran las imágenes devueltas por herramientas. "
          : "") +
        "Para el archivo original a máxima calidad usa box_get_download_link.",
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
      const mostrar = M
        ? `\nPara mostrarla al usuario: ![${f.name.replace(/[[\]]/g, "")}](${urlMiniatura(f.id, size === "320" ? "320" : "1024")})`
        : "";
      return {
        content: [
          { type: "text", text: `${pathOf(f)} (id ${f.id})${mostrar}` },
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

  server.registerTool(
    "buscar_fotos",
    {
      title: "Buscar fotos de campañas",
      description:
        "Busca en el índice de fotos etiquetadas del archivo de alegria-activity (fotos de campañas en Box, " +
        "descritas automáticamente). Combina texto libre (descripción, palabras clave, marca, cliente) con filtros. " +
        "Por defecto excluye fotos con posibles menores y fotos no aptas para propuesta. " +
        (M
          ? "Cada foto trae 'miniatura' (320 px) e 'imagen_grande' (1024 px): para ENSEÑARLA al usuario incrústala en " +
            "Markdown, ![nombre](miniatura), sin llamar a box_get_image (así se ve en cualquier chat y no gasta tokens). " +
            "Usa box_get_image solo si tú necesitas ver la foto para comprobar algo. "
          : "Devuelve el id de Box de cada foto: para enseñarla usa box_get_image. ") +
        "Las etiquetas son automáticas: no afirmes como seguro lo que no hayas comprobado en la imagen.",
      inputSchema: {
        texto: z.string().optional().describe("Palabras a buscar, p. ej. 'pantallas interior realidad virtual'"),
        vehiculo: z.enum(FLOTA).optional().describe("Vehículo de la flota (en la foto o asignado a su campaña)"),
        plano: z.enum(PLANOS).optional(),
        linea: z.enum(LINEAS).optional().describe("Línea de servicio"),
        cliente: z.string().optional().describe("Cliente o campaña (parte del nombre de la carpeta)"),
        marca: z.string().optional().describe("Marca visible en la foto"),
        anio_desde: z.number().int().optional(),
        anio_hasta: z.number().int().optional(),
        excluir_menores: z.boolean().default(true).describe("Quitar fotos con posibles menores (sí o dudoso)"),
        solo_aptas: z.boolean().default(true).describe("Solo fotos aptas para enseñar a un cliente"),
        solo_publicadas: z.boolean().default(false).describe("Solo fotos ya publicadas en la web"),
        limit: z.number().int().min(1).max(50).default(12),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      if (!CFG.indiceUrl) return fail("El buscador de fotos no está configurado (falta INDICE_URL).");
      if (!indice.fotos.length) {
        await cargarIndice();
        if (!indice.fotos.length) return fail(`El índice de fotos no está disponible${indice.error ? `: ${indice.error}` : ""}.`);
      }
      const nc = a.cliente ? norm(a.cliente) : null;
      const nm = a.marca ? norm(a.marca) : null;
      let excluidasMenores = 0;
      let excluidasNoAptas = 0;
      const base = indice.fotos.filter((f) => {
        if (a.vehiculo && f.vehiculo !== a.vehiculo && !(f.vehiculo_campana || "").split(", ").includes(a.vehiculo)) return false;
        if (a.plano && f.plano !== a.plano) return false;
        if (a.linea && !(f.lineas || []).includes(a.linea)) return false;
        if (nc && !norm(`${f.cliente} ${f.campana} ${f.carpetas}`).includes(nc)) return false;
        if (nm && !norm(f.marca).includes(nm)) return false;
        if (a.anio_desde && !(f.anio >= a.anio_desde)) return false;
        if (a.anio_hasta && !(f.anio <= a.anio_hasta)) return false;
        if (a.solo_publicadas && f.uso !== "publicada en web") return false;
        return true;
      });
      const terminos = palabras(a.texto);
      let lista = base;
      if (terminos.length) {
        const minimo = Math.max(1, Math.ceil(terminos.length / 2));
        lista = base
          .map((f) => ({ f, ...puntuar(f, terminos) }))
          .filter((x) => x.encontrados >= minimo)
          .sort((x, y) => y.encontrados - x.encontrados || y.total - x.total || (y.f.anio || 0) - (x.f.anio || 0))
          .map((x) => x.f);
      } else {
        lista = [...base].sort((x, y) => (y.anio || 0) - (x.anio || 0));
      }
      // las exclusiones se cuentan sobre lo que coincide con la búsqueda
      lista = lista.filter((f) => {
        if (a.excluir_menores && (f.menores === "sí" || f.menores === "dudoso")) return (excluidasMenores++, false);
        if (a.solo_aptas && !f.apta) return (excluidasNoAptas++, false);
        return true;
      });
      const pagina = lista.slice(a.offset, a.offset + a.limit).map((f) => ({
        id: f.id,
        nombre: f.nombre,
        campana: f.campana,
        anio: f.anio,
        vehiculo: f.vehiculo,
        ...(f.vehiculo_campana && { vehiculo_campana: `${f.vehiculo_campana} (confianza ${f.conf_vehiculo_campana || "?"}, sin confirmar)` }),
        plano: f.plano,
        lineas: f.lineas,
        marca: f.marca,
        descripcion: f.descripcion,
        menores: f.menores,
        uso: f.uso,
        enlace: `https://app.box.com/file/${f.id}`,
        ...(M && { miniatura: urlMiniatura(f.id, "320"), imagen_grande: urlMiniatura(f.id, "1024") }),
      }));
      return ok({
        total: lista.length,
        offset: a.offset,
        mostrando: pagina.length,
        excluidas: { posibles_menores: excluidasMenores, no_aptas: excluidasNoAptas },
        resumen: {
          por_campana: contar(lista, (f) => f.campana),
          por_vehiculo: contar(lista, (f) => f.vehiculo_campana || (FLOTA.includes(f.vehiculo) ? f.vehiculo : null)),
          por_anio: contar(lista, (f) => (f.anio ? String(f.anio) : null)),
        },
        indice: { fotos: indice.fotos.length, generado: indice.generado },
        fotos: pagina,
      });
    })
  );

  server.registerTool(
    "buscar_dossieres",
    {
      title: "Buscar dossieres comerciales",
      description:
        "Busca en el índice de dossieres comerciales de alegria-activity (unos 1.100 PDF de 2016 a hoy, en Box, " +
        "fichados automáticamente: cliente, campaña, vehículos, formato, temáticas, público y resumen). Combina " +
        "palabras clave con filtros. Busca por palabras: si no sale nada, prueba sinónimos, el sector en vez del " +
        "cliente o términos más generales. Con orden 'recientes' y sin texto devuelve lo último de todo el archivo. " +
        "Cada dossier trae el id de Box de la versión recomendada para descargar (usa box_get_download_link) y sus " +
        "otras versiones o idiomas. 'fecha' es la última modificación en Box: algunas son de traslados en bloque y " +
        "son aproximadas; si el dossier dice el año, viene en 'anio'.",
      inputSchema: {
        texto: z.string().optional().describe("Palabras clave, p. ej. 'salud mental Airstream', 'bibliobús', 'oficina bancaria móvil'"),
        cliente: z.string().optional().describe("Filtra por cliente (texto parcial)"),
        idioma: z.string().optional().describe("castellano, inglés, francés, polaco, euskera…"),
        anio_desde: z.number().int().optional(),
        anio_hasta: z.number().int().optional(),
        orden: z.enum(["relevancia", "recientes"]).default("relevancia").describe("recientes: los más nuevos primero"),
        limit: z.number().int().min(1).max(20).default(8),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      if (!CFG.dossieresUrl) return fail("El buscador de dossieres no está configurado (falta INDICE_DOSSIERES_URL).");
      if (!dossieres.lista.length) {
        await cargarDossieres();
        if (!dossieres.lista.length)
          return fail(`El índice de dossieres no está disponible${dossieres.error ? `: ${dossieres.error}` : ""}.`);
      }
      const nc = a.cliente ? norm(a.cliente) : null;
      const ni = a.idioma ? norm(a.idioma).slice(0, 4) : null;
      const base = dossieres.lista.filter((d) => {
        if (nc && !norm(`${d.cliente} ${d.campana} ${d.titulo}`).includes(nc)) return false;
        if (ni && !norm(d.idiomas).includes(ni)) return false;
        if (a.anio_desde && !(d._anio >= a.anio_desde)) return false;
        if (a.anio_hasta && !(d._anio <= a.anio_hasta)) return false;
        return true;
      });
      const recientes = (x, y) => (y._anio || 0) - (x._anio || 0) || String(y.fecha).localeCompare(String(x.fecha));
      const terminos = palabras(a.texto);
      let lista = base;
      if (terminos.length) {
        const minimo = Math.max(1, Math.ceil(terminos.length / 2));
        const puntuados = base.map((d) => ({ d, ...puntuar(d, terminos) })).filter((x) => x.encontrados >= minimo);
        puntuados.sort((x, y) =>
          a.orden === "recientes"
            ? recientes(x.d, y.d) || y.total - x.total
            : y.encontrados - x.encontrados || y.total - x.total || recientes(x.d, y.d)
        );
        lista = puntuados.map((x) => x.d);
      } else {
        lista = [...base].sort(recientes);
      }
      const pagina = lista.slice(a.offset, a.offset + a.limit).map((d) => {
        const archivos = d.archivos || [];
        const principal = archivos.find((x) => x.por_defecto) || archivos[0] || {};
        return {
          titulo: d.titulo,
          cliente: d.cliente,
          campana: d.campana,
          anio: d.anio || null,
          fecha: d.fecha,
          idiomas: d.idiomas,
          vehiculos: d.vehiculos,
          formato: d.formato,
          tematicas: d.tematicas,
          publico: d.publico,
          resumen: d.resumen,
          descargar: { id: principal.id, nombre: principal.nombre, mb: principal.mb, enlace: `https://app.box.com/file/${principal.id}` },
          otras_versiones: archivos
            .filter((x) => x.id !== principal.id)
            .map((x) => ({ id: x.id, nombre: x.nombre, idioma: x.idioma, modificado: x.modificado })),
        };
      });
      return ok({
        total: lista.length,
        offset: a.offset,
        mostrando: pagina.length,
        resumen: {
          por_cliente: contar(lista, (d) => d.cliente),
          por_anio: contar(lista, (d) => (d._anio ? String(d._anio) : null)),
        },
        indice: { dossieres: dossieres.lista.length, generado: dossieres.generado },
        dossieres: pagina,
      });
    })
  );

  server.registerTool(
    "buscar_catalogos",
    {
      title: "Buscar catálogos, magazine y presentación corporativa",
      description:
        "Busca en los catálogos genéricos de alegria-activity (Box: 00.COMPARTIDO / 1. Material Comercial): " +
        "catálogos por sector (Sanidad, Construcción, Manufacturing, Set TV…), el magazine y la presentación " +
        "corporativa. Es el mismo catálogo que usa el bot de Telegram y se actualiza solo cada noche. Sin consulta " +
        "devuelve todos. Cada catálogo trae sus ediciones de la más nueva a la más antigua y, en cada edición, los " +
        "archivos por idioma y formato (baja = para correo, pantalla, pliegos = imprenta, alta) con su id de Box y " +
        "enlace. Si 'elegir_edicion' es true (el magazine), no des solo la última: enseña las ediciones por su nombre. " +
        "Si una edición tiene 'tambien_llamado', llámala siempre por su 'nombre'. 'solo_si_lo_piden': ofrécelo solo " +
        "si lo nombran. Para descargar usa box_get_download_link con el id. Úsala también cuando nombren una " +
        "edición por su nombre propio, aunque no digan 'catálogo' ni 'magazine'." +
        resumenCatalogos(),
      inputSchema: {
        consulta: z.string().optional().describe("Tema o nombre, p. ej. 'sanidad', 'magazine', 'Lucas', 'presentación'. Vacío = todos"),
        idioma: z.string().optional().describe("castellano, inglés, francés, polaco…"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      if (!CFG.catalogosUrl) return fail("El buscador de catálogos no está configurado (falta INDICE_DOSSIERES_URL o INDICE_CATALOGOS_URL).");
      if (!catalogos.lista.length) {
        await cargarCatalogos();
        if (!catalogos.lista.length)
          return fail(`El índice de catálogos no está disponible${catalogos.error ? `: ${catalogos.error}` : ""}.`);
      }
      const cats = buscarCatalogos(a.consulta || "", a.idioma || null);
      return ok({
        total: cats.length,
        formatos: catalogos.formatos,
        indice: { catalogos: catalogos.lista.length, generado: catalogos.generado },
        catalogos: cats,
      });
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
    res.json({
      ok: true,
      box_user: me,
      write_enabled: CFG.enableWrite,
      allowed_folders: CFG.allowedFolders,
      indice_fotos: CFG.indiceUrl
        ? { fotos: indice.fotos.length, generado: indice.generado, cargado_en: indice.cargadoEn, error: indice.error }
        : "no configurado",
      indice_dossieres: CFG.dossieresUrl
        ? { dossieres: dossieres.lista.length, generado: dossieres.generado, cargado_en: dossieres.cargadoEn, error: dossieres.error }
        : "no configurado",
      indice_catalogos: CFG.catalogosUrl
        ? { catalogos: catalogos.lista.length, generado: catalogos.generado, cargado_en: catalogos.cargadoEn, error: catalogos.error }
        : "no configurado",
      miniaturas: miniaturasActivas
        ? {
            base: CFG.publicBaseUrl,
            secreto: CFG.thumbSecret ? "THUMB_SECRET" : "derivado de MCP_SECRET",
            en_cache: cacheMiniaturas.size,
            cache_mb: Math.round((bytesCacheMiniaturas / 1024 / 1024) * 10) / 10,
          }
        : "desactivadas (falta PUBLIC_BASE_URL)",
    });
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
  const flag = String(req.query.miniaturas || "").toLowerCase();
  const server = buildServer({ conMiniaturas: ["1", "true", "si", "sí"].includes(flag) });
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

// Miniatura pública firmada: /thumb/<320|1024>/<file_id>.jpg?s=<firma>
// Sin MCP_SECRET a propósito: la firma solo vale para ese archivo y ese tamaño.
app.get("/thumb/:size/:file", async (req, res) => {
  const { size } = req.params;
  const fileId = String(req.params.file).replace(/\.jpe?g$/i, "");
  if (!miniaturasActivas || !THUMB_SIZES.has(size) || !/^\d{1,20}$/.test(fileId)) return res.status(404).end();
  const dada = Buffer.from(String(req.query.s || ""));
  const buena = Buffer.from(firmaMiniatura(fileId, size));
  if (dada.length !== buena.length || !crypto.timingSafeEqual(dada, buena)) return res.status(403).end();
  try {
    const buf = await obtenerMiniatura(fileId, size);
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(buf);
  } catch (e) {
    console.error("[miniatura]", fileId, size, e.message);
    res.status([403, 404, 422].includes(e.status) ? (e.status === 422 ? 404 : e.status) : 502).end();
  }
});

checkConfig();
if (CFG.indiceUrl) {
  cargarIndice();
  setInterval(cargarIndice, Math.max(5, CFG.indiceRefrescoMin) * 60_000).unref();
}
if (CFG.dossieresUrl) {
  cargarDossieres();
  setInterval(cargarDossieres, Math.max(5, CFG.indiceRefrescoMin) * 60_000).unref();
}
if (CFG.catalogosUrl) {
  cargarCatalogos();
  setInterval(cargarCatalogos, Math.max(5, CFG.indiceRefrescoMin) * 60_000).unref();
}
app.listen(CFG.port, "0.0.0.0", () => {
  console.log(
    `Box_alegria MCP escuchando en :${CFG.port} — escritura ${CFG.enableWrite ? "ACTIVADA" : "desactivada"}` +
      (CFG.allowedFolders.length ? `, carpetas permitidas: ${CFG.allowedFolders.join(", ")}` : ", sin restricción de carpetas") +
      (miniaturasActivas ? `, miniaturas en ${CFG.publicBaseUrl}/thumb` : ", miniaturas desactivadas (falta PUBLIC_BASE_URL)")
  );
});
