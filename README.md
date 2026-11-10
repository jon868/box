# Piloto de etiquetado de fotos de Box

Etiqueta con Claude (Batch API) las fotos de
`00.COMPARTIDO / 1. Material Comercial / 15. Web 2025 / Fotos y videos / Fotos`
y compara Haiku 5.5 con Sonnet 5.5. **Solo lee de Box**: no escribe, mueve ni borra nada.

## 1. Antes de empezar
- En la Console de Anthropic crea una API key nueva (p. ej. `etiquetado-fotos`) con un límite de gasto de 10 $.
- Ten a mano las credenciales de la app de Box "claudebox" (las mismas que usa el conector).

## 2. Crear el servicio en Easypanel
1. En tu proyecto de Easypanel: **+ Service → App**, nombre `etiquetado-fotos`.
2. **Source → GitHub**: este repositorio, rama `main`. **Build**: Dockerfile.
3. **Environment**: pega estas variables con tus valores (no las subas nunca al repo):
   ```
   ANTHROPIC_API_KEY=...
   BOX_CLIENT_ID=...
   BOX_CLIENT_SECRET=...
   BOX_SUBJECT_TYPE=enterprise
   BOX_SUBJECT_ID=...
   BOX_FOLDER_ID=379464633435
   MODELOS=claude-haiku-5-5,claude-sonnet-5-5
   MAX_FOTOS=250
   INCLUIR_RUTA=false
   DESCARGA_USUARIO=alegria
   DESCARGA_PASSWORD=una-contraseña-larga
   ```
4. **Mounts**: añade un volumen (p. ej. `datos`) montado en `/app/datos`, para que los resultados
   sobrevivan a los redespliegues.
5. **Domains**: asigna un dominio con HTTPS al puerto `8080`.
6. **Deploy**.

## 3. Ejecutar el piloto (consola del servicio en Easypanel)
```bash
python etiquetar.py listar     # cuenta las fotos y las agrupa por carpeta
python etiquetar.py todo       # prepara miniaturas, enseña el coste, pide confirmación y espera
```
Si cierras la consola mientras se procesan los lotes no se pierde nada: más tarde
```bash
python etiquetar.py estado
python etiquetar.py recoger
```

### Repetir el piloto (p. ej. tras cambiar las instrucciones)
```bash
python etiquetar.py listar            # rehace el listado (agrupa fotos repetidas)
python etiquetar.py todo --forzar     # vuelve a enviar todos los modelos
python etiquetar.py enviar --modelos claude-sonnet-5-5 --forzar   # o solo uno
python etiquetar.py todo --solo-incompletas   # repite solo fichas incompletas o con error y las fusiona
```

### Otra tanda en una carpeta distinta (p. ej. el archivo de 2025)
Cada tanda va en su propia subcarpeta de `datos/`, así no pisa resultados anteriores. En la consola:
```bash
export BOX_FOLDER_ID=302472928787 INCLUIR_RUTA=true MAX_FOTOS=10000 \
       MODELOS=claude-haiku-5-5 DATA_DIR=/app/datos/2025
python etiquetar.py listar
python etiquetar.py todo
```
El `export` solo dura mientras la consola está abierta: si vuelves más tarde, repítelo antes de
`estado` o `recoger`. Si hay muchas fotos, el script las reparte solo en varios lotes.

### Archivo completo, en segundo plano
```bash
export BOX_FOLDER_ID=6895313990 INCLUIR_RUTA=true MAX_FOTOS=100000 \
       MODELOS=claude-haiku-5-5 DATA_DIR=/app/datos/archivo
python etiquetar.py listar                    # cuenta fotos, coste y disco necesario
df -h /app/datos                              # comprueba que hay sitio para las miniaturas
mkdir -p /app/datos/archivo
nohup python etiquetar.py todo --si > /app/datos/archivo/log.txt 2>&1 &
tail -f /app/datos/archivo/log.txt            # Ctrl+C deja de mirar; el proceso sigue
```
- Sigue funcionando aunque cierres la consola, pero **no redespliegues** el servicio mientras corre.
- Si se corta, relanza la misma línea de `nohup`: reanuda y solo envía lo que falta.
- El log también se ve en `https://<tu-dominio>/archivo/log.txt`.

### Vehículo de la flota por campaña (Sonnet)
Con el mismo `export` de la tanda:
```bash
python etiquetar.py flota           # 3 fotos por campaña, pide confirmación, espera y recoge
python etiquetar.py flota-recoger   # si cerraste antes de que terminara
```
Genera `flota_campanas.csv` (una fila por campaña, con columnas para confirmar) y
`resultados_flota.csv` (cada foto con el vehículo de su campaña).

### Índice para el buscador del conector de Box
```bash
DATA_DIR=/app/datos python etiquetar.py indice --tandas /app/datos/archivo,/app/datos
```
Genera `/app/datos/indice.json` (servido en `https://<tu-dominio>/indice.json` con la contraseña de descarga).
El conector Box_alegria lo descarga con `INDICE_URL`, `INDICE_USUARIO` e `INDICE_PASSWORD`.

## 4. Descargar los resultados
Abre `https://<tu-dominio>/` con el usuario y la contraseña de descarga y baja `resultados.csv` (o `2025/resultados.csv` para esa tanda)
(una fila por foto y modelo, con enlace a Box y columnas vacías `revision_ok` y `notas_revision`).

## 5. Al terminar
- Para el servicio o quita el dominio: el CSV contiene información de campañas de clientes.
- Si no vas a repetir, borra el volumen `datos` (miniaturas incluidas).

## Notas
- Los precios del script son orientativos; el coste real está en la Console.
- La app de Box necesita acceso de lectura a la carpeta (si el conector ya la ve, vale).
- En local también funciona: `pip install -r requirements.txt`, copia `.env.example` a `.env` y ejecuta los mismos comandos.
