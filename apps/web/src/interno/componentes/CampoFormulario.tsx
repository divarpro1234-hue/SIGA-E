// Campo con etiqueta persistente (nunca solo placeholder), ayuda opcional y error asociado por
// aria-describedby. El error lleva icono y texto: no depende del color.
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { Icono } from '../../componentes/Icono';

type Atributos = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'aria-invalid' | 'aria-describedby'>;

interface Props extends Atributos {
  etiqueta: string;
  ayuda?: string;
  error: string | null;
  /** Clase extra del input (p. ej. código TOTP en cifras grandes). */
  claseCampo?: string;
}

export const CampoFormulario = forwardRef<HTMLInputElement, Props>(function CampoFormulario(
  { etiqueta, ayuda, error, claseCampo, ...resto },
  ref,
) {
  const id = useId();
  const idAyuda = useId();
  const idError = useId();
  const describe = [ayuda ? idAyuda : null, error ? idError : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="campo-interno">
      <label htmlFor={id} className="campo-interno-etiqueta">
        {etiqueta}
      </label>
      {ayuda ? (
        <p id={idAyuda} className="campo-interno-ayuda">
          {ayuda}
        </p>
      ) : null}
      <input
        {...resto}
        ref={ref}
        id={id}
        className={claseCampo ? `entrada ${claseCampo}` : 'entrada'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describe}
      />
      {error ? (
        <p id={idError} className="campo-interno-error">
          <Icono nombre="cross" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
});
