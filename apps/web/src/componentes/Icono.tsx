// Iconos de la aplicación: un trazo por forma, constante por estado. Un texto ajeno no puede imitarlos.
import type { ReactNode } from 'react';
import type { NombreIcono } from '../dominio/tipos';

const INTERROGANTE = <path d="M10 10a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M12 16.5v.5" />;
const SENAL = 'M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01';
const ESLABON_A = 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1';
const ESLABON_B = 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';

const FORMAS: Record<NombreIcono, ReactNode> = {
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  cross: (
    <>
      <polygon points="8,3 16,3 21,8 21,16 16,21 8,21 3,16 3,8" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  help: (
    <>
      <path d="M12 2.5l9.5 9.5-9.5 9.5L2.5 12z" />
      {INTERROGANTE}
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  'clock-off': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2M4 4l16 16" />
    </>
  ),
  'clock-help': (
    <>
      <circle cx="12" cy="12" r="9" />
      {INTERROGANTE}
    </>
  ),
  link: (
    <>
      <path d={ESLABON_A} />
      <path d={ESLABON_B} />
    </>
  ),
  'link-off': (
    <>
      <path d={ESLABON_A} />
      <path d={`${ESLABON_B}M4 4l16 16`} />
    </>
  ),
  dash: (
    <>
      <circle className="ico-trazo-discontinuo" cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  online: <path d={SENAL} />,
  offline: <path d={`${SENAL}M3 3l18 18`} />,
  aviso: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </>
  ),
};

type Tamano = 'ico' | 'ico ico-grande' | 'ico ico-enorme';

export function Icono({ nombre, clase = 'ico' }: { nombre: NombreIcono; clase?: Tamano }) {
  return (
    <svg className={clase} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {FORMAS[nombre]}
    </svg>
  );
}
