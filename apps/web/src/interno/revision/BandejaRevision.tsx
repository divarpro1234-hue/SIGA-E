import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clienteAlertas } from '../adaptador-alertas.mjs';
import type { AlertApproverDetail, AlertSummary } from '../adaptador-alertas.mjs';
import type { Rol } from '../roles.mjs';
import { comprobarSesion } from '../sesion';
import { BadgeCiclo, BadgeSeveridad, EstadoCarga, EstadoVacio } from '../signature/Componentes';
import { verificarInstantanea } from './instantanea.mjs';

const TAMANO_PAGINA = 20;

interface Props {
  rol: Rol;
  usuarioId: string;
  csrf: string;
  esSesionReal: boolean;
}

type Decision = 'approve' | 'reject';
type MotivoFallo = 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'conflicto' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red';
type ResultadoVerificacion = Awaited<ReturnType<typeof verificarInstantanea>>;

interface DecisionConfirmada {
  alerta: AlertSummary;
  version: number;
  digest: string;
  decision: Decision;
}

function mensajeDeFallo(motivo: MotivoFallo): string {
  switch (motivo) {
    case 'sin-sesion':
      return 'La sesión ya no es válida. Vuelve a autenticarte antes de continuar.';
    case 'prohibido':
      return 'El servidor rechazó la autorización o la protección CSRF. No se registró una decisión desde esta interfaz.';
    case 'no-encontrada':
      return 'La alerta ya no está disponible para esta identidad o estado.';
    case 'conflicto':
      return 'La versión o el digest cambiaron. Se han vuelto a consultar los datos autorizados; revisa los valores actuales antes de decidir.';
    case 'invalido':
      return 'El servidor rechazó los datos de la decisión. Revisa el motivo y vuelve a leer la alerta.';
    case 'no-disponible':
      return 'La API interna no está disponible para esta operación.';
    case 'error-red':
      return 'No se recibió una respuesta concluyente por un problema de red. No repitas la decisión sin volver a consultar el estado.';
    case 'error-servidor':
      return 'El servidor no pudo completar la operación. Su resultado puede ser incierto; vuelve a consultar el estado antes de decidir otra vez.';
  }
}

function mensajeVerificacion(resultado: Exclude<ResultadoVerificacion, { ok: true }>): string {
  switch (resultado.motivo) {
    case 'sin-webcrypto':
      return 'Este navegador no dispone de WebCrypto en un contexto seguro; la instantánea no puede verificarse.';
    case 'digest-distinto':
      return 'El digest recibido no coincide con los bytes exactos de la instantánea. La decisión queda bloqueada.';
    case 'utf8':
      return 'La instantánea no es texto UTF-8 estricto. No se sustituirán ni normalizarán bytes.';
    case 'tamano':
      return 'La instantánea supera el límite defensivo de visualización de este cliente.';
    case 'forma':
    case 'digest-forma':
    case 'base64':
      return 'La instantánea recibida no cumple el formato canónico esperado. La decisión queda bloqueada.';
  }
}

