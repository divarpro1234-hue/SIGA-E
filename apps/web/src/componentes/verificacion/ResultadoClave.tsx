// Componente modular: Clave de confianza (kid y catálogo local)
import type { Firma } from '../../dominio/tipos';
import { Icono } from '../Icono';

interface Props {
  firma: Firma;
  kid: string | null;
  catalogo?: { etiqueta: string; huella: string } | null;
}

export function ResultadoClave({ firma, kid, catalogo }: Props) {
  const esRevocada = firma === 'CLAVE_REVOCADA';
  const esDesconocida = firma === 'CLAVE_DESCONOCIDA';
  const esConfiable = firma === 'VALIDA';

  const icono = esConfiable ? 'check' : esRevocada ? 'cross' : 'help';
  const tono = esConfiable ? 'ok' : esRevocada ? 'mal' : 'alerta';
  const etiqueta = esConfiable
    ? 'Clave pública de confianza'
    : esRevocada
      ? 'Clave pública revocada'
      : esDesconocida
        ? 'Clave no reconocida'
        : 'Clave no comprobable';

  return (
    <div className={`dim dim-${tono}`} role="group" aria-label="Clave de confianza">
      <p className="dim-num">Dimensión 2 · Clave Confiable (kid)</p>
      <p className="dim-estado">
        <Icono nombre={icono} clase="ico ico-enorme" />
        <span>{etiqueta}</span>
      </p>
      <p>
        {esConfiable && 'La clave pública firmante está incorporada en el catálogo de confianza del dispositivo.'}
        {esRevocada && 'La clave figura formalmente revocada en el catálogo local; el mensaje no debe utilizarse.'}
        {esDesconocida && 'El identificador de clave (kid) no coincide con ninguna entidad autorizada conocida.'}
        {!esConfiable && !esRevocada && !esDesconocida && 'No fue posible validar la relación de confianza de la clave.'}
      </p>
      <div className="dim-detalles-clave">
        <span className="dim-clave-item">
          <strong>kid:</strong> <code>{kid ?? '(no identificado)'}</code>
        </span>
        {catalogo && (
          <span className="dim-clave-item">
            <strong>Catálogo:</strong> {catalogo.etiqueta}
          </span>
        )}
      </div>
    </div>
  );
}
