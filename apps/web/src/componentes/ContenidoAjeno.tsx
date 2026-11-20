// Contenido del mensaje: región propia, rotulada, solo texto y fuera del panel de verificación.
// SIMULACRO y el tipo de mensaje los pinta la aplicación, no el mensaje.
import { useId } from 'react';
import {
  ROTULO_REFERENCIAS,
  ROTULO_TIPO,
  TEXTO_TIPO,
  TITULO_CONTENIDO,
  TITULO_REFERENCIAS,
  referenciasOcultas,
} from '../dominio/textos';
import { LIMITES_TEXTO, MAX_REFERENCIAS_VISIBLES, type ContenidoAlerta } from '../dominio/tipos';
import { fechaDispositivoConUtc } from '../lib/fechas';
import { Severidad } from './Severidad';
import { TextoAjeno, contarControles } from './TextoAjeno';

interface Props {
  contenido: ContenidoAlerta | null;
  /** Texto cuando no hay contenido que mostrar. */
  sinContenido: string;
  /** El contenido pertenece a un fixture de demostración y no a un JWS validado. */
  simulado?: boolean;
}

interface PropsReferencias {
  visibles: ContenidoAlerta['referencias'];
  /** Referencias declaradas que no se muestran. */
  resto: number;
}

/** Referencias que dice el mensaje. No se enlazan ni se buscan: no hay historial con el que contrastarlas. */
function Referencias({ visibles, resto }: PropsReferencias) {
  const id = useId();
  return (
    <section className="c-referencias" aria-labelledby={id}>
      <h3 id={id}>{TITULO_REFERENCIAS}</h3>
      <p className="contenido-rotulo">{ROTULO_REFERENCIAS}</p>
      <ul>
        {visibles.map((r, i) => (
          <li key={i}>
            <dl className="c-datos">
              <dt>Identificador</dt>
              <dd className="id">
                <TextoAjeno valor={r.identifier} max={LIMITES_TEXTO.referencia} />
              </dd>
              <dt>Emisor</dt>
              <dd>
                <TextoAjeno valor={r.sender} max={LIMITES_TEXTO.referencia} />
              </dd>
              <dt>Enviado</dt>
              <dd>
                <time dateTime={r.sent}>{fechaDispositivoConUtc(r.sent)}</time>
              </dd>
            </dl>
          </li>
        ))}
      </ul>
      {resto > 0 ? <p className="contenido-rotulo">{referenciasOcultas(resto)}</p> : null}
    </section>
  );
}

export function ContenidoAjeno({ contenido: c, sinContenido, simulado = false }: Props) {
  const id = useId();
  const tipo = c ? TEXTO_TIPO[c.tipo] : null;
  const encabezado = (
    <>
      <h2 id={id}>
        {simulado ? 'Contenido del escenario de demostración' : tipo ? tipo.tituloContenido : TITULO_CONTENIDO}
      </h2>
      <p className="contenido-rotulo">
        {simulado
          ? 'Texto fijo de un fixture local; no es una alerta publicada ni un contenido cuya firma se haya verificado.'
          : 'Lo escribió un tercero, no la aplicación. Solo texto: no forma parte de la verificación.'}
      </p>
      <p className="simulacro">SIMULACRO</p>
    </>
  );

  if (!c || !tipo) {
    return (
      <section className="contenido" aria-labelledby={id}>
        {encabezado}
        <p className="contenido-rotulo">{sinContenido}</p>
      </section>
    );
  }

  // Una sola selección: la misma lista se dibuja y se cuenta en la leyenda de controles.
  const visibles = c.referencias.slice(0, MAX_REFERENCIAS_VISIBLES);
  const controles =
    contarControles(c.titular, LIMITES_TEXTO.titular) +
    contarControles(c.descripcion, LIMITES_TEXTO.descripcion) +
    contarControles(c.area, LIMITES_TEXTO.area) +
    contarControles(c.evento, LIMITES_TEXTO.evento) +
    visibles.reduce(
      (n, r) => n + contarControles(r.identifier, LIMITES_TEXTO.referencia) + contarControles(r.sender, LIMITES_TEXTO.referencia),
      0,
    );

  return (
    <section className="contenido" aria-labelledby={id}>
      {encabezado}
      <p className="c-tipo">
        <span>{ROTULO_TIPO}</span>
        <strong>{tipo.etiqueta}</strong>
      </p>
      <p className="c-resumen">
        <TextoAjeno valor={c.titular} max={LIMITES_TEXTO.titular} />
      </p>
      {visibles.length > 0 ? <Referencias visibles={visibles} resto={c.referencias.length - visibles.length} /> : null}
      <details className="c-completo">
        <summary>Ver el mensaje completo</summary>
        <div className="c-cuerpo">
          <p>
            <TextoAjeno valor={c.descripcion} max={LIMITES_TEXTO.descripcion} />
          </p>
          <dl className="c-datos">
            <dt>Área</dt>
            <dd>
              <TextoAjeno valor={c.area} max={LIMITES_TEXTO.area} />
            </dd>
            <dt>Evento</dt>
            <dd>
              <TextoAjeno valor={c.evento} max={LIMITES_TEXTO.evento} />
            </dd>
            <dt>Gravedad</dt>
            <dd>
              <Severidad valor={c.severidad} />
            </dd>
            <dt>Enviado</dt>
            <dd>
              <time dateTime={c.enviado}>{fechaDispositivoConUtc(c.enviado)}</time>
            </dd>
            <dt>Vence</dt>
            <dd>
              <time dateTime={c.vence}>{fechaDispositivoConUtc(c.vence)}</time>
            </dd>
          </dl>
        </div>
      </details>
      {controles > 0 ? (
        <p className="c-leyenda">
          {`Se muestran ${controles} carácter(es) de control o de dirección como marcas con su código. Estaban en el mensaje y no se interpretan.`}
        </p>
      ) : null}
    </section>
  );
}
