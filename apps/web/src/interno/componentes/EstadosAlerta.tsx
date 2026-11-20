// Presentación de los estados de una alerta interna (D09-3). Solo dibujan lo que decide
// estados-alerta.mjs: icono + texto + explicación, nunca solo color. El estado de anclaje lleva
// siempre la nota de que es un dato del backend, no una verificación independiente.
import { useId } from 'react';
import { Icono } from '../../componentes/Icono';
import { FUENTE_ANCLAJE, pasosCiclo, textoAnclaje, textoCiclo, type TextoEstado } from '../estados-alerta.mjs';

function Estado({ titulo, texto, nota, clase }: { titulo: string; texto: TextoEstado; nota?: string; clase: string }) {
  const id = useId();
  return (
    <div className={`estado-alerta estado-alerta-${texto.tono} ${clase}`} role="group" aria-labelledby={id}>
      <p className="estado-alerta-titulo" id={id}>
        {titulo}
      </p>
      <p className="estado-alerta-valor">
        <Icono nombre={texto.icono} />
        <span>{texto.etiqueta}</span>
      </p>
      <p className="estado-alerta-explica">{texto.explica}</p>
      {nota ? <p className="estado-alerta-nota">{nota}</p> : null}
    </div>
  );
}

/** Estado del ciclo (`lifecycleState`). Un valor desconocido se muestra como tal, sin interpretarlo. */
export function EstadoCiclo({ estado }: { estado: unknown }) {
  return <Estado titulo="Estado de la alerta" texto={textoCiclo(estado)} clase="estado-alerta-ciclo" />;
}

/** Estado del anclaje (`anchorStatus`), siempre con su fuente: el backend. */
export function EstadoAnclaje({ estado }: { estado: unknown }) {
  return <Estado titulo="Registro en Stellar Testnet" texto={textoAnclaje(estado)} nota={FUENTE_ANCLAJE} clase="estado-alerta-anclaje" />;
}

const POSICION = { anterior: 'paso anterior', actual: 'paso actual', siguiente: 'paso pendiente' } as const;

/** Línea del ciclo con el paso actual marcado por aria-current y por texto, no solo por estilo. */
export function LineaCiclo({ estado }: { estado: unknown }) {
  const pasos = pasosCiclo(estado);
  if (!pasos) return null;
  return (
    <ol className="linea-ciclo" aria-label="Ciclo de la alerta">
      {pasos.map((p) => (
        <li
          key={p.estado}
          className={`linea-paso linea-paso-${p.posicion}${p.estado === 'REJECTED' ? ' linea-paso-rechazo' : ''}`}
          aria-current={p.posicion === 'actual' ? 'step' : undefined}
        >
          <span className="linea-marca" aria-hidden="true" />
          <span>
            {p.paso}
            <span className="sr-only">{` (${POSICION[p.posicion]})`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
