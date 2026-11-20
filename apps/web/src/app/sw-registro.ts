// Registro del service worker (D05). Solo en producción y con soporte del navegador.
// La actualización nunca se aplica sola: el SW nuevo queda en espera y la persona decide cuándo
// (aviso «actualización disponible»). Sin conexión a la API ni almacenamiento: solo estado en memoria.
import { useSyncExternalStore } from 'react';

const RUTA_SW = '/sw.js';

let esperando: ServiceWorker | null = null;
let recargando = false;
const oyentes = new Set<() => void>();

function avisar(): void {
  oyentes.forEach((o) => o());
}

function marcarEnEspera(sw: ServiceWorker | null): void {
  // Sin controlador es la primera instalación: no hay versión que reemplazar ni aviso que dar.
  if (!sw || !navigator.serviceWorker.controller || esperando === sw) return;
  esperando = sw;
  avisar();
}

function vigilar(registro: ServiceWorkerRegistration): void {
  marcarEnEspera(registro.waiting);
  registro.addEventListener('updatefound', () => {
    const nuevo = registro.installing;
    if (!nuevo) return;
    nuevo.addEventListener('statechange', () => {
      if (nuevo.state === 'installed') marcarEnEspera(registro.waiting ?? nuevo);
    });
  });
}

/** Registra /sw.js. No hace nada en desarrollo ni en navegadores sin service workers. */
export function registrarServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) {
    // Un SW de una ejecución de producción anterior puede seguir controlando el
    // origen local aunque Vite esté en desarrollo y ya no lo registre.
    void navigator.serviceWorker.getRegistrations()
      .then(async (registros) => {
        const resultados = await Promise.all(registros.map((registro) => registro.unregister()));
        if (resultados.some((eliminado) => !eliminado)) {
          console.error('[SIGA-E] No se pudieron limpiar todos los service workers de desarrollo.');
        }
      })
      .catch((error: unknown) => {
        console.error('[SIGA-E] No se pudieron consultar o limpiar los service workers de desarrollo.', error);
      });
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(RUTA_SW, { scope: '/', updateViaCache: 'none' })
      .then(vigilar)
      .catch((error: unknown) => {
        // Sin service worker la aplicación sigue funcionando en línea; no hay nada que mostrar.
        console.error('[SIGA-E] No se pudo registrar el service worker de producción.', error);
      });
  });
}

/** Pide al SW en espera que se active y recarga cuando cambie el controlador. */
export function aplicarActualizacion(): void {
  if (!esperando || recargando) return;
  recargando = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  esperando.postMessage({ type: 'SKIP_WAITING' });
}

function suscribir(aviso: () => void): () => void {
  oyentes.add(aviso);
  return () => {
    oyentes.delete(aviso);
  };
}

export function useActualizacionDisponible(): boolean {
  return useSyncExternalStore(
    suscribir,
    () => esperando !== null,
    () => false,
  );
}
