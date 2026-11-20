// Aviso del portal interno: icono, título y explicación. El tono nunca va solo: cada uno lleva su
// icono y su texto. Error y bloqueo se anuncian (role=alert); la información, con role=status.
import { forwardRef, useId, type ReactNode } from 'react';
import { Icono } from '../../componentes/Icono';
import type { NombreIcono } from '../../dominio/tipos';
import type { AvisoAcceso } from '../textos';

export type TonoAviso = 'error' | 'bloqueo' | 'info' | 'exito';

const ICONO: Record<TonoAviso, NombreIcono> = { error: 'cross', bloqueo: 'clock-off', info: 'aviso', exito: 'check' };

interface Props {
  aviso: AvisoAcceso;
  tono: TonoAviso;
  children?: ReactNode;
}

export const AvisoInterno = forwardRef<HTMLDivElement, Props>(function AvisoInterno({ aviso, tono, children }, ref) {
  const id = useId();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`aviso-interno aviso-interno-${tono}`}
      role={tono === 'error' || tono === 'bloqueo' ? 'alert' : 'status'}
      aria-labelledby={id}
    >
      <Icono nombre={ICONO[tono]} clase="ico ico-grande" />
      <div className="aviso-interno-texto">
        <p className="aviso-interno-titulo" id={id}>
          {aviso.titulo}
        </p>
        <p>{aviso.cuerpo}</p>
        {children}
      </div>
    </div>
  );
});
