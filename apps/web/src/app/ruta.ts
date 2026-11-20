// Enlace entre router.mjs (lógica pura) y el navegador: history.pushState y popstate.
// El estado del historial siempre es null: nada de la verificación viaja en la URL ni en history.state.
import { useMemo, useSyncExternalStore } from 'react';
import { resolverRuta } from './router.mjs';

const EVENTO = 'siga-e:ruta';

function suscribir(aviso: () => void): () => void {
  window.addEventListener('popstate', aviso);
  window.addEventListener(EVENTO, aviso);
  return () => {
    window.removeEventListener('popstate', aviso);
    window.removeEventListener(EVENTO, aviso);
  };
}

const leerRuta = (): string => window.location.pathname;
const rutaDelServidor = (): string => '/';

export function useRuta() {
  const pathname = useSyncExternalStore(suscribir, leerRuta, rutaDelServidor);
  return useMemo(() => resolverRuta(pathname), [pathname]);
}

/** Navega solo a rutas conocidas; cualquier otra entrada se ignora. */
export function navegar(destino: string, opciones: { reemplazar?: boolean } = {}): void {
  const r = resolverRuta(destino);
  if (!r.conocida) return;
  if (r.ruta === window.location.pathname && !opciones.reemplazar) return;
  if (opciones.reemplazar) window.history.replaceState(null, '', r.ruta);
  else window.history.pushState(null, '', r.ruta);
  window.dispatchEvent(new Event(EVENTO));
}
