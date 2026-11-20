import type { NombreIcono } from '../dominio/tipos';
import { Icono } from './Icono';

type Tipo = 'vacio' | 'cargando' | 'error';

const ICONO: Record<Tipo, NombreIcono> = { vacio: 'dash', cargando: 'clock', error: 'aviso' };

/** Vacío, cargando y error. Cargando no anima: describe lo que ocurre con texto. */
export function EstadoPagina({ tipo, texto }: { tipo: Tipo; texto: string }) {
  return (
    <div
      className={`estado estado-${tipo}`}
      role={tipo === 'error' ? 'alert' : 'status'}
      aria-busy={tipo === 'cargando' ? true : undefined}
    >
      <Icono nombre={ICONO[tipo]} clase="ico ico-grande" />
      <span>{texto}</span>
    </div>
  );
}
