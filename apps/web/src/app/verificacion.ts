// Estado de la verificación SOLO en memoria (variable de módulo). Nunca en la URL, en query, en
// localStorage ni en sessionStorage, ni en history.state. Se pierde al recargar, a propósito.
import { useSyncExternalStore } from 'react';
import { verificadorLocal } from '../adaptadores/verificador-local';
import { CatalogoNoDisponible, VerificadorNoDisponible } from '../dominio/errores';
import { CATALOGO_NO_DISPONIBLE, VERIFICACION_FALLIDA, VERIFICADOR_NO_DISPONIBLE } from '../dominio/textos';
import type { ResultadoVerificacion, Verificador } from '../dominio/tipos';

export type SalidaVerificacion = { ok: true } | { ok: false; mensaje: string };

let resultadoActual: ResultadoVerificacion | null = null;
const oyentes = new Set<() => void>();

function fijar(r: ResultadoVerificacion | null): void {
  resultadoActual = r;
  oyentes.forEach((o) => o());
}

function suscribir(aviso: () => void): () => void {
  oyentes.add(aviso);
  return () => {
    oyentes.delete(aviso);
  };
}

export function useResultado(): ResultadoVerificacion | null {
  return useSyncExternalStore(suscribir, () => resultadoActual, () => null);
}

export function limpiarResultado(): void {
  fijar(null);
}

/** Ejecuta una verificación y, si termina bien, guarda el resultado en memoria. */
export async function ejecutarVerificacion(
  jws: string,
  verificador: Verificador = verificadorLocal,
): Promise<SalidaVerificacion> {
  try {
    fijar(await verificador.verificar(jws));
    return { ok: true };
  } catch (error) {
    fijar(null);
    // Nunca se muestra error.message: podría contener texto del mensaje.
    return {
      ok: false,
      mensaje:
        error instanceof CatalogoNoDisponible
          ? CATALOGO_NO_DISPONIBLE
          : error instanceof VerificadorNoDisponible
            ? VERIFICADOR_NO_DISPONIBLE
            : VERIFICACION_FALLIDA,
    };
  }
}
