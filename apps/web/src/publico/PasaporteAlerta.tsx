import { useEffect, useState } from 'react';
import { CatalogoNoDisponible, VerificadorNoDisponible } from '../dominio/errores';
import {
  CATALOGO_NO_DISPONIBLE,
  VERIFICACION_FALLIDA,
  VERIFICADOR_NO_DISPONIBLE,
  TEXTO_FIRMA,
} from '../dominio/textos';
import type { ResultadoVerificacion } from '../dominio/tipos';
import { fechaDispositivoConUtc } from '../lib/fechas';
import { Titulo } from '../componentes/Titulo';
import { PanelVerificacion } from '../componentes/PanelVerificacion';
import { EstadoCarga, EstadoError } from '../interno/signature/Componentes';
import { verificadorLocal } from '../adaptadores/verificador-local';
import { esUuidPublico, obtenerAlertaPublica, type DetalleAlertaPublica, type FalloPublico } from './cliente-publico';
import { avisoBlockchainNoComprobable, mensajeErrorPasaporte, mensajeEstadoFirma } from './pasaporte-presentacion.mjs';
import './publico.css';

type EstadoPasaporte =
  | { fase: 'cargando' }
  | { fase: 'error'; mensaje: string }
  | { fase: 'verificando'; detalle: DetalleAlertaPublica }
  | { fase: 'no-comprobable'; detalle: DetalleAlertaPublica; mensaje: string }
  | { fase: 'verificado'; detalle: DetalleAlertaPublica; resultado: ResultadoVerificacion };

function mensajeErrorVerificador(error: unknown): string {
  if (error instanceof CatalogoNoDisponible) return CATALOGO_NO_DISPONIBLE;
  if (error instanceof VerificadorNoDisponible) return VERIFICADOR_NO_DISPONIBLE;
  return VERIFICACION_FALLIDA;
}

function mensajeErrorApi(motivo: FalloPublico): string {
  return mensajeErrorPasaporte(motivo);
}

function Metadatos({ detalle }: { detalle: DetalleAlertaPublica }) {
  const evidencia = detalle.anchorEvidenceMeta;
  return (
    <>
      <section className="live-seccion pasaporte-seccion" aria-labelledby="pasaporte-alerta">
        <div className="live-cabecera">
          <div>
            <p className="live-etiqueta">PASAPORTE DIGITAL · API SIGA-E</p>
            <h2 id="pasaporte-alerta">{detalle.alert.identifier}</h2>
          </div>
          <span className="simulacro">SIMULACRO</span>
        </div>
        <dl className="pasaporte-datos">
          <dt>Estado</dt><dd>{detalle.alert.lifecycleState}</dd>
          <dt>Estado del anclaje informado por la API</dt><dd>{detalle.alert.anchorStatus}</dd>
          <dt>Versión</dt><dd>No disponible en la API pública</dd>
          <dt>Emisor</dt><dd>{detalle.alert.sender}</dd>
          <dt>Enviado</dt><dd><time dateTime={detalle.alert.sent}>{fechaDispositivoConUtc(detalle.alert.sent)}</time></dd>
          <dt>Tipo / alcance</dt><dd>{detalle.alert.status} / {detalle.alert.scope}</dd>
        </dl>
      </section>

      <section className="live-seccion pasaporte-seccion" aria-labelledby="pasaporte-firma">
        <h2 id="pasaporte-firma">Metadatos de firma</h2>
        <dl className="pasaporte-datos">
          <dt>Algoritmo</dt><dd>{detalle.signatureMeta.alg}</dd>
          <dt>Identificador de clave</dt><dd>{detalle.signatureMeta.kid}</dd>
        </dl>
      </section>

      <section className="live-seccion pasaporte-seccion" aria-labelledby="pasaporte-evidencia">
        <h2 id="pasaporte-evidencia">Evidencia de anclaje proporcionada por el backend</h2>
        <p className="pasaporte-aviso" role="note">
          {avisoBlockchainNoComprobable()}
        </p>
        <dl className="pasaporte-datos pasaporte-hashes">
          <dt>Red declarada</dt><dd>{evidencia.network}</dd>
          <dt>Contrato</dt><dd>{evidencia.contractId}</dd>
          <dt>Estado informado</dt><dd>{evidencia.anchorStatus}</dd>
          <dt>messageKey (hex)</dt><dd>{evidencia.messageKeyHex}</dd>
          <dt>jwsHash (hex)</dt><dd>{evidencia.jwsHashHex}</dd>
          <dt>Transacción</dt><dd>{evidencia.txHash ?? 'No proporcionada'}</dd>
          <dt>Comprobado</dt><dd>{evidencia.checkedAt ?? 'No proporcionado'}</dd>
          <dt>Fuente</dt><dd>{evidencia.verificationSource}</dd>
        </dl>
        <p className="live-nota">{evidencia.note}</p>
      </section>
    </>
  );
}

