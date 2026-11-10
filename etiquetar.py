#!/usr/bin/env python3
"""
Piloto de etiquetado de fotos de Box con la API de Claude (Batch API) · versión 6
alegria-activity

Uso:
  python etiquetar.py listar                 Recorre la carpeta de Box y guarda datos/manifest.json
                                             (agrupa las fotos repetidas en varias carpetas)
  python etiquetar.py enviar [--si]          Prepara miniaturas, estima el coste y crea un lote por modelo
         [--modelos m1,m2] [--forzar]        (solo esos modelos / sustituir lotes existentes)
  python etiquetar.py estado                 Muestra el estado de los lotes
  python etiquetar.py recoger                Descarga resultados y genera datos/resultados.csv
  python etiquetar.py todo [--si]            Todo seguido, esperando a que terminen los lotes (reanuda si se cortó)
  python etiquetar.py flota [--si]           Vehículo de la flota por campaña con Sonnet (3 fotos por campaña)
  python etiquetar.py flota-recoger          Recoge esa consulta: flota_campanas.csv y resultados_flota.csv
  python etiquetar.py indice --tandas a,b    Junta tandas en indice.json para el buscador del conector de Box

Solo LEE de Box. No escribe, mueve ni borra nada allí.
"""
import argparse
import base64
import csv
import io
import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

load_dotenv()

VERSION = "v6"

# ---------------------------------------------------------------- configuración
API = "https://api.box.com/2.0"
CARPETA_RAIZ = os.getenv("BOX_FOLDER_ID", "379464633435")  # 15. Web 2025 / Fotos y videos / Fotos
EXCLUIR = {x.strip() for x in os.getenv("BOX_EXCLUDE_IDS", "").split(",") if x.strip()}
MODELOS = [m.strip() for m in os.getenv("MODELOS", "claude-haiku-5-5,claude-sonnet-5-5").split(",") if m.strip()]
MAX_FOTOS = int(os.getenv("MAX_FOTOS", "250"))
LADO = int(os.getenv("LADO_MAX_PX", "1024"))
LADO_REF = int(os.getenv("LADO_REF_PX", "512"))
INCLUIR_RUTA = os.getenv("INCLUIR_RUTA", "false").lower() == "true"
USAR_REFERENCIAS = os.getenv("USAR_REFERENCIAS", "true").lower() == "true"
HILOS = int(os.getenv("HILOS", "6"))                       # descargas de miniaturas en paralelo
MAX_MB_LOTE = int(os.getenv("MAX_MB_LOTE", "180"))         # la Batch API admite hasta 256 MB por lote
MAX_PETICIONES_LOTE = int(os.getenv("MAX_PETICIONES_LOTE", "5000"))

# Precios Batch en USD por millón de tokens (entrada, salida). Orientativos: revísalos en la Console.
PRECIOS_BATCH = {
    "claude-haiku-5-5": (0.05, 0.25),
    "claude-sonnet-5-5": (1.00, 5.00),
    "claude-opus-5-5": (2.00, 10.00),
}

DATA = Path(os.getenv("DATA_DIR", "datos"))
MANIFEST = DATA / "manifest.json"
LOTES = DATA / "lotes.json"
CACHE = DATA / "miniaturas"
RESULTADOS_CSV = DATA / "resultados.csv"
RESULTADOS_JSONL = DATA / "resultados.jsonl"
ENVIADAS = DATA / "enviadas.json"          # qué fotos van ya en algún lote, por modelo (para reanudar)
LOTES_FLOTA = DATA / "lotes_flota.json"
FLOTA_CSV = DATA / "flota_campanas.csv"
MODELO_FLOTA = os.getenv("MODELO_FLOTA", "claude-sonnet-5-5")

EXTENSIONES = {"jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff"}

FLOTA = ["13,80", "Airstream", "CajaMar", "Camión rígido", "Cotazero",
         "Furgón", "Plataformas", "Semirremolque", "Set TV"]

# Una foto exterior de cada vehículo, del "Maestro vehículos (Claude)" en Box (Cotazero solo tiene planos).
REFERENCIAS = [
    ("Airstream", "2400251591808", "remolque compacto rotulado que se abre por un lateral como escaparate, con rampa"),
    ("Furgón", "2400253604413", "furgoneta grande con carrocería tipo caja, puerta lateral, escalera y toldo"),
    ("Camión rígido", "2400250967290", "camión rígido con caja expositiva de laterales acristalados"),
    ("Semirremolque", "2400249539182", "tráiler de gran tamaño con laterales expandibles"),
    ("13,80", "2400258558297", "autocar de 3 ejes con el lateral DESPLEGADO: un módulo saliente de altura completa"),
    ("13,80", "2400251061395", "el mismo 13,80 desplegado, otra campaña: lo distintivo es el módulo lateral que sale"),
    ("CajaMar", "2400551454784", "camión carrozado con escalera y rampa de acceso lateral"),
    ("Plataformas", "2400244907579", "módulo-remolque blanco grande tipo sala, con ventanas"),
    ("Set TV", "2400249995707", "módulo plató de TV con terraza superior"),
]

LINEAS = ["Roadshow", "Acciones pedagógicas y sensibilización", "Marca y patrocinio",
          "Promoción y producto", "Manufacturing", "Agencia"]

DEFINICIONES = """\
- Roadshow: giras itinerantes con un vehículo que recorre varias localidades.
- Acciones pedagógicas y sensibilización: talleres, exposiciones y actividades educativas o de concienciación \
(salud, prevención, ciencia, medioambiente, alimentación...).
- Marca y patrocinio: activaciones de marca, hospitality y presencia en eventos deportivos o patrocinios.
- Promoción y producto: lanzamientos, sampling y demostraciones de producto.
- Manufacturing: diseño y fabricación de unidades móviles a medida para clientes (sanitarias, oficinas o \
sucursales móviles, puestos de mando, hospitality, motorhomes, bibliotecas...), aunque no haya evento ni público.
- Agencia: el equipo de alegria-activity (retratos del personal), sus oficinas e instalaciones."""

