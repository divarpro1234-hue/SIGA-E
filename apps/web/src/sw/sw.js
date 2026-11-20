// Service worker manual de SIGA-E (D05). Clásico, sin dependencias, sin Workbox.
// Plantilla: tools/generar-sw.mjs sustituye los dos marcadores de abajo y escribe dist/sw.js.
//   - VERSION: huella de 12 caracteres derivada del contenido del build.
//   - PRECACHE: pares [url, integridad SRI] de los recursos del propio build.
//   - RUTAS: rutas de la SPA (las mismas de src/app/router.mjs), para servir el shell sin red.
// Solo sirve recursos del mismo origen y con versión. No guarda nada que no sea del build, no
// intercepta métodos distintos de GET ni peticiones a otros orígenes, y no cambia de versión en mitad
// de una sesión: el cliente decide cuándo con el mensaje SKIP_WAITING.
// @ts-nocheck — se ejecuta en ServiceWorkerGlobalScope, que la configuración DOM de tsc no describe.

const VERSION = '__VERSION__';
const PRECACHE = JSON.parse('__PRECACHE__');
const RUTAS = new Set(JSON.parse('__RUTAS__'));

const PREFIJO = 'siga-e-';
const CACHE = PREFIJO + VERSION;
const CONCHA = '/index.html';
const URLS = new Set(PRECACHE.map(([url]) => url));

/** Solo se guarda lo que es una respuesta 200 del mismo origen (type «basic») y sin redirecciones. */
function guardable(respuesta) {
  return respuesta.status === 200 && respuesta.type === 'basic' && !respuesta.redirected;
}

/** Misma regla que normalizarRuta de router.mjs (hay una prueba de paridad): sin barras repetidas ni final. */
function normalizar(ruta) {
  let r = ruta.replace(/\/{2,}/g, '/');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r === '' ? '/' : r;
}

async function precachear() {
  const cache = await caches.open(CACHE);
  // Todo o nada: si un recurso falla o su integridad no coincide, la instalación falla y sigue la versión anterior.
  await Promise.all(
    PRECACHE.map(async ([url, integrity]) => {
      const respuesta = await fetch(new Request(url, { cache: 'reload', integrity, credentials: 'omit' }));
      if (!guardable(respuesta)) throw new Error('Recurso no guardable: ' + url);
      await cache.put(url, respuesta);
    }),
  );
}

async function limpiar() {
  const nombres = await caches.keys();
  await Promise.all(nombres.filter((n) => n.startsWith(PREFIJO) && n !== CACHE).map((n) => caches.delete(n)));
}

async function cachePrimero(peticion, url) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(url);
  return guardada ?? fetch(peticion);
}

/**
 * Navegación a una ruta de la SPA: el shell precacheado, sin pasar por la red (cache-first).
 * Si por algún motivo no está guardado, se cae a la red como cualquier otra navegación.
 */
async function navegacionDeLaApp(peticion) {
  const cache = await caches.open(CACHE);
  const concha = await cache.match(CONCHA);
  return concha ?? navegacion(peticion);
}

/** Cualquier otra navegación (ruta desconocida): red primero y, sin red, el shell guardado. */
async function navegacion(peticion) {
  try {
    return await fetch(peticion);
  } catch {
    const cache = await caches.open(CACHE);
    const concha = await cache.match(CONCHA);
    if (concha) return concha;
    throw new Error('Sin red y sin copia guardada');
  }
}

// Sin skipWaiting automático: la versión nueva espera a que la persona la acepte.
self.addEventListener('install', (evento) => {
  evento.waitUntil(precachear());
});

// Sin clients.claim: las pestañas abiertas conservan el service worker con el que empezaron.
self.addEventListener('activate', (evento) => {
  evento.waitUntil(limpiar());
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  // Lo que no es GET o no es del mismo origen no se intercepta: lo gestiona el navegador.
  if (peticion.method !== 'GET') return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;
  // La API y el propio service worker nunca pasan por aquí: ni caché ni shell de respaldo.
  if (url.pathname === '/sw.js' || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (peticion.mode === 'navigate') {
    const ruta = normalizar(url.pathname);
    evento.respondWith(RUTAS.has(ruta) ? navegacionDeLaApp(peticion) : navegacion(peticion));
    return;
  }
  if (url.search === '' && URLS.has(url.pathname)) {
    evento.respondWith(cachePrimero(peticion, url.pathname));
  }
});

self.addEventListener('message', (evento) => {
  const datos = evento.data;
  if (evento.origin !== self.location.origin) return;
  if (!datos || typeof datos !== 'object' || datos.type !== 'SKIP_WAITING') return;
  const fuente = evento.source;
  if (!fuente || typeof fuente.url !== 'string') return;
  if (new URL(fuente.url).origin !== self.location.origin) return;
  self.skipWaiting();
});
