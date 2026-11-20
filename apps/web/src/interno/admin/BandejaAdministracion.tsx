import { useEffect, useRef, useState } from 'react';
import { clienteAlertas } from '../adaptador-alertas.mjs';
import type { AlertaInterna } from '../bandeja/tipos';
import { BadgeCiclo, EstadoCarga, EstadoVacio } from '../signature/Componentes';

type EventoAuditoria = {
  seq: string;
  occurredAt: string;
  action: string;
};

type EvidenciaAnclaje = {
  anchorStatus: AlertaInterna['anchorStatus'];
  network: 'TESTNET' | null;
  contractId: string | null;
  txHash: string | null;
  confirmedLedger: string | null;
  digestVerification: 'MATCHED' | 'NOT_CHECKED';
  checkedAt: string | null;
  unavailableReason: 'M5_DISABLED' | null;
};

const TAMANO_PAGINA = 20;

function mensajeDeFallo(motivo: string): string {
  switch (motivo) {
    case 'sin-sesion':
      return 'La sesión ya no es válida. Vuelve a autenticarte para consultar las alertas.';
    case 'prohibido':
      return 'El servidor rechazó el acceso de administración. No se mostrarán datos.';
    case 'no-encontrada':
      return 'La alerta ya no está disponible para esta identidad.';
    case 'invalido':
      return 'La API rechazó los parámetros de consulta.';
    case 'no-disponible':
      return 'La API de alertas no está disponible en este momento.';
    case 'error-red':
      return 'No se pudo contactar con la API. Comprueba la conexión e inténtalo de nuevo.';
    default:
      return 'La API no pudo completar la consulta. No se mostrarán datos parciales.';
  }
}

