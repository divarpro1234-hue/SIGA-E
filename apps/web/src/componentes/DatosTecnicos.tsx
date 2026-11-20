import { TECNICO_SIMULADO } from '../dominio/textos';
import type { DatosPanel } from '../dominio/tipos';

export function DatosTecnicos({ panel, simulado }: { panel: DatosPanel; simulado: boolean }) {
  // En una demostración simulada no hay kid ni huella que mostrar, aunque el panel trajera alguno.
  if (simulado) {
    return (
      <details className="tecnico">
        <summary>Datos técnicos de la verificación</summary>
        <p className="nota">{TECNICO_SIMULADO}</p>
      </details>
    );
  }
  return (
    <details className="tecnico">
      <summary>Datos técnicos de la verificación</summary>
      <dl>
        <dt>Clave (kid)</dt>
        <dd>{panel.kid ?? 'No disponible'}</dd>
        <dt>Huella SHA-256 del mensaje</dt>
        <dd>{panel.hashJws ?? 'No disponible'}</dd>
        {panel.catalogo ? (
          <>
            <dt>Catálogo de claves</dt>
            <dd>{panel.catalogo.etiqueta}</dd>
            <dt>Huella SHA-256 del catálogo</dt>
            <dd>{panel.catalogo.huella}</dd>
          </>
        ) : null}
      </dl>
      {panel.catalogo ? (
        <p className="nota">
          Esta huella la calculó la propia aplicación sobre el archivo que usa: no autentica el catálogo por sí sola.
          Para confiar en él, compárala con la publicada por un canal independiente.
        </p>
      ) : null}
    </details>
  );
}