export function PasaporteAlerta({ id }: { id: string }) {
  const [estado, setEstado] = useState<EstadoPasaporte>({ fase: 'cargando' });

  useEffect(() => {
    let vigente = true;
    if (!esUuidPublico(id)) {
      setEstado({ fase: 'error', mensaje: mensajeErrorPasaporte('uuid-invalido') });
      return () => { vigente = false; };
    }

    setEstado({ fase: 'cargando' });
    const cargar = async () => {
      const respuesta = await obtenerAlertaPublica(id);
      if (!vigente) return;
      if (!respuesta.ok) {
        setEstado({ fase: 'error', mensaje: mensajeErrorApi(respuesta.motivo) });
        return;
      }

      const detalle = respuesta.detalle;
      setEstado({ fase: 'verificando', detalle });
      try {
        const resultado = await verificadorLocal.verificar(detalle.jwsCompact);
        if (vigente) setEstado({ fase: 'verificado', detalle, resultado });
      } catch (error) {
        if (vigente) setEstado({ fase: 'no-comprobable', detalle, mensaje: mensajeErrorVerificador(error) });
      }
    };
    void cargar();
    return () => { vigente = false; };
  }, [id]);

  return (
    <>
      <Titulo>Pasaporte digital de alerta</Titulo>
      <p className="simulacro pasaporte-simulacro" role="note">SIMULACRO · SIGA-E no publica alertas reales.</p>
      {estado.fase === 'cargando' ? <EstadoCarga texto="Consultando la alerta pública…" /> : null}
      {estado.fase === 'error' ? <EstadoError mensaje={estado.mensaje} /> : null}
      {estado.fase === 'verificando' || estado.fase === 'no-comprobable' || estado.fase === 'verificado' ? (
        <>
          <Metadatos detalle={estado.detalle} />
          <section className="live-seccion pasaporte-seccion" aria-labelledby="pasaporte-verificacion">
            <h2 id="pasaporte-verificacion">Verificación de firma en este dispositivo</h2>
            {estado.fase === 'verificando' ? (
              <p role="status" aria-live="polite">{mensajeEstadoFirma('verificando')}</p>
            ) : null}
            {estado.fase === 'no-comprobable' ? (
              <p className="pasaporte-aviso" role="alert">
                {mensajeEstadoFirma('no-comprobable')} {estado.mensaje}
              </p>
            ) : null}
            {estado.fase === 'verificado' ? (
              <>
                <p role="status" aria-live="polite">{mensajeEstadoFirma('verificado', estado.resultado.firma)}</p>
                <PanelVerificacion resultado={estado.resultado} />
              </>
            ) : null}
            {estado.fase === 'verificado' && estado.resultado.firma !== 'VALIDA' ? (
              <p className="pasaporte-aviso" role="note">{TEXTO_FIRMA[estado.resultado.firma].explica}</p>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