# ---------------------------------------------------------------- prompt y esquema
SYSTEM = f"""Eres documentalista de alegria-activity, una agencia de marketing experiencial que hace campañas, \
roadshows y exposiciones itinerantes en vehículos de flota propia, y que además fabrica unidades móviles a \
medida para clientes. Catalogas fotos del archivo de la agencia para poder encontrarlas después al preparar \
propuestas comerciales y la web.

Llama directamente a la herramienta guardar_ficha, una sola vez por foto, sin escribir texto antes. Usa exactamente los valores permitidos de cada \
lista, sin inventar otros. Reglas:

1. Describe solo lo que se ve. Si dudas, usa "desconocido" o confianza "baja". Nunca inventes.
2. Vehículo de la flota ({", ".join(FLOTA)}): al principio del mensaje tienes una foto de referencia de cada \
uno (salvo Cotazero). Elige uno de la flota solo si coincide claramente con su referencia en forma y estructura \
(la rotulación cambia en cada campaña, no te fíes de los colores). Muchas fotos son de unidades fabricadas para \
clientes, que NO son de la flota: en ese caso usa "otro vehículo". Si no hay vehículo, "sin vehículo".
3. Marca: el nombre corto de la marca o cliente principal (p. ej. "Repsol", "Fundación DISA"), sin frases. \
Prioridad: lo que se lee en la imagen; si no se lee nada, el nombre de la carpeta (si te la doy, suele ser el \
cliente); si no, el nombre del archivo. Indica de dónde la sacas en fuente_marca. Vacío si no hay ninguna.
4. Personas: NO identifiques a nadie ni describas rasgos físicos de personas concretas. Indica solo cuántas hay \
y qué están haciendo.
5. posibles_menores: "sí" si aparecen niños o adolescentes; "dudoso" si no se puede descartar; "no" en otro caso.
6. Líneas de servicio (puedes marcar de 1 a 3 si la foto sirve para varias; la primera es la principal):
{DEFINICIONES}
7. Descripción (1-2 frases) y palabras clave (5-10) en castellano, pensadas para buscar después: vehículo, \
espacio (interior/exterior), actividad, tipo de lugar (plaza, recinto ferial, colegio, nave...) y elementos \
(pantallas, mostrador, carpa, photocall, gafas de realidad virtual...).
8. apta_propuesta: true si la foto tiene calidad y encuadre suficientes para enseñarla a un cliente.
"""

TIPOS_VEHICULO = ["caravana", "remolque", "furgoneta", "camión", "semirremolque/tráiler", "autobús/autocar",
                  "plataforma/escenario móvil", "coche", "otro", "ninguno"]

HERRAMIENTA = {
    "name": "guardar_ficha",
    "description": "Guarda la ficha de catalogación de la foto.",
    "input_schema": {
        "type": "object",
        "properties": {
            "descripcion": {"type": "string"},
            "palabras_clave": {"type": "array", "items": {"type": "string"}},
            "vehiculo": {"type": "string", "enum": FLOTA + ["otro vehículo", "sin vehículo", "desconocido"]},
            "tipo_vehiculo": {"type": "string", "enum": TIPOS_VEHICULO},
            "plano": {"type": "string", "enum": [
                "exterior del vehículo", "interior del vehículo", "evento con público", "montaje o producción",
                "detalle", "retrato o equipo", "otro"]},
            "lineas_servicio": {"type": "array", "minItems": 1, "maxItems": 3,
                                "items": {"type": "string", "enum": LINEAS}},
            "marca_visible": {"type": "string", "description": "Nombre corto de la marca; vacío si ninguna."},
            "fuente_marca": {"type": "string", "enum": ["imagen", "carpeta", "nombre de archivo", "ninguna"]},
            "personas": {"type": "string", "enum": ["ninguna", "1-3", "4-15", "más de 15"]},
            "posibles_menores": {"type": "string", "enum": ["sí", "no", "dudoso"]},
            "calidad": {"type": "string", "enum": ["alta", "media", "baja"]},
            "apta_propuesta": {"type": "boolean"},
            "confianza": {"type": "string", "enum": ["alta", "media", "baja"]},
        },
        "required": ["vehiculo", "tipo_vehiculo", "plano", "lineas_servicio", "marca_visible", "fuente_marca",
                     "personas", "posibles_menores", "calidad", "apta_propuesta", "descripcion",
                     "palabras_clave", "confianza"],
    },
}
PROPS = HERRAMIENTA["input_schema"]["properties"]


# ---------------------------------------------------------------- Box (solo lectura)
_token = {"v": None, "exp": 0.0}


def entorno(nombre):
    valor = os.getenv(nombre)
    if not valor:
        sys.exit(f"Falta la variable de entorno {nombre} (mira .env.example).")
    return valor


def box_token():
    if _token["v"] and time.time() < _token["exp"] - 60:
        return _token["v"]
    r = requests.post("https://api.box.com/oauth2/token", data={
        "grant_type": "client_credentials",
        "client_id": entorno("BOX_CLIENT_ID"),
        "client_secret": entorno("BOX_CLIENT_SECRET"),
        "box_subject_type": os.getenv("BOX_SUBJECT_TYPE", "enterprise"),
        "box_subject_id": entorno("BOX_SUBJECT_ID"),
    }, timeout=30)
    if r.status_code != 200:
        sys.exit(f"Box no ha dado token ({r.status_code}): {r.text[:300]}")
    j = r.json()
    _token.update(v=j["access_token"], exp=time.time() + j.get("expires_in", 3600))
    return _token["v"]


def box_get(url, params=None, headers=None):
    r = None
    for intento in range(6):
        h = {"Authorization": f"Bearer {box_token()}"}
        if headers:
            h.update(headers)
        r = requests.get(url, params=params, headers=h, timeout=120)
        if r.status_code == 401:
            _token["v"] = None
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(int(r.headers.get("Retry-After", 2 ** intento)))
            continue
        return r
    return r


def listar_carpeta(folder_id, ruta, salida):
    offset = 0
    while True:
        r = box_get(f"{API}/folders/{folder_id}/items",
                    params={"fields": "id,type,name,size,extension,sha1", "limit": 1000, "offset": offset})
        r.raise_for_status()
        j = r.json()
        for it in j["entries"]:
            if it["id"] in EXCLUIR:
                continue
            if it["type"] == "folder":
                listar_carpeta(it["id"], f"{ruta}/{it['name']}" if ruta else it["name"], salida)
            elif (it["type"] == "file" and (it.get("extension") or "").lower() in EXTENSIONES
                  and not it["name"].startswith("._")):   # "._x.jpg": restos de Mac, no son fotos
                salida.append({"id": it["id"], "nombre": it["name"], "ruta": ruta,
                               "tamano": it.get("size", 0), "sha1": it.get("sha1")})
        offset += len(j["entries"])
        if not j["entries"] or offset >= j.get("total_count", 0):
            break


def box_representacion(file_id):
    """Pide a Box una versión JPG de 1024 px para no descargar originales de 20-30 MB."""
    r = box_get(f"{API}/files/{file_id}", params={"fields": "representations"},
                headers={"x-rep-hints": "[jpg?dimensions=1024x1024]"})
    if r.status_code != 200:
        return None
    entradas = r.json().get("representations", {}).get("entries", [])
    if not entradas:
        return None
    rep = entradas[0]
    for _ in range(15):
        estado = rep.get("status", {}).get("state")
        if estado in ("success", "viewable"):
            url = rep["content"]["url_template"].replace("{+asset_path}", "")
            c = box_get(url)
            return c.content if c.status_code == 200 else None
        if estado == "error":
            return None
        time.sleep(2)
        info = box_get(rep["info"]["url"])
        if info.status_code != 200:
            return None
        rep = info.json()
    return None


def miniatura(file_id, lado=LADO, calidad=85):
    CACHE.mkdir(parents=True, exist_ok=True)
    destino = CACHE / (f"{file_id}.jpg" if lado == LADO else f"{file_id}_{lado}.jpg")
    if destino.exists():
        return destino.read_bytes()
    base = CACHE / f"{file_id}.jpg"
    if base.exists():
        datos = base.read_bytes()
    else:
        datos = box_representacion(file_id)
        if datos is None:
            r = box_get(f"{API}/files/{file_id}/content")
            r.raise_for_status()
            datos = r.content
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(datos))).convert("RGB")
    img.thumbnail((lado, lado))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=calidad)
    destino.write_bytes(buf.getvalue())
    return buf.getvalue()


