import { TITULO_DIMENSION, textoDeDimension } from '../dominio/textos';
import type { Dimension } from '../dominio/tipos';
import { etiquetaDimension } from '../lib/origen-resultado.mjs';
import { Icono } from './Icono';

interface Props {
  dimension: Dimension;
  /** Posición fija: 1 firma, 2 vigencia, 3 registro. */
  indice: 1 | 2 | 3;
  /** El estado procede de un fixture, no de una comprobación. */
  simulado?: boolean;
}

export function BloqueDimension({ dimension, indice, simulado = false }: Props) {
  const t = textoDeDimension(dimension);
  return (
    <div className={`dim dim-${t.tono}`}>
      <p className="dim-num">{`${indice} de 3 · ${TITULO_DIMENSION[dimension.clave]}`}</p>
      <p className="dim-estado">
        <Icono nombre={t.icono} clase="ico ico-enorme" />
        <span>{etiquetaDimension(t.etiqueta, simulado)}</span>
      </p>
      <p>
        {simulado
          ? 'Dato fijo del caso de demostración; no fue calculado ni comprobado.'
          : t.explica}
      </p>
    </div>
  );
}