export function BandejaRevision({ rol, usuarioId, csrf, esSesionReal }: Props) {
  const puedeConsultar = esSesionReal && rol === 'APPROVER';
  const puedeDecidir = puedeConsultar && usuarioId.trim() !== '' && csrf.trim() !== '';
  const [alertas, setAlertas] = useState<AlertSummary[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState(0);
  const [alertaSeleccionadaId, setAlertaSeleccionadaId] = useState<string | null>(null);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [refrescarLista, setRefrescarLista] = useState(0);
  const [detalle, setDetalle] = useState<AlertApproverDetail | null>(null);
  const [verificacion, setVerificacion] = useState<ResultadoVerificacion | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [refrescarDetalle, setRefrescarDetalle] = useState(0);
  const [decisionPendiente, setDecisionPendiente] = useState<Decision | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorDecision, setErrorDecision] = useState<string | null>(null);
  const [requiereRelectura, setRequiereRelectura] = useState(false);
  const [decisionConfirmada, setDecisionConfirmada] = useState<DecisionConfirmada | null>(null);
  const listaSolicitud = useRef(0);
  const detalleSolicitud = useRef(0);
  const verificacionSolicitud = useRef(0);
  const decisionSolicitud = useRef(0);
  const decisionEnCurso = useRef(0);
  const montada = useRef(false);

  useEffect(() => {
    const solicitud = ++listaSolicitud.current;
    if (!puedeConsultar) {
      setAlertas([]);
      setTotal(0);
      setAlertaSeleccionadaId(null);
      setCargandoLista(false);
      setErrorLista(null);
      return () => {
        if (listaSolicitud.current === solicitud) listaSolicitud.current += 1;
      };
    }

    setCargandoLista(true);
    setErrorLista(null);
    void (async () => {
      try {
        const resultado = await clienteAlertas.listarAlertas({ page: pagina, limit: TAMANO_PAGINA });
        if (listaSolicitud.current !== solicitud) return;
        if (!resultado.ok) {
          setAlertas([]);
          setTotal(0);
          setAlertaSeleccionadaId(null);
          setErrorLista(mensajeDeFallo(resultado.motivo));
          if (resultado.motivo === 'sin-sesion' || resultado.motivo === 'prohibido') {
            void comprobarSesion().catch(() =>
              setErrorLista('No fue posible volver a comprobar la sesión. No se mostrarán ni habilitarán decisiones.'),
            );
          }
          return;
        }
        if (resultado.alertas.some((alerta) => alerta.lifecycleState !== 'PENDING_APPROVAL')) {
          setAlertas([]);
          setTotal(0);
          setAlertaSeleccionadaId(null);
          setErrorLista('El listado de revisión incluyó estados que no corresponden a alertas pendientes. No se ofrecerán decisiones.');
          return;
        }
        const filas: AlertSummary[] = [];
        for (const alerta of resultado.alertas) {
          if (alerta.notice !== 'SIMULACRO') {
            setAlertas([]);
            setTotal(0);
            setAlertaSeleccionadaId(null);
            setErrorLista('El listado no confirmó la marca SIMULACRO requerida. No se mostrarán alertas sin esa marca.');
            return;
          }
          filas.push({
            id: alerta.id,
            identifier: alerta.identifier,
            lifecycleState: alerta.lifecycleState,
            anchorStatus: alerta.anchorStatus,
            notice: alerta.notice,
          });
        }
        setAlertas(filas);
        setTotal(resultado.total);
        setAlertaSeleccionadaId((actual) =>
          filas.some((alerta) => alerta.id === actual) ? actual : filas[0]?.id ?? null,
        );
      } catch {
        if (listaSolicitud.current === solicitud) {
          setAlertas([]);
          setTotal(0);
          setAlertaSeleccionadaId(null);
          setErrorLista('No se pudo completar la consulta de la bandeja. Intenta actualizarla.');
        }
      } finally {
        if (listaSolicitud.current === solicitud) setCargandoLista(false);
      }
    })();

    return () => {
      if (listaSolicitud.current === solicitud) listaSolicitud.current += 1;
    };
  }, [csrf, pagina, puedeConsultar, refrescarLista, usuarioId]);

  useEffect(() => {
    const solicitud = ++detalleSolicitud.current;
    const verificacionId = ++verificacionSolicitud.current;
    setDetalle(null);
    setVerificacion(null);
    setErrorDetalle(null);
    setCargandoDetalle(false);
    if (!puedeConsultar || !alertaSeleccionadaId) {
      return () => {
        if (detalleSolicitud.current === solicitud) detalleSolicitud.current += 1;
        if (verificacionSolicitud.current === verificacionId) verificacionSolicitud.current += 1;
      };
    }

    setCargandoDetalle(true);
    void (async () => {
      try {
        const resultado = await clienteAlertas.obtenerDetalleRevision(alertaSeleccionadaId);
        if (detalleSolicitud.current !== solicitud) return;
        if (!resultado.ok) {
          setErrorDetalle(mensajeDeFallo(resultado.motivo));
          if (resultado.motivo === 'sin-sesion' || resultado.motivo === 'prohibido') {
            void comprobarSesion().catch(() =>
              setErrorDetalle('No fue posible volver a comprobar la sesión. La decisión permanece bloqueada.'),
            );
          }
          return;
        }
        if (resultado.alerta.id !== alertaSeleccionadaId) {
          setErrorDetalle('La respuesta del servidor no corresponde a la alerta seleccionada.');
          return;
        }
        const instantanea = await verificarInstantanea(resultado.alerta.reviewSnapshot);
        if (detalleSolicitud.current !== solicitud || verificacionSolicitud.current !== verificacionId) return;
        setDetalle(resultado.alerta);
        setVerificacion(instantanea);
        if (!instantanea.ok) {
          setErrorDetalle(mensajeVerificacion(instantanea));
          return;
        }
        setRequiereRelectura(false);
      } catch {
        if (detalleSolicitud.current === solicitud) {
          setErrorDetalle('No se pudo leer o verificar la instantánea. La decisión queda bloqueada.');
        }
      } finally {
        if (detalleSolicitud.current === solicitud) setCargandoDetalle(false);
      }
    })();

    return () => {
      if (detalleSolicitud.current === solicitud) detalleSolicitud.current += 1;
      if (verificacionSolicitud.current === verificacionId) verificacionSolicitud.current += 1;
    };
  }, [alertaSeleccionadaId, csrf, puedeConsultar, refrescarDetalle, usuarioId]);

  useEffect(() => {
    setDecisionPendiente(null);
    setMotivoRechazo('');
    setErrorDecision(null);
  }, [alertaSeleccionadaId]);

  useLayoutEffect(() => {
    if (decisionEnCurso.current !== 0) decisionSolicitud.current += 1;
  }, [alertaSeleccionadaId]);

  useEffect(
    () => {
      montada.current = true;
      return () => {
        montada.current = false;
        listaSolicitud.current += 1;
        detalleSolicitud.current += 1;
        verificacionSolicitud.current += 1;
        decisionSolicitud.current += 1;
        decisionEnCurso.current = 0;
      };
    },
    [],
  );

  useEffect(() => {
    decisionSolicitud.current += 1;
    setDecisionPendiente(null);
    setErrorDecision(null);
    setDecisionConfirmada(null);
  }, [csrf, esSesionReal, rol, usuarioId]);

  const volverAConsultar = () => {
    setRequiereRelectura(true);
    setRefrescarDetalle((actual) => actual + 1);
    setRefrescarLista((actual) => actual + 1);
  };

  const confirmarDecision = async () => {
    if (
      !puedeDecidir ||
      !detalle ||
      !verificacion?.ok ||
      !decisionPendiente ||
      requiereRelectura ||
      decisionEnCurso.current !== 0 ||
      detalle.authorId.toLowerCase() === usuarioId.toLowerCase()
    ) {
      return;
    }
    if (decisionPendiente === 'reject' && (motivoRechazo.trim().length < 3 || motivoRechazo.length > 500)) return;

    const solicitud = ++decisionSolicitud.current;
    decisionEnCurso.current = solicitud;
    const detalleActual = detalle;
    const decisionActual = decisionPendiente;
    setEnviando(true);
    setErrorDecision(null);
    setDecisionPendiente(null);

    try {
      const resultado =
        decisionActual === 'approve'
          ? await clienteAlertas.aprobarAlerta(
              detalleActual.id,
              detalleActual.version,
              detalleActual.etag,
              detalleActual.reviewSnapshot.payloadDigestHex,
              csrf,
            )
          : await clienteAlertas.rechazarAlerta(
              detalleActual.id,
              detalleActual.version,
              detalleActual.etag,
              detalleActual.reviewSnapshot.payloadDigestHex,
              motivoRechazo,
              csrf,
            );
      if (decisionSolicitud.current !== solicitud) return;
      if (!resultado.ok) {
        setErrorDecision(mensajeDeFallo(resultado.motivo));
        if (resultado.motivo === 'conflicto') {
          setRequiereRelectura(true);
          setRefrescarDetalle((actual) => actual + 1);
          setRefrescarLista((actual) => actual + 1);
        } else if (resultado.motivo === 'sin-sesion' || resultado.motivo === 'prohibido') {
          setRequiereRelectura(true);
          void comprobarSesion().catch(() =>
            setErrorDecision('No fue posible volver a comprobar la sesión. No repitas la decisión.'),
          );
        } else if (resultado.motivo === 'no-encontrada') {
          setRequiereRelectura(true);
          setRefrescarDetalle((actual) => actual + 1);
          setRefrescarLista((actual) => actual + 1);
        } else if (resultado.motivo === 'error-red' || resultado.motivo === 'error-servidor') {
          setRequiereRelectura(true);
        }
        return;
      }
      setDecisionConfirmada({
        alerta: resultado.alerta,
        version: resultado.version,
        digest: detalleActual.reviewSnapshot.payloadDigestHex,
        decision: decisionActual,
      });
      setAlertaSeleccionadaId(null);
      setPagina(1);
      setRefrescarLista((actual) => actual + 1);
    } catch {
      if (decisionSolicitud.current === solicitud) {
        setRequiereRelectura(true);
        setErrorDecision('No se recibió una respuesta concluyente. No vuelvas a enviar la decisión; consulta el estado de la alerta.');
      }
    } finally {
      if (decisionEnCurso.current === solicitud) {
        decisionEnCurso.current = 0;
        if (montada.current) setEnviando(false);
      }
    }
  };

  const puedeOperar =
    puedeDecidir &&
    detalle?.lifecycleState === 'PENDING_APPROVAL' &&
    verificacion?.ok === true &&
    !requiereRelectura &&
    !enviando &&
    detalle.authorId.toLowerCase() !== usuarioId.toLowerCase();
  const ultimaPagina = Math.max(1, Math.ceil(total / TAMANO_PAGINA));

  if (!puedeConsultar) {
    return (
      <section className="sig-review-guard" role="status">
        <h2>Revisión disponible solo en sesión APPROVER</h2>
        <p>La vista DEMO no consulta alertas operativas ni simula decisiones. El rol visual no concede permisos reales.</p>
      </section>
    );
  }

  return (
    <section className="sig-review-workspace" aria-label="Bandeja de revisión">
      <div className="sig-review-toolbar">
        <div>
          <h2>Alertas pendientes de revisión</h2>
          <p>El backend filtra la bandeja según la sesión APPROVER. Cada detalle se vuelve a autorizar al consultarlo.</p>
        </div>
        <button
          type="button"
          className="sig-btn sig-btn-secondary"
          disabled={cargandoLista}
          onClick={() => setRefrescarLista((actual) => actual + 1)}
        >
          {cargandoLista ? 'Actualizando…' : 'Actualizar bandeja'}
        </button>
      </div>

      {decisionConfirmada && (
        <div className="sig-review-confirmed" role="status" aria-label="Decisión confirmada por el backend">
          <p>
            El backend confirmó <strong>{decisionConfirmada.decision === 'approve' ? 'la aprobación' : 'el rechazo'}</strong> de{' '}
            <strong>{decisionConfirmada.alerta.identifier}</strong>.
          </p>
          <dl className="sig-review-confirmed-data">
            <div>
              <dt>Estado confirmado</dt>
              <dd><BadgeCiclo estado={decisionConfirmada.alerta.lifecycleState} /></dd>
            </div>
            <div>
              <dt>Versión confirmada por ETag</dt>
              <dd>v{decisionConfirmada.version}</dd>
            </div>
            <div>
              <dt>Digest de la instantánea enviada</dt>
              <dd><code>{decisionConfirmada.digest}</code></dd>
            </div>
          </dl>
          <p>La cola se actualizará desde el servidor. Esta decisión no representa una firma ni un anclaje blockchain.</p>
        </div>
      )}

      {!csrf.trim() && (
        <p role="alert" className="sig-review-error">
          No hay token CSRF en la sesión actual. La consulta puede mostrarse, pero las decisiones permanecen bloqueadas.
        </p>
      )}

      <div className="sig-review-layout">
        <section className="sig-review-queue" aria-label="Alertas pendientes">
          <div className="sig-review-queue-heading">
            <h3>Cola de revisión</h3>
            <span>{total} {total === 1 ? 'alerta pendiente' : 'alertas pendientes'}</span>
          </div>
          {cargandoLista ? (
            <EstadoCarga texto="Consultando alertas pendientes…" />
          ) : errorLista ? (
            <div role="alert" className="sig-review-error">
              <p>{errorLista}</p>
              <button type="button" className="sig-btn sig-btn-secondary" onClick={() => setRefrescarLista((actual) => actual + 1)}>
                Volver a consultar
              </button>
            </div>
          ) : alertas.length === 0 ? (
            <EstadoVacio mensaje="No hay alertas pendientes de revisión en esta página." />
          ) : (
            <>
              <ul className="sig-review-list">
                {alertas.map((alerta) => (
                  <li key={alerta.id}>
                    <button
                      type="button"
                      className={alerta.id === alertaSeleccionadaId ? 'sig-review-item sig-review-item-selected' : 'sig-review-item'}
                      aria-current={alerta.id === alertaSeleccionadaId ? 'true' : undefined}
                      onClick={() => {
                        setDecisionConfirmada(null);
                        setAlertaSeleccionadaId(alerta.id);
                      }}
                    >
                      <span className="sig-review-item-id">{alerta.identifier}</span>
                      <span className="sig-review-item-meta">
                        <BadgeCiclo estado={alerta.lifecycleState} />
                        <span>{alerta.notice}</span>
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

        <section className="sig-review-detail" aria-label="Detalle de la alerta seleccionada">
          {!alertaSeleccionadaId ? (
            <EstadoVacio mensaje="Selecciona una alerta pendiente para consultar su detalle autorizado." />
          ) : cargandoDetalle ? (
            <EstadoCarga texto="Consultando detalle y verificando los bytes congelados…" />
          ) : errorDetalle ? (
            <div role="alert" className="sig-review-error">
              <p>{errorDetalle}</p>
              <button type="button" className="sig-btn sig-btn-secondary" onClick={volverAConsultar}>
                Volver a consultar detalle
              </button>
            </div>
          ) : detalle && verificacion?.ok ? (
            <>
              <header className="sig-review-detail-header">
                <div>
                  <p className="sig-detail-label">SIMULACRO · DETALLE DE REVISIÓN</p>
                  <h3>{detalle.identifier}</h3>
                </div>
                <div className="sig-review-status">
                  <BadgeCiclo estado={detalle.lifecycleState} />
                  <BadgeSeveridad severidad={detalle.severity} />
                </div>
              </header>

              <dl className="sig-review-metadata">
                <div><dt>Tipo</dt><dd>{detalle.kind}</dd></div>
                <div><dt>Identidad AUTHOR</dt><dd><code>{detalle.authorId}</code></dd></div>
                <div><dt>Versión leída</dt><dd>v{detalle.version}</dd></div>
                <div><dt>ETag fuerte</dt><dd><code>{detalle.etag}</code></dd></div>
              </dl>

              {detalle.authorId.toLowerCase() === usuarioId.toLowerCase() ? (
                <p role="alert" className="sig-review-error">
                  Esta alerta pertenece a la identidad actual. La interfaz bloquea la autoaprobación y el servidor también debe rechazarla.
                </p>
              ) : null}

              <section className="sig-review-digest" aria-label="Verificación del digest de revisión">
                <h4>Digest autoritativo de revisión</h4>
                <code>{detalle.reviewSnapshot.payloadDigestHex}</code>
                <p>
                  El navegador comprobó localmente que SHA-256 de los bytes recibidos coincide con este valor. El servidor sigue siendo
                  responsable de validar esos bytes contra el contenido persistido.
                </p>
              </section>

              <section className="sig-review-snapshot" aria-label="Contenido no confiable de la instantánea">
                <h4>Instantánea congelada · texto no confiable</h4>
                <pre dir="auto">{verificacion.texto}</pre>
                <details>
                  <summary>Ver payloadBase64Url recibido</summary>
                  <code>{detalle.reviewSnapshot.payloadBase64Url}</code>
                </details>
              </section>

              {errorDecision && <p role="alert" className="sig-review-error">{errorDecision}</p>}
              {requiereRelectura && (
                <p role="status" className="sig-review-warning">
                  Las decisiones están bloqueadas hasta recibir correctamente una lectura nueva de esta alerta.
                </p>
              )}

              {decisionPendiente ? (
                <section className="sig-review-confirmation" aria-label="Confirmación de decisión">
                  <h4>Confirmar {decisionPendiente === 'approve' ? 'aprobación' : 'rechazo'}</h4>
                  <p>
                    Se enviará al backend la versión v{detalle.version} y el digest mostrado arriba para <strong>{detalle.identifier}</strong>.
                    La decisión es irreversible para esta versión.
                  </p>
                  {decisionPendiente === 'reject' && (
                    <label className="sig-review-reason">
                      Motivo del rechazo (3–500 caracteres)
                      <textarea
                        value={motivoRechazo}
                        maxLength={500}
                        rows={4}
                        onChange={(event) => setMotivoRechazo(event.target.value)}
                        aria-describedby="sig-review-reason-count"
                      />
                      <span id="sig-review-reason-count">{motivoRechazo.length}/500</span>
                    </label>
                  )}
                  <div className="sig-review-actions">
                    <button
                      type="button"
                      className="sig-btn sig-btn-primary"
                      disabled={
                        !puedeOperar ||
                        (decisionPendiente === 'reject' &&
                          (motivoRechazo.trim().length < 3 || motivoRechazo.length > 500))
                      }
                      onClick={() => void confirmarDecision()}
                    >
                      {enviando ? 'Enviando decisión…' : `Confirmar ${decisionPendiente === 'approve' ? 'aprobación' : 'rechazo'}`}
                    </button>
                    <button
                      type="button"
                      className="sig-btn sig-btn-secondary"
                      disabled={enviando}
                      onClick={() => {
                        setDecisionPendiente(null);
                        setMotivoRechazo('');
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </section>
              ) : (
                <div className="sig-review-actions">
                  <button
                    type="button"
                    className="sig-btn sig-btn-primary"
                    disabled={!puedeOperar}
                    onClick={() => setDecisionPendiente('approve')}
                  >
                    Aprobar
                  </button>
                  <button
                    type="button"
                    className="sig-btn sig-btn-secondary"
                    disabled={!puedeOperar}
                    onClick={() => setDecisionPendiente('reject')}
                  >
                    Rechazar
                  </button>
                  {requiereRelectura && (
                    <button type="button" className="sig-btn sig-btn-secondary" onClick={volverAConsultar}>
                      Consultar estado actual
                    </button>
                  )}
                </div>
              )}
              {enviando && <p role="status" className="sig-review-progress">Enviando una sola decisión al backend…</p>}
            </>
          ) : (
            <EstadoVacio mensaje="Selecciona una alerta pendiente para consultar su detalle autorizado." />
          )}
        </section>
      </div>
    </section>
  );
}
