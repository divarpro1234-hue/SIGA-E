// Panel de verificación: fuera y antes del contenido, nunca dentro de una zona compartida con él.
// Ningún texto del mensaje entra aquí: el tipo de mensaje es un valor cerrado y su texto es de la aplicación.
// Un resultado SIMULADO (D07A) abre con su aviso, antes de las dimensiones, y nunca muestra kid ni huella.
// Jerarquía (D07): las tres dimensiones; luego los avisos críticos, que cambian cómo se lee el resultado;
// luego los límites permanentes, agrupados y compactos; al final los datos técnicos, plegados.
import { useId } from 'react';
import { AVISO_CATALOGO, AVISO_SIMULADO, AVISO_VENCIDA, LIMITE, SIN_CAMBIOS_CONOCIDOS, TEXTO_TIPO, TITULO_LIMITES } from '../dominio/textos';
import type { ResultadoVerificacion } from '../dominio/tipos';
import { esResultadoSimulado } from '../lib/origen-resultado.mjs';
import { AvisoConexion } from './AvisoConexion';
import { BloqueDimension } from './BloqueDimension';
import { DatosTecnicos } from './DatosTecnicos';
import { Icono } from './Icono';

export function PanelVerificacion({ resultado }: { resultado: ResultadoVerificacion }) {
  const id = useId();
  const idLimites = useId();
  const idTipo = useId();
  const idSimulado = useId();
  const simulado = esResultadoSimulado(resultado);
  // Sin firma VALIDA no hay tipo de mensaje del que fiarse.
  const contenido = !simulado && resultado.firma === 'VALIDA' ? resultado.contenido : null;
  const tipo = contenido ? TEXTO_TIPO[contenido.tipo] : null;
  const vencida = !simulado && resultado.firma === 'VALIDA' && resultado.vigencia === 'VENCIDA';
  // El aviso de Update/Cancel y el de sin conexión ya dicen que no se conocen cambios: no se repite.
  const historialYaDicho = !simulado && (Boolean(tipo?.aviso) || resultado.sinConexion);

  return (
    <section className="panel" aria-labelledby={id}>
      <h2 id={id}>Verificación en este dispositivo</h2>
      {simulado ? (
        <div className="aviso aviso-simulado" role="note" aria-labelledby={idSimulado}>
          <Icono nombre="aviso" clase="ico ico-grande" />
          <div className="aviso-simulado-texto">
            <p className="aviso-simulado-titulo" id={idSimulado}>
              {AVISO_SIMULADO.titulo}
            </p>
            <p>{AVISO_SIMULADO.cuerpo}</p>
          </div>
        </div>
      ) : null}
      <div className="dims" role="status" aria-live="polite">
        <BloqueDimension dimension={{ clave: 'firma', estado: resultado.firma }} indice={1} simulado={simulado} />
        <BloqueDimension dimension={{ clave: 'vigencia', estado: resultado.vigencia }} indice={2} simulado={simulado} />
        <BloqueDimension dimension={{ clave: 'cadena', estado: resultado.cadena }} indice={3} simulado={simulado} />
      </div>
      {!simulado && resultado.sinConexion ? <AvisoConexion ultimaSync={resultado.ultimaSync} /> : null}
      {tipo?.aviso ? (
        <div className="aviso aviso-tipo" role="note" aria-labelledby={idTipo}>
          <Icono nombre="aviso" clase="ico ico-grande" />
          <div className="aviso-tipo-texto">
            <p className="aviso-tipo-titulo" id={idTipo}>
              {tipo.aviso.titulo}
            </p>
            <p>{tipo.aviso.cuerpo}</p>
            {/* Un solo bloque crítico: el vencimiento de un Update/Cancel va dentro de su aviso. */}
            {vencida ? <p className="aviso-tipo-vencida">{tipo.vencida}</p> : null}
          </div>
        </div>
      ) : null}
      {/* Depende solo de la firma y la vigencia; el tipo solo afina el texto. */}
      {vencida && !tipo?.aviso ? (
        <p className="aviso aviso-vencida">
          <Icono nombre="clock-off" />
          <span>{tipo ? tipo.vencida : AVISO_VENCIDA}</span>
        </p>
      ) : null}
      <section className="limites" aria-labelledby={idLimites}>
        <h3 id={idLimites}>{TITULO_LIMITES}</h3>
        <ul>
          {simulado ? (
            <li>
              <Icono nombre="aviso" />
              <span>El caso no verificó la firma ni consultó el catálogo de claves o Stellar Testnet.</span>
            </li>
          ) : historialYaDicho ? null : (
            <li>
              <Icono nombre="dash" />
              <span>{SIN_CAMBIOS_CONOCIDOS}</span>
            </li>
          )}
          {!simulado && resultado.panel.catalogo ? (
            <li className="limite-catalogo">
              <Icono nombre="aviso" />
              <span>{AVISO_CATALOGO}</span>
            </li>
          ) : null}
          <li>
            <Icono nombre="aviso" />
            <span>{LIMITE}</span>
          </li>
        </ul>
      </section>
      <DatosTecnicos panel={resultado.panel} simulado={simulado} />
    </section>
  );
}
