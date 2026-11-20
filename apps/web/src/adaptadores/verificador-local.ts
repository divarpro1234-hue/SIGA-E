// Verificador de producción: @siga-e/verify en el navegador, con el catálogo de DEMOSTRACIÓN
// alojado en el mismo origen. El JWS nunca sale del dispositivo.
import { CatalogoNoDisponible } from '../dominio/errores';
import type { ResultadoVerificacion, Verificador } from '../dominio/tipos';
import { MAX_BYTES_CATALOGO, interpretarCatalogo } from '../lib/catalogo-confianza.mjs';
import { verificarLocal } from '../lib/verificacion-local.mjs';

export const URL_CATALOGO = '/catalogo/catalogo-demostracion.json';

type Catalogo = Extract<Awaited<ReturnType<typeof interpretarCatalogo>>, { ok: true }>;
let catalogoCargado: Catalogo | null = null;

async function cargarCatalogo(): Promise<Catalogo> {
  if (catalogoCargado) return catalogoCargado;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const respuesta = await fetch(URL_CATALOGO, { credentials: 'omit' });
    if (!respuesta.ok) throw new CatalogoNoDisponible();
    const buffer = await respuesta.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES_CATALOGO) throw new CatalogoNoDisponible();
    bytes = new Uint8Array(buffer);
  } catch {
    throw new CatalogoNoDisponible();
  }
  const r = await interpretarCatalogo(bytes);
  if (!r.ok) throw new CatalogoNoDisponible();
  // Solo un catálogo válido se conserva; un fallo se reintenta en la siguiente verificación.
  catalogoCargado = r;
  return r;
}

export const verificadorLocal: Verificador = {
  async verificar(jws: string): Promise<ResultadoVerificacion> {
    const { catalogo, huella } = await cargarCatalogo();
    return verificarLocal(jws, catalogo, new Date(), { huella, sinConexion: !navigator.onLine });
  },
};
