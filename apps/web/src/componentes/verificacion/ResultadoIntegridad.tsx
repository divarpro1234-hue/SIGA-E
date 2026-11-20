// Componente modular: Integridad criptográfica JWS ES256
import type { Firma } from '../../dominio/tipos';
import { TEXTO_FIRMA } from '../../dominio/textos';
import { Icono } from '../Icono';

interface Props {
  firma: Firma;
}

export function ResultadoIntegridad({ firma }: Props) {
  const t = TEXTO_FIRMA[firma];
  const esValida = firma === 'VALIDA';

  return (
    <div className={`dim dim-${t.tono}`} role="group" aria-label="Integridad criptográfica">
      <p className="dim-num">Dimensión 1 · Integridad JWS ES256</p>
      <p className="dim-estado">
        <Icono nombre={t.icono} clase="ico ico-enorme" />
        <span>{t.etiqueta}</span>
      </p>
      <p>{t.explica}</p>
      <p className="dim-nota-tecnica">
        {esValida
          ? 'Los bytes del payload coinciden exactamente con la firma criptográfica recibida.'
          : 'El digest del payload no corresponde a la firma; el mensaje pudo ser alterado o truncado.'}
      </p>
    </div>
  );
}
