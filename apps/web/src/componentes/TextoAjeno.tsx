// Texto no confiable. La neutralización la hace segmentarTextoAjeno (spec: texto-ajeno-spec.md);
// aquí solo se dibujan segmentos como nodos de texto de React y marcas con su código.
// Nada se interpreta como HTML: sin Markdown y sin enlaces automáticos.
import { Fragment, useMemo } from 'react';
import { segmentarTextoAjeno } from '../lib/texto-ajeno.mjs';

interface Props {
  valor: string;
  /** Máximo en grafemas, según OpenAPI. */
  max: number;
  className?: string;
}

export function TextoAjeno({ valor, max, className }: Props) {
  const r = useMemo(() => segmentarTextoAjeno(valor, { maxGrafemas: max }), [valor, max]);
  return (
    <span className={className ? `texto-ajeno ${className}` : 'texto-ajeno'} dir="auto">
      {r.segmentos.map((s, i) =>
        s.tipo === 'texto' ? (
          <Fragment key={i}>{s.valor}</Fragment>
        ) : (
          <span key={i} className="ctl-marca" role="img" aria-label={`carácter de control ${s.codigo}: ${s.nombre}`}>
            {s.codigo}
          </span>
        ),
      )}
      {r.recortado ? <span className="ctl-recorte">… recortado</span> : null}
    </span>
  );
}

/** Cuenta las marcas de control que mostrará TextoAjeno para un valor. */
export function contarControles(valor: string, max: number): number {
  return segmentarTextoAjeno(valor, { maxGrafemas: max }).controles;
}