def bloque_imagen(jpg):
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.b64encode(jpg).decode()}}


def bloques_referencia():
    """Fotos de referencia de la flota; van primero y se cachean, así se pagan casi una sola vez."""
    bloques, tokens = [{"type": "text", "text": "FOTOS DE REFERENCIA DE LA FLOTA (no son la foto a catalogar):"}], 0
    for nombre, file_id, desc in REFERENCIAS:
        try:
            jpg = miniatura(file_id, lado=LADO_REF, calidad=80)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ referencia de {nombre} no disponible: {str(e)[:100]}")
            continue
        tokens += tokens_imagen(jpg)
        bloques += [{"type": "text", "text": f"Referencia «{nombre}»: {desc}"}, bloque_imagen(jpg)]
    bloques[-1]["cache_control"] = {"type": "ephemeral"}
    return bloques, tokens


# ---------------------------------------------------------------- utilidades
def leer_json(p, defecto=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else defecto


def escribir_json(p, datos):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")


def tokens_imagen(jpg):
    w, h = Image.open(io.BytesIO(jpg)).size
    return int(w * h / 750)


def precio(modelo):
    return PRECIOS_BATCH.get(modelo, (1.0, 5.0))


def rutas(foto):
    return foto.get("rutas") or [foto.get("ruta", "")]


def es_anio(t):
    return len(t) == 4 and t.isdigit()


def campana_de(ruta):
    """'2025/ISDIN/x' -> '2025/ISDIN'; 'ISDIN/x' -> 'ISDIN'; '' -> '(raíz)'."""
    partes = [x for x in (ruta or "").split("/") if x]
    if not partes:
        return "(raíz)"
    if es_anio(partes[0]) and len(partes) > 1:
        return f"{partes[0]}/{partes[1]}"
    return partes[0]


def cliente_de(ruta):
    return campana_de(ruta).split("/")[-1]


def carpetas_linea(foto):
    return {r.split("/")[0] for r in rutas(foto)} & set(LINEAS)


def normalizar(ficha):
    """Corrige mayúsculas y aparta los valores fuera de lista. Devuelve los valores corregidos."""
    fuera = []
    for campo, spec in PROPS.items():
        v = ficha.get(campo)
        if "enum" in spec:
            mapa = {e.lower(): e for e in spec["enum"]}
            if isinstance(v, str) and v.lower() in mapa:
                ficha[campo] = mapa[v.lower()]
            elif v not in (None, ""):
                fuera.append(f"{campo}={v}")
                ficha[campo] = next((x for x in ("desconocido", "otro", "ninguna") if x in spec["enum"]), "")
        elif spec.get("type") == "array" and "enum" in spec.get("items", {}):
            mapa = {e.lower(): e for e in spec["items"]["enum"]}
            lista = v if isinstance(v, list) else [v] if v else []
            buenos = []
            for x in lista:
                if isinstance(x, str) and x.lower() in mapa:
                    if mapa[x.lower()] not in buenos:
                        buenos.append(mapa[x.lower()])
                else:
                    fuera.append(f"{campo}={x}")
            ficha[campo] = buenos
    return fuera


def modelos_activos(args):
    if getattr(args, "modelos", None):
        return [m.strip() for m in args.modelos.split(",") if m.strip()]
    return MODELOS


def ids_lote(valor):
    """lotes.json guarda una lista de lotes por modelo (versiones antiguas: un solo id)."""
    return valor if isinstance(valor, list) else [valor]


def incompleta(ficha):
    return [c for c in HERRAMIENTA["input_schema"]["required"]
            if ficha.get(c) in (None, "", []) and c not in ("marca_visible",)]


def normal(texto):
    import unicodedata
    t = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode().lower()
    return "".join(ch for ch in t if ch.isalnum())


def marca_en_carpeta(marca, foto):
    """¿La marca detectada aparece en el nombre de la carpeta de cliente (o al revés)?"""
    m = normal(marca)
    if len(m) < 3:
        return None
    for r in rutas(foto):
        nombre = cliente_de(r) if r else ""
        c = normal(nombre)
        if len(c) >= 3 and nombre != "(raíz)":
            return m in c or c in m or any(len(p) >= 4 and p in m for p in
                                          [normal(x) for x in nombre.replace("_", " ").split()])
    return None


# ---------------------------------------------------------------- comandos
def cmd_listar(_args):
    raiz = box_get(f"{API}/folders/{CARPETA_RAIZ}", params={"fields": "name"})
    raiz.raise_for_status()
    print(f"Carpeta: {raiz.json()['name']} ({CARPETA_RAIZ})")
    archivos = []
    listar_carpeta(CARPETA_RAIZ, "", archivos)
    unicas = {}
    for f in archivos:
        clave = f.get("sha1") or f["id"]
        if clave in unicas:
            unicas[clave]["rutas"].append(f["ruta"])
            unicas[clave]["ids"].append(f["id"])
        else:
            unicas[clave] = {**f, "rutas": [f["ruta"]], "ids": [f["id"]]}
    fotos = list(unicas.values())
    total = len(fotos)
    fotos = fotos[:MAX_FOTOS]
    escribir_json(MANIFEST, fotos)
    print(f"Archivos de imagen: {len(archivos)} · fotos distintas: {total} "
          f"({len(archivos) - total} repetidas en varias carpetas)")
    print(f"En esta tanda: {len(fotos)} (MAX_FOTOS={MAX_FOTOS}) · "
          f"tamaño original {sum(f['tamano'] for f in fotos) / 1e9:.2f} GB")
    print(f"Coste orientativo con Haiku: ≈ {len(fotos) * 0.00045:.2f} $ · disco para miniaturas: "
          f"≈ {len(fotos) * 0.25 / 1024:.1f} GB · campañas: {len({campana_de(r) for f in fotos for r in rutas(f)})}")
    for carpeta, n in Counter((r.split("/")[0] or "(raíz)") for f in fotos for r in rutas(f)).most_common():
        print(f"  {n:4d}  {carpeta}")


def cmd_enviar(args):
    fotos = leer_json(MANIFEST)
    if not fotos:
        sys.exit("No hay manifest. Ejecuta primero: python etiquetar.py listar")
    modelos = modelos_activos(args)
    lotes = leer_json(LOTES, {}) or {}
    solo = getattr(args, "solo_incompletas", False)
    if solo:
        pendientes = pendientes_de_repetir(modelos)
        fotos = [f for f in fotos if f["id"] in pendientes]
        print(f"Repitiendo {len(fotos)} fotos incompletas o con error (se fusionan con las buenas al recoger).")
        if not fotos:
            sys.exit("No hay fotos que repetir.")
    enviadas = {m: set(v) for m, v in (leer_json(ENVIADAS, {}) or {}).items()}
    for m in modelos:
        if args.forzar:
            enviadas[m] = set()
            lotes[m] = []
        elif m in lotes and m not in enviadas:   # tandas de versiones anteriores, sin registro: todo enviado
            enviadas[m] = {f["id"] for f in fotos}
    if not solo:
        pendientes = {m: {f["id"] for f in fotos} - enviadas.get(m, set()) for m in modelos}
        quedan = set().union(*pendientes.values()) if pendientes else set()
        ya = len(fotos) - len(quedan)
        if ya:
            print(f"Reanudando: {ya} fotos ya estaban en lotes enviados; quedan {len(quedan)}.")
        fotos = [f for f in fotos if f["id"] in quedan]
        if not fotos:
            sys.exit("No queda nada por enviar (usa --forzar para empezar de cero).")

    refs, tokens_refs = bloques_referencia() if USAR_REFERENCIAS else ([], 0)
    bytes_refs = len(json.dumps(refs))
    if refs:
        print(f"Referencias de flota: {(len(refs) - 1) // 2} fotos (~{tokens_refs} tokens, en caché)")

    # 1) miniaturas en paralelo (quedan en caché en disco; no se guardan en memoria)
    print(f"Preparando {len(fotos)} miniaturas con {HILOS} descargas a la vez (caché en {CACHE}/)...")
    hechas = {"n": 0}

    def preparar(foto):
        try:
            jpg = miniatura(foto["id"])
            res = (foto, tokens_imagen(jpg), len(jpg), None)
        except Exception as e:  # noqa: BLE001
            res = (foto, 0, 0, str(e)[:120])
        hechas["n"] += 1
        if hechas["n"] % 50 == 0:
            print(f"  {hechas['n']}/{len(fotos)}")
        return res

    with ThreadPoolExecutor(max_workers=HILOS) as ex:
        preparadas = list(ex.map(preparar, fotos))
    validas = [(f, t, b) for f, t, b, err in preparadas if err is None]
    for f, _, _, err in preparadas:
        if err:
            print(f"  ⚠ no se pudo preparar {f['nombre']}: {err}")
    if not validas:
        sys.exit("No se ha podido preparar ninguna imagen.")

    # 2) repartir en lotes por tamaño
    limite = MAX_MB_LOTE * 1024 * 1024
    grupos, actual, peso = [], [], 0
    for f, t, b in validas:
        p = bytes_refs + int(b * 1.37) + 8000
        if actual and (peso + p > limite or len(actual) >= MAX_PETICIONES_LOTE):
            grupos.append(actual)
            actual, peso = [], 0
        actual.append(f)
        peso += p
    if actual:
        grupos.append(actual)

    n = len(validas)
    tokens_img = sum(t for _, t, _ in validas)
    tokens_fijos = 2200  # instrucciones + esquema, aprox.
    print(f"\n{n} fotos en {len(grupos)} lote(s) por modelo.")
    print("Coste estimado (precios Batch orientativos; referencias contadas al 30 % por la caché):")
    total = 0.0
    for modelo in modelos:
        pin, pout = precio(modelo)
        coste = ((tokens_img + n * (tokens_fijos + 0.3 * tokens_refs)) * pin + n * 450 * pout) / 1e6
        total += coste
        print(f"  {modelo:22s} {n} fotos ≈ {coste:.2f} $")
    print(f"  TOTAL ≈ {total:.2f} $")
    if not args.si and input("\n¿Enviar los lotes? [s/N] ").strip().lower() not in ("s", "si", "sí"):
        sys.exit("Cancelado. No se ha enviado nada.")

    # 3) enviar lote a lote, construyendo las peticiones solo de ese lote
    cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
    for modelo in modelos:
        lotes[modelo] = ids_lote(lotes[modelo]) if modelo in lotes else []
        hechas_m = enviadas.setdefault(modelo, set())
        grupos_m = [[f for f in g if solo or f["id"] not in hechas_m] for g in grupos]
        grupos_m = [g for g in grupos_m if g]
        for k, grupo in enumerate(grupos_m, 1):
            peticiones = []
            for foto in grupo:
                texto = f"Archivo: {foto['nombre']}"
                if INCLUIR_RUTA and any(rutas(foto)):
                    texto += "\nCarpeta: " + " | ".join(r for r in rutas(foto) if r)
                contenido = refs + [{"type": "text", "text": "FOTO A CATALOGAR:"},
                                    bloque_imagen(miniatura(foto["id"])), {"type": "text", "text": texto}]
                # tool_choice "auto": algunos modelos (p. ej. Sonnet 5.5) no aceptan forzar la herramienta.
                peticiones.append({
                    "custom_id": f"f_{foto['id']}",
                    "params": {
                        "model": modelo,
                        "max_tokens": 3000,
                        "system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                        "tools": [HERRAMIENTA],
                        "tool_choice": {"type": "auto"},
                        "messages": [{"role": "user", "content": contenido}],
                    },
                })
            lote = crear_lote(cliente, peticiones)
            lotes[modelo].append(lote.id)
            escribir_json(LOTES, lotes)
            hechas_m.update(f["id"] for f in grupo)
            escribir_json(ENVIADAS, {m: sorted(v) for m, v in enviadas.items()})
            print(f"Lote {k}/{len(grupos_m)} enviado para {modelo}: {lote.id} ({len(peticiones)} fotos)")
            del peticiones
    print("Los lotes suelen tardar de minutos a unas horas (máximo 24 h). Consulta con: python etiquetar.py estado")


def crear_lote(cliente, peticiones, intentos=40):
    """Crea un lote; si la API está saturada o hay demasiados lotes en cola, espera y reintenta."""
    for i in range(intentos):
        try:
            return cliente.messages.batches.create(requests=peticiones)
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
            espera = min(600, 60 * (i + 1))
            print(f"  API ocupada o límite de cola ({type(e).__name__}); reintento en {espera // 60} min...")
            time.sleep(espera)
        except anthropic.APIStatusError as e:
            if e.status_code in (429, 529):
                espera = min(600, 60 * (i + 1))
                print(f"  API ocupada ({e.status_code}); reintento en {espera // 60} min...")
                time.sleep(espera)
            else:
                raise
    raise RuntimeError("No se pudo crear el lote tras muchos reintentos. Relanza más tarde: reanudará.")


class EstadoModelo:
    def __init__(self, procesando, ok, error, curso, caducadas):
        self.processing_status = procesando
        self.ok, self.error, self.curso, self.caducadas = ok, error, curso, caducadas


def estados(cliente, lotes):
    res = {}
    for modelo, valor in lotes.items():
        ok = err = curso = cad = 0
        terminado = True
        for lote_id in ids_lote(valor):
            b = cliente.messages.batches.retrieve(lote_id)
            c = b.request_counts
            ok, err, curso, cad = ok + c.succeeded, err + c.errored, curso + c.processing, cad + c.expired
            terminado &= b.processing_status == "ended"
        e = EstadoModelo("ended" if terminado else "in_progress", ok, err, curso, cad)
        res[modelo] = e
        print(f"  {modelo:22s} {e.processing_status:12s} ok={ok} error={err} en curso={curso} caducadas={cad} "
              f"({len(ids_lote(valor))} lote/s)")
    return res


def cmd_estado(_args):
    lotes = leer_json(LOTES)
    if not lotes:
        sys.exit("No hay lotes enviados.")
    estados(anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY")), lotes)


def pendientes_de_repetir(modelos):
    """Fotos cuya última ficha (de alguno de esos modelos) está incompleta o falló."""
    if not RESULTADOS_JSONL.exists():
        sys.exit("No hay resultados todavía: ejecuta antes 'recoger'.")
    estado = {}
    for linea in RESULTADOS_JSONL.read_text(encoding="utf-8").splitlines():
        c = json.loads(linea)
        if c.get("modelo") not in modelos:
            continue
        mal = "error" in c or bool(incompleta(c.get("ficha") or {}))
        estado[(c["modelo"], c["file_id"])] = mal
    return {fid for (_, fid), mal in estado.items() if mal}


def resultados_de(cliente, valor):
    for lote_id in ids_lote(valor):
        yield from cliente.messages.batches.results(lote_id)


def cmd_recoger(_args):
    lotes = leer_json(LOTES)
    fotos = {f["id"]: f for f in (leer_json(MANIFEST) or [])}
    if not lotes:
        sys.exit("No hay lotes enviados.")
    cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
    st = estados(cliente, lotes)
    if any(b.processing_status != "ended" for b in st.values()):
        sys.exit("Todavía hay lotes en curso. Vuelve a probar más tarde.")

    campos = ["file_id", "nombre", "carpetas", "campana", "cliente_carpeta", "enlace_box", "modelo", "vehiculo", "tipo_vehiculo", "plano",
              "linea_principal", "lineas_servicio", "marca_visible", "fuente_marca", "personas",
              "posibles_menores", "calidad", "apta_propuesta", "descripcion", "palabras_clave", "confianza",
              "fuera_de_lista", "incompleta", "fin", "marca_en_carpeta", "uso_autorizado", "coste_usd", "version", "revision_ok", "notas_revision"]
    mejor = {}  # (modelo, file_id) -> (puntuación, fila o None, registro crudo)
    coste_modelo, motivos = Counter(), {}

    def guardar(clave, punt, fila, reg):
        if clave not in mejor or punt >= mejor[clave][0]:
            mejor[clave] = (punt, fila, reg)

    for modelo, valor in lotes.items():
        pin, pout = precio(modelo)
        for r in resultados_de(cliente, valor):
            file_id = r.custom_id.split("_", 1)[1]
            foto = fotos.get(file_id, {"nombre": "?", "ruta": ""})
            clave = (modelo, file_id)
            if r.result.type != "succeeded":
                motivo = r.result.type
                err = getattr(r.result, "error", None)
                if err is not None:
                    interno = getattr(err, "error", err)
                    motivo = f"{r.result.type}: {getattr(interno, 'message', interno)}"
                motivos.setdefault(modelo, motivo)
                guardar(clave, 0, None, {"modelo": modelo, "file_id": file_id, "error": motivo})
                continue
            msg = r.result.message
            u = msg.usage
            tin = (u.input_tokens + (u.cache_creation_input_tokens or 0) * 1.25
                   + (u.cache_read_input_tokens or 0) * 0.1)
            coste = (tin * pin + u.output_tokens * pout) / 1e6
            coste_modelo[modelo] += coste
            fin_resp = getattr(msg, "stop_reason", "") or ""
            ficha = next((b.input for b in msg.content if b.type == "tool_use"), None)
            if ficha is None:  # sin herramienta: intentar leer un JSON del texto
                texto = "".join(getattr(b, "text", "") for b in msg.content)
                try:
                    ficha = json.loads(texto[texto.index("{"): texto.rindex("}") + 1])
                except ValueError:
                    motivos.setdefault(modelo, f"respuesta sin ficha (fin: {fin_resp})")
                    guardar(clave, 0, None, {"modelo": modelo, "file_id": file_id, "error": "sin ficha",
                                             "fin": fin_resp, "texto": texto[:500]})
                    continue
            ficha = dict(ficha)
            fuera = normalizar(ficha)
            faltan = incompleta(ficha)
            lineas = ficha.get("lineas_servicio") or []
            primera = next((x for x in rutas(foto) if x), "")
            fila = {
                "file_id": file_id, "nombre": foto["nombre"],
                "carpetas": " | ".join(x or "(raíz)" for x in rutas(foto)),
                "cliente_carpeta": cliente_de(primera) if INCLUIR_RUTA else "",
                "campana": campana_de(primera),
                "enlace_box": f"https://app.box.com/file/{file_id}", "modelo": modelo,
                **{k: ficha.get(k, "") for k in PROPS},
                "linea_principal": lineas[0] if lineas else "",
                "lineas_servicio": ", ".join(lineas),
                "palabras_clave": ", ".join(ficha.get("palabras_clave", []) or []),
                "fuera_de_lista": "; ".join(fuera),
                "incompleta": ", ".join(faltan),
                "fin": fin_resp,
                "marca_en_carpeta": {True: "sí", False: "no", None: ""}[
                    marca_en_carpeta(ficha.get("marca_visible", ""), foto)] if INCLUIR_RUTA else "",
                "uso_autorizado": "publicada en web" if CARPETA_RAIZ == "379464633435" else "pendiente",
                "coste_usd": f"{coste:.5f}", "version": VERSION, "revision_ok": "", "notas_revision": "",
                "_lineas": set(lineas), "_carpetas": carpetas_linea(foto),
            }
            guardar(clave, 1 if faltan else 2, fila,
                    {"modelo": modelo, "file_id": file_id, "ficha": ficha, "fuera_de_lista": fuera,
                     "fin": fin_resp})

    filas = [f for _, f, _ in mejor.values() if f is not None]
    crudo = [c for _, _, c in mejor.values()]
    errores = Counter(m for (m, _), (p, _, _) in mejor.items() if p == 0)
    fines = Counter((f["modelo"], f["fin"]) for f in filas if f["incompleta"])

    filas.sort(key=lambda f: (f["carpetas"], f["nombre"], f["modelo"]))
    with RESULTADOS_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=campos, extrasaction="ignore")
        w.writeheader()
        w.writerows(filas)
    with RESULTADOS_JSONL.open("w", encoding="utf-8") as fh:
        for c in crudo:
            fh.write(json.dumps(c, ensure_ascii=False) + "\n")

    # ---- resumen automático
    print(f"\nResultados {VERSION}: {RESULTADOS_CSV} ({len(filas)} filas)")
    for modelo in lotes:
        fuera_n = sum(1 for f in filas if f["modelo"] == modelo and f["fuera_de_lista"])
        inc_n = sum(1 for f in filas if f["modelo"] == modelo and f["incompleta"])
        n_mod = sum(1 for f in filas if f["modelo"] == modelo)
        print(f"  {modelo:22s} fichas {n_mod}   coste real ≈ {coste_modelo[modelo]:.3f} $   errores: {errores[modelo]}   "
              f"incompletas: {inc_n}   con valores fuera de lista: {fuera_n}")
        if modelo in motivos and errores[modelo]:
            print(f"      primer error: {motivos[modelo]}")
        cortes = {fin: n for (m, fin), n in fines.items() if m == modelo}
        if cortes:
            print(f"      motivo de fin en las incompletas: {cortes}")

    if INCLUIR_RUTA:
        print("\nMarca detectada frente al cliente de la carpeta:")
        for modelo in lotes:
            c = Counter(f["marca_en_carpeta"] for f in filas if f["modelo"] == modelo)
            ev = c["sí"] + c["no"]
            if ev:
                print(f"  {modelo:22s} coincide {c['sí']}/{ev} = {c['sí'] / ev:.0%}   "
                      f"(sin marca o sin carpeta: {c['']})")

    print("\nLínea de servicio frente a la carpeta (fotos en carpetas con nombre de línea):")
    for modelo in lotes:
        ev = [f for f in filas if f["modelo"] == modelo and f["_carpetas"]]
        if ev:
            alguna = sum(bool(f["_lineas"] & f["_carpetas"]) for f in ev)
            principal = sum(f["linea_principal"] in f["_carpetas"] for f in ev)
            print(f"  {modelo:22s} alguna coincide {alguna}/{len(ev)} = {alguna / len(ev):.0%}   "
                  f"la principal {principal}/{len(ev)} = {principal / len(ev):.0%}")
        por_linea = Counter()
        aciertos = Counter()
        for f in ev:
            for c in f["_carpetas"]:
                por_linea[c] += 1
                aciertos[c] += c in f["_lineas"]
        for c in LINEAS:
            if por_linea[c]:
                print(f"      {c:42s} {aciertos[c]}/{por_linea[c]}")

    por_foto = {}
    for f in filas:
        por_foto.setdefault(f["file_id"], {})[f["modelo"]] = f
    mods = list(lotes)
    if len(mods) >= 2:
        a, b = mods[0], mods[1]
        pares = [d for d in por_foto.values() if a in d and b in d]
        if pares:
            print(f"\nCoincidencia {a} vs {b} ({len(pares)} fotos):")
            for campo in ("vehiculo", "tipo_vehiculo", "plano", "linea_principal", "posibles_menores",
                          "apta_propuesta"):
                igual = sum(str(d[a][campo]) == str(d[b][campo]) for d in pares)
                print(f"  {campo:18s} {igual / len(pares):5.0%}")

    for modelo in lotes:
        flota = Counter(f["vehiculo"] for f in filas if f["modelo"] == modelo and f["vehiculo"] in FLOTA)
        if flota:
            print(f"\nVehículos de la flota detectados por {modelo}: "
                  + ", ".join(f"{k} {v}" for k, v in flota.most_common()))
    menores = {f["nombre"] for f in filas if f["posibles_menores"] in ("sí", "dudoso")}
    if menores:
        print(f"\nFotos marcadas con posibles menores ({len(menores)}): revisar antes de usarlas en material comercial.")


# ---------------------------------------------------------------- flota por campaña (Sonnet)
FOTOS_POR_CAMPANA = int(os.getenv("FOTOS_POR_CAMPANA", "3"))

SYSTEM_FLOTA = f"""Eres el responsable de flota de alegria-activity. Tienes las fotos de referencia de los \
vehículos propios de la agencia ({", ".join(FLOTA)}; de Cotazero no hay foto) y varias fotos de UNA campaña. \
En una campaña se suele usar un mismo vehículo. Di qué vehículo o vehículos de la flota aparecen en las fotos de \
la campaña, comparando forma, proporciones, número de ejes, cabina, partes expandibles y estructura con las \
referencias. La rotulación cambia en cada campaña: no te fíes de colores ni logotipos. Muchas campañas usan \
unidades fabricadas para el cliente, vehículos alquilados o vehículos antiguos de la agencia que ya no existen \
(autobuses de 12 o 15 m, tráileres antiguos...): todos esos NO son de la flota actual; marca \
ninguno_de_la_flota = true e indica su tipo en tipo_si_no_flota.
Regla del 13,80: es un autocar cuyo lateral se DESPLIEGA formando un módulo saliente. Elige 13,80 solo si en \
alguna foto se ve ese lateral desplegado, o las juntas y guías del módulo cuando está cerrado. Un autobús o \
autocar sin lateral desplegable NO es el 13,80: es "autobús".
Si no estás seguro, confianza "baja". Llama directamente a la herramienta guardar_vehiculo, sin escribir texto antes."""

HERRAMIENTA_FLOTA = {
    "name": "guardar_vehiculo",
    "description": "Guarda qué vehículo(s) de la flota se usan en la campaña.",
    "input_schema": {
        "type": "object",
        "properties": {
            "vehiculos": {"type": "array", "maxItems": 3, "items": {"type": "string", "enum": FLOTA}},
            "ninguno_de_la_flota": {"type": "boolean"},
            "tipo_si_no_flota": {"type": "string", "enum": [
                "autobús", "tráiler o semirremolque", "camión", "furgoneta", "remolque o caravana", "otro", ""]},
            "lateral_desplegable_visible": {"type": "boolean"},
            "confianza": {"type": "string", "enum": ["alta", "media", "baja"]},
            "explicacion": {"type": "string", "description": "1-2 frases: en qué rasgos te basas."},
        },
        "required": ["vehiculos", "ninguno_de_la_flota", "confianza", "explicacion"],
    },
}


def leer_resultados():
    if not RESULTADOS_CSV.exists():
        sys.exit("No hay resultados.csv: ejecuta antes 'recoger'.")
    with RESULTADOS_CSV.open(encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def elegir_fotos_campana(filas):
    def orden(f):
        return ({"alta": 0, "media": 1}.get(f.get("calidad"), 2), f.get("apta_propuesta") != "True",
                {"alta": 0, "media": 1}.get(f.get("confianza"), 2))
    exteriores = sorted((f for f in filas if f.get("plano") == "exterior del vehículo"), key=orden)
    if exteriores:
        return exteriores[:FOTOS_POR_CAMPANA]
    interiores = sorted((f for f in filas if f.get("plano") == "interior del vehículo"), key=orden)
    return interiores[:2]


def vehiculos_de(texto):
    """'13,80, Semirremolque' -> ['13,80', 'Semirremolque'] (ojo: '13,80' lleva coma)."""
    return [v.strip() for v in (texto or "").split(", ") if v.strip()]


def cmd_flota(args):
    revisar = getattr(args, "revisar", None)
    if revisar or not (LOTES_FLOTA.exists() and not args.forzar):
        filas = [f for f in leer_resultados() if not f.get("modelo") or f["modelo"] == MODELOS[0]]
        por_campana = {}
        for f in filas:
            por_campana.setdefault(f.get("campana") or campana_de(f["carpetas"].split(" | ")[0]), []).append(f)
        if revisar:
            if not FLOTA_CSV.exists():
                sys.exit("No hay flota_campanas.csv que revisar: ejecuta antes 'flota'.")
            with FLOTA_CSV.open(encoding="utf-8-sig") as fh:
                previas = list(csv.DictReader(fh))
            objetivo = {r["campana"] for r in previas if revisar in vehiculos_de(r["vehiculos"])}
            (DATA / "flota_campanas_anterior.csv").write_bytes(FLOTA_CSV.read_bytes())
            por_campana = {c: fs for c, fs in por_campana.items() if c in objetivo}
            print(f"Revisando {len(por_campana)} campañas asignadas a «{revisar}» "
                  f"(copia de la versión anterior en flota_campanas_anterior.csv)")
        elegidas = {c: elegir_fotos_campana(fs) for c, fs in por_campana.items()}
        sin = sorted(c for c, fs in elegidas.items() if not fs)
        elegidas = {c: fs for c, fs in elegidas.items() if fs}
        print(f"Campañas: {len(por_campana)} · con fotos de vehículo: {len(elegidas)} · sin ninguna: {len(sin)}")
        if not elegidas:
            sys.exit("Ninguna campaña tiene fotos de vehículo.")
        refs, _ = bloques_referencia()
        pin, pout = precio(MODELO_FLOTA)
        estimado = len(elegidas) * ((2500 + FOTOS_POR_CAMPANA * 1400 + 1000) * pin + 400 * pout) / 1e6
        print(f"Coste estimado con {MODELO_FLOTA} (Batch): ≈ {estimado:.2f} $")
        if not args.si and input("¿Enviar? [s/N] ").strip().lower() not in ("s", "si", "sí"):
            sys.exit("Cancelado. No se ha enviado nada.")
        cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
        estado = {"lotes": [], "campanas": {}, "revision": bool(revisar)}
        claves = sorted(elegidas)
        tam = max(1, int(MAX_MB_LOTE * 1024 * 1024 / (len(json.dumps(refs)) + FOTOS_POR_CAMPANA * 450_000)))
        for k in range(0, len(claves), tam):
            peticiones = []
            for j, camp in enumerate(claves[k:k + tam], start=k):
                contenido = refs + [{"type": "text", "text": f"CAMPAÑA: {camp} · {len(por_campana[camp])} fotos en total"}]
                for f in elegidas[camp]:
                    contenido += [bloque_imagen(miniatura(f["file_id"])),
                                  {"type": "text", "text": f"Descripción automática: {f.get('descripcion', '')}"}]
                cid = f"c{j}"
                estado["campanas"][cid] = {"campana": camp, "n_fotos": len(por_campana[camp]),
                                           "fotos": [f["file_id"] for f in elegidas[camp]]}
                peticiones.append({"custom_id": cid, "params": {
                    "model": MODELO_FLOTA, "max_tokens": 1500,
                    "system": [{"type": "text", "text": SYSTEM_FLOTA, "cache_control": {"type": "ephemeral"}}],
                    "tools": [HERRAMIENTA_FLOTA], "tool_choice": {"type": "auto"},
                    "messages": [{"role": "user", "content": contenido}]}})
            lote = crear_lote(cliente, peticiones)
            estado["lotes"].append(lote.id)
            escribir_json(LOTES_FLOTA, estado)
            print(f"Lote de flota enviado: {lote.id} ({len(peticiones)} campañas)")
        if sin:
            print("Sin fotos de vehículo (no se consultan): " + ", ".join(sin[:20]) + (" …" if len(sin) > 20 else ""))
    cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
    while True:
        estado = leer_json(LOTES_FLOTA)
        lotes = [cliente.messages.batches.retrieve(i) for i in estado["lotes"]]
        print(time.strftime("%H:%M:%S"), "flota:", ", ".join(f"{b.processing_status}" for b in lotes))
        if all(b.processing_status == "ended" for b in lotes) or getattr(args, "sin_esperar", False):
            break
        time.sleep(60)
    cmd_flota_recoger(args)


def cmd_flota_recoger(_args):
    estado = leer_json(LOTES_FLOTA)
    if not estado:
        sys.exit("No hay consulta de flota enviada: ejecuta 'flota'.")
    cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
    lotes = [cliente.messages.batches.retrieve(i) for i in estado["lotes"]]
    if any(b.processing_status != "ended" for b in lotes):
        sys.exit("La consulta de flota sigue en curso. Vuelve a probar más tarde.")
    pin, pout = precio(MODELO_FLOTA)
    filas, coste = [], 0.0
    for lote_id in estado["lotes"]:
        for r in cliente.messages.batches.results(lote_id):
            info = estado["campanas"].get(r.custom_id, {})
            fila = {"campana": info.get("campana", r.custom_id), "n_fotos": info.get("n_fotos", ""),
                    "fotos_usadas": " ".join(f"https://app.box.com/file/{x}" for x in info.get("fotos", [])),
                    "vehiculos": "", "ninguno_de_la_flota": "", "tipo_si_no_flota": "",
                    "lateral_desplegable": "", "confianza": "", "explicacion": "",
                    "confirmado": "", "vehiculo_correcto": ""}
            if r.result.type == "succeeded":
                msg = r.result.message
                u = msg.usage
                coste += ((u.input_tokens + (u.cache_creation_input_tokens or 0) * 1.25
                           + (u.cache_read_input_tokens or 0) * 0.1) * pin + u.output_tokens * pout) / 1e6
                d = next((b.input for b in msg.content if b.type == "tool_use"), None)
                if d is None:
                    texto = "".join(getattr(b, "text", "") for b in msg.content)
                    try:
                        d = json.loads(texto[texto.index("{"): texto.rindex("}") + 1])
                    except ValueError:
                        d = {"explicacion": "ERROR: respuesta sin ficha"}
                validos = [v for v in (d.get("vehiculos") or []) if v in FLOTA]
                desplegable = d.get("lateral_desplegable_visible")
                tipo = d.get("tipo_si_no_flota") or ""
                # regla del 13,80: sin lateral desplegable visible es un autobús, no el 13,80
                if "13,80" in validos and desplegable is False:
                    validos.remove("13,80")
                    tipo = tipo or "autobús"
                ninguno = bool(d.get("ninguno_de_la_flota")) or not validos
                fila.update(vehiculos=", ".join(validos),
                            ninguno_de_la_flota="sí" if ninguno else "no",
                            tipo_si_no_flota=tipo if ninguno else "",
                            lateral_desplegable={True: "sí", False: "no"}.get(desplegable, ""),
                            confianza=d.get("confianza", ""), explicacion=d.get("explicacion", ""))
            else:
                fila["explicacion"] = f"ERROR: {r.result.type}"
            filas.append(fila)
    if estado.get("revision"):
        anterior = DATA / "flota_campanas_anterior.csv"
        with anterior.open(encoding="utf-8-sig") as fh:
            base = {r["campana"]: r for r in csv.DictReader(fh)}
        cambios = Counter()
        for f in filas:
            antes = base.get(f["campana"], {}).get("vehiculos", "")
            cambios[f"{antes or '—'} → {f['vehiculos'] or (f['tipo_si_no_flota'] or 'ninguno')}"] += 1
            base[f["campana"]] = f
        print("Cambios de la revisión: " + ", ".join(f"{k}: {n}" for k, n in cambios.most_common()))
        filas = [{**{k: "" for k in filas[0]}, **r} for r in base.values()]
    filas.sort(key=lambda f: f["campana"])
    with FLOTA_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0]))
        w.writeheader()
        w.writerows(filas)
    # añadir el vehículo de la campaña a cada foto
    por_campana = {f["campana"]: f for f in filas}
    res = leer_resultados()
    salida = DATA / "resultados_flota.csv"
    with salida.open("w", newline="", encoding="utf-8-sig") as fh:
        campos = list(res[0]) + ["vehiculo_campana", "confianza_vehiculo_campana"]
        w = csv.DictWriter(fh, fieldnames=campos)
        w.writeheader()
        for f in res:
            c = por_campana.get(f.get("campana") or campana_de(f["carpetas"].split(" | ")[0]), {})
            veh = c.get("vehiculos") or (
                f"{c['tipo_si_no_flota']} (no de la flota actual)" if c.get("tipo_si_no_flota")
                else "ninguno de la flota" if c.get("ninguno_de_la_flota") == "sí" else "")
            w.writerow({**f, "vehiculo_campana": veh, "confianza_vehiculo_campana": c.get("confianza", "")})
    cuenta = Counter(v for f in filas for v in vehiculos_de(f["vehiculos"]))
    print(f"\nFlota por campaña: {FLOTA_CSV} ({len(filas)} campañas, coste ≈ {coste:.2f} $)")
    print("  " + ", ".join(f"{k} {n}" for k, n in cuenta.most_common()) +
          f" · ninguno de la flota: {sum(f['ninguno_de_la_flota'] == 'sí' for f in filas)}")
    print(f"Fotos con el vehículo de su campaña: {salida}")


