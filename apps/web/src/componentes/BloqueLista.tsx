import type { MouseEventHandler } from 'react';
import { SUFIJO_NO_INICIAL, TEXTO_FIRMA, TEXTO_TIPO, TEXTO_VIGENCIA } from '../dominio/textos';
import { LIMITES_TEXTO, type ItemAlerta } from '../dominio/tipos';
import { Icono } from './Icono';
import { Severidad } from './Severidad';
import { TextoAjeno } from './TextoAjeno';

interface Props {
  item: ItemAlerta;
  href: string;
  alPulsar?: MouseEventHandler<HTMLAnchorElement>;
}

/** Un bloque por alerta. El titular solo aparece con firma VALIDA; en otro caso, el identificador. */
export function BloqueLista({ item, href, alPulsar }: Props) {
  const e = TEXTO_FIRMA[item.firma];
  const titular = item.firma === 'VALIDA' ? item.titular : null;

  return (
    <a className={`bloque bloque-${e.tono}`} href={href} onClick={alPulsar} role="article">
      <div className="bloque-cabecera">
        <div className="bloque-cabecera-izq">
          <span className="bloque-estado">
            <Icono nombre={e.icono} clase="ico" />
            <span>{e.etiqueta}</span>
          </span>
          {titular !== null && item.tipo !== 'Alert' ? (
            <span className="bloque-tipo-badge" title={`${TEXTO_TIPO[item.tipo].etiqueta}${SUFIJO_NO_INICIAL}`}>
              {item.tipo === 'Update' ? 'Actualización' : 'Cancelación'}
            </span>
          ) : null}
        </div>
        <span className="id">{item.identifier}</span>
      </div>

      {titular !== null ? (
        <TextoAjeno valor={titular} max={LIMITES_TEXTO.titular} className="bloque-titular" />
      ) : (
        <span className="bloque-oculto">Contenido no mostrado por estado de firma</span>
      )}

      <div className="bloque-pie">
        <div className="bloque-meta">
          {titular !== null && item.severidad ? <Severidad valor={item.severidad} /> : null}
          {titular !== null ? (
            <span className={`badge-vigencia badge-vigencia-${item.vigencia.toLowerCase()}`}>
              {TEXTO_VIGENCIA[item.vigencia].etiqueta}
            </span>
          ) : null}
        </div>
        <span className="bloque-cta" aria-hidden="true">
          Inspeccionar evidencia →
        </span>
      </div>
    </a>
  );
}
