import type { MouseEvent, ReactNode } from 'react';
import { navegar } from '../app/ruta';

interface Props {
  a: string;
  className?: string;
  actual?: boolean;
  /** Se ejecuta después de navegar (por ejemplo, para vaciar el resultado en memoria). */
  onNavegar?: () => void;
  children: ReactNode;
}

/** Enlace interno: navega con pushState, salvo clic modificado o con botón distinto del principal. */
export function Enlace({ a, className, actual = false, onNavegar, children }: Props) {
  const alPulsar = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navegar(a);
    onNavegar?.();
  };
  return (
    <a href={a} className={className} aria-current={actual ? 'page' : undefined} onClick={alPulsar}>
      {children}
    </a>
  );
}
