// Componente modular: Vigencia temporal según reloj local
import type { Vigencia } from '../../dominio/tipos';
import { TEXTO_VIGENCIA } from '../../dominio/textos';
import { Icono } from '../Icono';

interface Props {
  vigencia: Vigencia;
}

export function ResultadoVigencia({ vigencia }: Props) {
  const t = TEXTO_VIGENCIA[vigencia];

  return (
    <div className={`dim dim-${t.tono}`} role="group" aria-label="Vigencia temporal">
      <p className="dim-num">Dimensión 3 · Vigencia Temporal</p>
      <p className="dim-estado">
        <Icono nombre={t.icono} clase="ico ico-enorme" />
        <span>{t.etiqueta}</span>
      </p>
      <p>{t.explica}</p>
    </div>
  );
}