# ---------------------------------------------------------------- índice para el buscador del conector
def vehiculo_foto(f):
    """La etiqueta de flota de una foto (Haiku) solo se mantiene si su campaña no la contradice."""
    v = f.get("vehiculo", "")
    camp = f.get("vehiculo_campana")
    if v in FLOTA and camp is not None and camp != "" and v not in vehiculos_de(camp):
        return "otro vehículo"
    return v


def cmd_indice(args):
    """Junta los resultados de varias tandas en un indice.json para la herramienta buscar_fotos."""
    tandas = [Path(x.strip()) for x in (args.tandas or str(DATA)).split(",") if x.strip()]
    salida = Path(os.getenv("INDICE_SALIDA", str(DATA.parent / "indice.json" if DATA.name != "datos" else DATA / "indice.json")))
    preferencia = ["claude-sonnet-5-5", "claude-haiku-5-5"]   # si una foto tiene las dos fichas, gana Sonnet
    registros = {}
    for d in tandas:
        archivo = d / "resultados_flota.csv" if (d / "resultados_flota.csv").exists() else d / "resultados.csv"
        if not archivo.exists():
            print(f"  ⚠ {d}: no tiene resultados, la salto")
            continue
        with archivo.open(encoding="utf-8-sig") as fh:
            filas = list(csv.DictReader(fh))
        usadas = 0
        for f in filas:
            fid = f["file_id"]
            rango = preferencia.index(f["modelo"]) if f.get("modelo") in preferencia else 9
            previo = registros.get(fid)
            if previo and previo["_rango"] <= rango:
                continue
            camp = f.get("campana") or campana_de(f["carpetas"].split(" | ")[0])
            anio = camp.split("/")[0] if es_anio(camp.split("/")[0]) else ""
            registros[fid] = {
                "id": fid, "nombre": f["nombre"], "carpetas": f["carpetas"], "campana": camp,
                "cliente": f.get("cliente_carpeta") or cliente_de(f["carpetas"].split(" | ")[0]),
                "anio": int(anio) if anio else None,
                "vehiculo": vehiculo_foto(f), "vehiculo_campana": f.get("vehiculo_campana", ""),
                "conf_vehiculo_campana": f.get("confianza_vehiculo_campana", ""),
                "tipo_vehiculo": f.get("tipo_vehiculo", ""), "plano": f.get("plano", ""),
                "lineas": [x.strip() for x in (f.get("lineas_servicio") or f.get("linea_servicio") or "").split(",") if x.strip()],
                "marca": f.get("marca_visible", ""), "personas": f.get("personas", ""),
                "menores": f.get("posibles_menores", ""), "calidad": f.get("calidad", ""),
                "apta": f.get("apta_propuesta") == "True", "uso": f.get("uso_autorizado", ""),
                "descripcion": f.get("descripcion", ""),
                "palabras": [x.strip() for x in (f.get("palabras_clave") or "").split(",") if x.strip()],
                "tanda": d.name, "_rango": rango,
            }
            usadas += 1
        print(f"  {d}: {len(filas)} fichas leídas, {usadas} añadidas o mejoradas")
    datos = [{k: v for k, v in r.items() if not k.startswith("_")} for r in registros.values()]
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(json.dumps({"version": VERSION, "generado": time.strftime("%Y-%m-%d %H:%M"),
                                  "fotos": datos}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Índice: {salida} · {len(datos)} fotos · {salida.stat().st_size / 1e6:.1f} MB")


def cmd_todo(args):
    if not MANIFEST.exists():
        cmd_listar(args)
    lotes = leer_json(LOTES, {}) or {}
    fotos = leer_json(MANIFEST) or []
    enviadas = leer_json(ENVIADAS, {}) or {}
    falta = any(m not in lotes or (m in enviadas and len(enviadas[m]) < len(fotos))
                for m in modelos_activos(args))
    if args.forzar or args.solo_incompletas or falta:
        try:
            cmd_enviar(args)
        except SystemExit as e:
            if not leer_json(LOTES):
                raise
            print(e, "· sigo con los lotes ya enviados.")
    cliente = anthropic.Anthropic(api_key=entorno("ANTHROPIC_API_KEY"))
    while True:
        print(time.strftime("%H:%M:%S"), "estado de los lotes:")
        if all(b.processing_status == "ended" for b in estados(cliente, leer_json(LOTES)).values()):
            break
        time.sleep(120)
    cmd_recoger(args)


def main():
    p = argparse.ArgumentParser(description="Piloto de etiquetado de fotos de Box con Claude")
    p.add_argument("comando", choices=["listar", "enviar", "estado", "recoger", "todo", "flota", "flota-recoger",
                                          "indice"])
    p.add_argument("--si", action="store_true", help="no pedir confirmación antes de enviar")
    p.add_argument("--forzar", action="store_true", help="sustituir el lote de los modelos indicados")
    p.add_argument("--modelos", help="modelos a enviar, separados por comas (por defecto, MODELOS)")
    p.add_argument("--revisar", help="con flota: vuelve a consultar solo las campañas asignadas a este "
                                     "vehículo (p. ej. 13,80) y fusiona el resultado")
    p.add_argument("--tandas", help="con indice: carpetas de resultados separadas por comas "
                                    "(p. ej. /app/datos/archivo,/app/datos)")
    p.add_argument("--solo-incompletas", action="store_true",
                   help="con enviar/todo: repite solo las fotos con ficha incompleta o error y las fusiona")
    args = p.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    {"listar": cmd_listar, "enviar": cmd_enviar, "estado": cmd_estado, "recoger": cmd_recoger,
     "todo": cmd_todo, "flota": cmd_flota, "flota-recoger": cmd_flota_recoger,
     "indice": cmd_indice}[args.comando](args)


if __name__ == "__main__":
    main()