function fechaAuditoria(valor: string): string {
  const fecha = new Date(valor);
  return Number.isNaN(fecha.valueOf())
    ? 'Fecha no válida recibida del servidor'
    : `${fecha.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function BandejaAdministracion() {
  const [alertas, setAlertas] = useState<AlertaInterna[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState(0);
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [cargandoLista, setCargandoLista] = useState(true);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [eventos, setEventos] = useState<EventoAuditoria[]>([]);
  const [cargandoAuditoria, setCargandoAuditoria] = useState(false);
  const [errorAuditoria, setErrorAuditoria] = useState<string | null>(null);
  const [evidencia, setEvidencia] = useState<EvidenciaAnclaje | null>(null);
  const [cargandoEvidencia, setCargandoEvidencia] = useState(false);
  const [errorEvidencia, setErrorEvidencia] = useState<string | null>(null);
  const [actualizar, setActualizar] = useState(0);
  const solicitudLista = useRef(0);
  const solicitudAuditoria = useRef(0);
  const solicitudEvidencia = useRef(0);
  const seleccionada = alertas.find((alerta) => alerta.id === seleccionadaId) ?? null;

  useEffect(() => {
    const solicitud = ++solicitudLista.current;
    setCargandoLista(true);
    setErrorLista(null);
    void (async () => {
      try {
        const resultado = await clienteAlertas.listarAlertas({ page: pagina, limit: TAMANO_PAGINA });
        if (solicitudLista.current !== solicitud) return;
        if (!resultado.ok) {
          setAlertas([]);
          setTotal(0);
          setSeleccionadaId(null);
          setErrorLista(mensajeDeFallo(resultado.motivo));
          return;
        }
        setAlertas(resultado.alertas);
        setTotal(resultado.total);
        setSeleccionadaId((actual) =>
          resultado.alertas.some((alerta) => alerta.id === actual)
            ? actual
            : resultado.alertas[0]?.id ?? null,
        );
      } catch {
        if (solicitudLista.current === solicitud) {
          setAlertas([]);
          setTotal(0);
          setSeleccionadaId(null);
          setErrorLista('No se pudo completar la consulta de alertas. No se mostrarán datos parciales.');
        }
      } finally {
        if (solicitudLista.current === solicitud) setCargandoLista(false);
      }
    })();

    return () => {
      if (solicitudLista.current === solicitud) solicitudLista.current += 1;
    };
  }, [actualizar, pagina]);

  useEffect(() => {
    const solicitud = ++solicitudAuditoria.current;
    setEventos([]);
    setErrorAuditoria(null);
    if (!seleccionadaId) {
      setCargandoAuditoria(false);
      return () => {
        if (solicitudAuditoria.current === solicitud) solicitudAuditoria.current += 1;
      };
    }

    setCargandoAuditoria(true);
    void (async () => {
      try {
        const resultado = await clienteAlertas.consultarAuditoria(seleccionadaId);
        if (solicitudAuditoria.current !== solicitud) return;
        if (!resultado.ok) {
          setErrorAuditoria(mensajeDeFallo(resultado.motivo));
          return;
        }
        setEventos(resultado.eventos);
      } catch {
        if (solicitudAuditoria.current === solicitud) {
          setErrorAuditoria('No se pudo consultar la auditoría. Inténtalo de nuevo.');
        }
      } finally {
        if (solicitudAuditoria.current === solicitud) setCargandoAuditoria(false);
      }
    })();

    return () => {
      if (solicitudAuditoria.current === solicitud) solicitudAuditoria.current += 1;
    };
  }, [actualizar, seleccionadaId]);

  useEffect(() => {
    const solicitud = ++solicitudEvidencia.current;
    setEvidencia(null);
    setErrorEvidencia(null);
    if (!seleccionadaId) {
      setCargandoEvidencia(false);
      return () => {
        if (solicitudEvidencia.current === solicitud) solicitudEvidencia.current += 1;
      };
    }

    setCargandoEvidencia(true);
    void (async () => {
      try {
        const resultado = await clienteAlertas.consultarAnclaje(seleccionadaId);
        if (solicitudEvidencia.current !== solicitud) return;
        if (!resultado.ok) {
          setErrorEvidencia(mensajeDeFallo(resultado.motivo));
          return;
        }
        setEvidencia(resultado.evidencia);
      } catch {
        if (solicitudEvidencia.current === solicitud) {
          setErrorEvidencia('No se pudo consultar la evidencia de anclaje. Inténtalo de nuevo.');
        }
      } finally {
        if (solicitudEvidencia.current === solicitud) setCargandoEvidencia(false);
      }
    })();

    return () => {
      if (solicitudEvidencia.current === solicitud) solicitudEvidencia.current += 1;
    };
  }, [actualizar, seleccionadaId]);

  const ultimaPagina = Math.max(1, Math.ceil(total / TAMANO_PAGINA));

  return (
    <section className="sig-review-workspace" aria-label="Alertas y auditoría de administración">
      <div className="sig-review-toolbar">
        <div>
          <h2>Alertas y auditoría</h2>
          <p>Resúmenes y eventos confirmados por la API. El rol ADMIN no puede crear, editar ni decidir alertas.</p>
        </div>
        <button
          type="button"
          className="sig-btn sig-btn-secondary"
          disabled={cargandoLista}
          onClick={() => setActualizar((actual) => actual + 1)}
        >
          {cargandoLista ? 'Actualizando…' : 'Actualizar datos'}
        </button>
      </div>

      <div className="sig-review-layout">
        <section className="sig-review-queue" aria-label="Alertas registradas">
          <div className="sig-review-queue-heading">
            <h3>Alertas SIMULACRO</h3>
            <span>{total} {total === 1 ? 'alerta' : 'alertas'}</span>
          </div>
          {cargandoLista ? (
            <EstadoCarga texto="Consultando alertas desde la API…" />
          ) : errorLista ? (
            <div role="alert" className="sig-review-error">
              <p>{errorLista}</p>
              <button type="button" className="sig-btn sig-btn-secondary" onClick={() => setActualizar((actual) => actual + 1)}>
                Volver a consultar
              </button>
            </div>
          ) : alertas.length === 0 ? (
            <EstadoVacio mensaje="No hay alertas SIMULACRO para esta página." />
          ) : (
            <>
              <ul className="sig-review-list">
                {alertas.map((alerta) => (
                  <li key={alerta.id}>
                    <button
                      type="button"
                      className={alerta.id === seleccionadaId ? 'sig-review-item sig-review-item-selected' : 'sig-review-item'}
                      aria-current={alerta.id === seleccionadaId ? 'true' : undefined}
                      onClick={() => setSeleccionadaId(alerta.id)}
                    >
                      <span className="sig-review-item-id">{alerta.identifier}</span>
                      <span className="sig-review-item-meta">
                        <BadgeCiclo estado={alerta.lifecycleState} />
                        <span>{alerta.notice} · {alerta.anchorStatus}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <nav className="sig-review-pagination" aria-label="Paginación de alertas">
                <button
                  type="button"
                  className="sig-btn sig-btn-secondary"
                  disabled={pagina <= 1 || cargandoLista}
                  onClick={() => setPagina((actual) => Math.max(1, actual - 1))}
                >
                  Anterior
                </button>
                <span>Página {pagina} de {ultimaPagina}</span>
                <button
                  type="button"
                  className="sig-btn sig-btn-secondary"
                  disabled={pagina >= ultimaPagina || cargandoLista}
                  onClick={() => setPagina((actual) => Math.min(ultimaPagina, actual + 1))}
                >
                  Siguiente
                </button>
              </nav>
            </>
          )}
        </section>

        <section className="sig-review-detail" aria-label="Detalle resumido y auditoría">
          {!seleccionada ? (
            <EstadoVacio mensaje="Selecciona una alerta para consultar sus estados y eventos de auditoría." />
          ) : (
            <>
              <header className="sig-review-detail-header">
                <div>
                  <p className="sig-detail-label">SIMULACRO · RESUMEN ADMINISTRATIVO</p>
                  <h3>{seleccionada.identifier}</h3>
                </div>
                <BadgeCiclo estado={seleccionada.lifecycleState} />
              </header>
              <dl className="sig-review-metadata">
                <div><dt>Tipo</dt><dd>{seleccionada.notice}</dd></div>
                <div><dt>Estado del ciclo</dt><dd>{seleccionada.lifecycleState}</dd></div>
                <div><dt>Estado de anclaje</dt><dd>{seleccionada.anchorStatus}</dd></div>
              </dl>

              <section className="sig-trace-section" aria-label="Evidencia blockchain — M5">
                <h4>Evidencia blockchain — M5</h4>
                {cargandoEvidencia ? (
                  <EstadoCarga texto="Consultando metadatos de anclaje desde la API…" />
                ) : errorEvidencia ? (
                  <div role="alert" className="sig-review-error">
                    <p>{errorEvidencia}</p>
                  </div>
                ) : evidencia ? (
                  <>
                    <dl className="sig-review-metadata">
                      <div><dt>Estado del anclaje</dt><dd>{evidencia.anchorStatus}</dd></div>
                      <div><dt>Red blockchain</dt><dd>{evidencia.network ?? 'No disponible'}</dd></div>
                      <div><dt>Contrato</dt><dd>{evidencia.contractId ?? 'No disponible'}</dd></div>
                      <div><dt>Identificador de transacción</dt><dd>{evidencia.txHash ?? 'No disponible'}</dd></div>
                      <div><dt>Confirmación</dt><dd>{evidencia.confirmedLedger ? `Ledger ${evidencia.confirmedLedger}` : 'No acreditada'}</dd></div>
                      <div><dt>Verificación del digest</dt><dd>{evidencia.digestVerification === 'MATCHED' ? 'Coincidencia comprobada por el backend' : 'No comprobado'}</dd></div>
                    </dl>
                    {evidencia.unavailableReason === 'M5_DISABLED' && (
                      <p role="status" className="sig-action-note">
                        M5 está deshabilitado operativamente: no se ejecuta AnchorWorker ni se envían transacciones.
                      </p>
                    )}
                    {evidencia.checkedAt && (
                      <p className="sig-action-note">Última confirmación persistida: {fechaAuditoria(evidencia.checkedAt)}</p>
                    )}
                  </>
                ) : (
                  <p role="status" className="sig-action-note">La API no devolvió evidencia de anclaje.</p>
                )}
              </section>

              <section className="sig-trace-section" aria-label="Registro de auditoría">
                <h4>Eventos de auditoría</h4>
                {cargandoAuditoria ? (
                  <EstadoCarga texto="Consultando auditoría desde la API…" />
                ) : errorAuditoria ? (
                  <div role="alert" className="sig-review-error">
                    <p>{errorAuditoria}</p>
                    <button type="button" className="sig-btn sig-btn-secondary" onClick={() => setActualizar((actual) => actual + 1)}>
                      Volver a consultar
                    </button>
                  </div>
                ) : eventos.length === 0 ? (
                  <p role="status" className="sig-action-note">La API no devolvió eventos para esta alerta.</p>
                ) : (
                  <ol className="sig-audit-list">
                    {eventos.map((evento) => (
                      <li key={evento.seq}>
                        <code>{evento.seq}</code>
                        <strong>{evento.action}</strong>
                        <span>{fechaAuditoria(evento.occurredAt)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
