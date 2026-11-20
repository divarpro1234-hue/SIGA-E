// Medidor ordinal en tinta neutra, siempre con etiqueta de texto al lado (P13).
import { TEXTO_SEVERIDAD } from '../dominio/textos';
import type { Severidad as ClaveSeveridad } from '../dominio/tipos';

export function Severidad({ valor }: { valor: ClaveSeveridad }) {
  const { etiqueta, nivel } = TEXTO_SEVERIDAD[valor];
  return (
    <span className="sev">
      <span className="sev-medidor" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= nivel ? 'sev-paso sev-paso-on' : 'sev-paso'} />
        ))}
      </span>
      <span>{etiqueta}</span>
    </span>
  );
}
