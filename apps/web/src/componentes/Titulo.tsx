import type { ReactNode } from 'react';

/** h1 de cada pantalla. tabIndex -1: el enrutador le mueve el foco en cada cambio de ruta. */
export function Titulo({ children }: { children: ReactNode }) {
  return <h1 tabIndex={-1}>{children}</h1>;
}
