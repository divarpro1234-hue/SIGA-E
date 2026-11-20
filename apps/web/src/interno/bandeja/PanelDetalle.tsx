// SIGA-E SIGNATURE — Panel de detalle de alerta (F3).
// Muestra la ficha principal, acciones según rol y estado del ciclo,
// y el panel de trazabilidad (4 fases).
//
// INVARIANTES:
// - No muestra firma válida sin verificación real (M3 pendiente).
// - No muestra anclaje confirmado como verificación independiente.
// - El envío AUTHOR solo se habilita con sesión real, detalle vigente y confirmación explícita.
// - La descripción se muestra en caja de texto no confiable.

import { Fragment, useEffect, useState } from 'react';
import type { AlertaInterna } from '../bandeja/tipos';
import { FUENTE_ANCLAJE } from '../estados-alerta.mjs';
import type { Rol } from '../roles.mjs';
import { BadgeCiclo, BadgeSeveridad } from '../signature/Componentes';

// ─── Acciones por rol y estado ───────────────────────────────────────────────

interface AccionPendienteProps {
  label: string;
  nota: string;
}

function AccionDiferida({ label, nota }: AccionPendienteProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <button type="button" className="sig-btn sig-btn-primary" disabled aria-disabled="true">
        {label}
      </button>
      <p className="sig-action-note">{nota}</p>
    </div>
  );
}

interface ResultadoEnvioRevision {
  estado: AlertaInterna['lifecycleState'];
  digest: string;
}

type DecisionRevision = 'approve' | 'reject';

interface DatosRevisionVerificada {
  authorId: string;
  contenido: string;
  digest: string;
  version: number;
  etag: string;
}

interface ResultadoDecisionRevision {
  decision: DecisionRevision;
  estado: AlertaInterna['lifecycleState'];
  version: number;
  digest: string;
}

interface PropsAccionesAutor {
  alerta: AlertaInterna;
  esSesionReal: boolean;
  puedeEnviar: boolean;
  enviando: boolean;
  error: string | null;
  resultado: ResultadoEnvioRevision | null;
  onEnviar: () => void | Promise<void>;
}

function AccionesAutor({
  alerta,
  esSesionReal,
  puedeEnviar,
  enviando,
  error,
  resultado,
  onEnviar,
}: PropsAccionesAutor) {
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    setConfirmando(false);
  }, [alerta.id, alerta.version, puedeEnviar]);

  const feedback = (
    <>
      {enviando && <p role="status" className="sig-action-note">Enviando solicitud al servidor…</p>}
      {error && <p role="alert" className="sig-action-note">{error}</p>}
      {resultado && (
        <div role="status" aria-label="Resultado confirmado por el servidor" className="sig-action-note">
          <p>Respuesta confirmada por el backend: estado <strong>{resultado.estado}</strong>.</p>
          <p>Digest autoritativo del payload congelado:</p>
          <code>{resultado.digest}</code>
        </div>
      )}
    </>
  );

  if (alerta.lifecycleState === 'DRAFT') {
    return (
      <>
        {puedeEnviar ? (
          confirmando ? (
            <div role="group" aria-label="Confirmación de envío a revisión">
              <p className="sig-action-note">
                Se enviará a revisión la versión vigente de <strong>{alerta.identifier}</strong>. Esta operación cambia su estado.
              </p>
              <div className="sig-actions-group">
                <button
                  type="button"
                  className="sig-btn sig-btn-primary"
                  disabled={enviando}
                  onClick={() => void onEnviar()}
                >
                  {enviando ? 'Enviando…' : 'Confirmar envío a revisión'}
                </button>
                <button
                  type="button"
                  className="sig-btn sig-btn-secondary"
                  disabled={enviando}
                  onClick={() => setConfirmando(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="sig-btn sig-btn-primary"
              disabled={enviando}
              onClick={() => setConfirmando(true)}
            >
              Enviar a revisión →
            </button>
          )
        ) : (
          <>
            <button type="button" className="sig-btn sig-btn-primary" disabled aria-disabled="true">
              Enviar a revisión →
            </button>
            <p className="sig-action-note">
              {esSesionReal
                ? 'Se requiere el detalle AUTHOR vigente en estado DRAFT y su ETag fuerte.'
                : 'Acción deshabilitada en DEMO. El selector visual de rol no concede permisos reales.'}
            </p>
          </>
        )}
        {feedback}
      </>
    );
  }
  if (alerta.lifecycleState === 'READY_TO_SIGN') {
    return (
      <>
        <AccionDiferida
          label="Solicitar emisión y firma ES256 →"
          nota="INTEGRACIÓN PENDIENTE (Contrato OpenAPI v1.2). Despacha la firma JWS ES256 en el servidor y el anclaje en Soroban Testnet."
        />
        {feedback}
      </>
    );
  }
  return (
    <>
      <p className="sig-action-note">
        En el estado <strong>{alerta.lifecycleState}</strong> no hay acciones disponibles para el rol de Autoría.
      </p>
      {feedback}
    </>
  );
}

interface PropsAccionesAprobador {
  alerta: AlertaInterna;
  esSesionReal: boolean;
  detalleRevision: DatosRevisionVerificada | null;
  puedeDecidir: boolean;
  enviando: boolean;
  requiereRelectura: boolean;
  error: string | null;
  resultado: ResultadoDecisionRevision | null;
  onDecidir: (decision: DecisionRevision, motivo: string) => void | Promise<void>;
  onReintentar: () => void;
}

function motivoFormalValido(motivo: string): boolean {
  return (
    Array.from(motivo.trim()).length >= 3 &&
    Array.from(motivo).length <= 500 &&
    !/[\r\n\u2028\u2029]/u.test(motivo)
  );
}

function AccionesAprobador({
  alerta,
  esSesionReal,
  detalleRevision,
  puedeDecidir,
  enviando,
  requiereRelectura,
  error,
  resultado,
  onDecidir,
  onReintentar,
}: PropsAccionesAprobador) {
  const [decisionPendiente, setDecisionPendiente] = useState<DecisionRevision | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  useEffect(() => {
    setDecisionPendiente(null);
    setMotivoRechazo('');
  }, [alerta.id, alerta.version, alerta.lifecycleState, puedeDecidir]);

  if (alerta.lifecycleState === 'PENDING_APPROVAL') {
    return (
      <>
        {error && <p role="alert" className="sig-review-error">{error}</p>}
        {requiereRelectura && (
          <p role="status" className="sig-review-warning">
            Las decisiones permanecen bloqueadas hasta volver a leer el estado actual desde el servidor.
          </p>
        )}
        {!esSesionReal && (
          <p className="sig-action-note">Acciones bloqueadas en DEMO. El rol visual no concede permisos reales.</p>
        )}
        {esSesionReal && !detalleRevision && (
          <p role="status" className="sig-action-note">
            La instantánea de revisión aún no se ha recibido y verificado localmente.
          </p>
        )}
        {detalleRevision && (
          <p className="sig-action-note">
            Revisión vinculada a v{detalleRevision.version} · ETag {detalleRevision.etag}.
          </p>
        )}
        {resultado && (
          <div role="status" aria-label="Decisión confirmada por el backend" className="sig-action-note">
            El backend confirmó el {resultado.decision === 'approve' ? 'dictamen de aprobación' : 'rechazo'}:
            {' '}estado <strong>{resultado.estado}</strong>, versión v{resultado.version}.
            <p>Digest revisado: <code>{resultado.digest}</code></p>
          </div>
        )}
        {decisionPendiente ? (
          <section className="sig-review-confirmation" aria-label="Confirmación de decisión">
            <h4>Confirmar {decisionPendiente === 'approve' ? 'aprobación' : 'rechazo'}</h4>
            <p>
              Se enviará al backend la alerta <strong>{alerta.identifier}</strong>, versión v
              {detalleRevision?.version}, su ETag y el digest de los bytes congelados. La decisión aplica solo a esta versión.
            </p>
            {decisionPendiente === 'reject' && (
              <label className="sig-review-reason">
                Motivo formal del rechazo (3–500 caracteres, sin saltos de línea)
                <textarea
                  value={motivoRechazo}
                  maxLength={1000}
                  rows={4}
                  onChange={(event) => setMotivoRechazo(event.target.value)}
                  aria-describedby="sig-approval-reason-count"
                />
                <span id="sig-approval-reason-count">{Array.from(motivoRechazo).length}/500</span>
              </label>
            )}
            <div className="sig-actions-group sig-review-actions">
              <button
                type="button"
                className="sig-btn sig-btn-primary"
                disabled={
                  !puedeDecidir ||
                  enviando ||
                  (decisionPendiente === 'reject' && !motivoFormalValido(motivoRechazo))
                }
                onClick={() => void onDecidir(decisionPendiente, motivoRechazo)}
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
          <div className="sig-actions-group">
            <button
              type="button"
              className="sig-btn sig-btn-primary"
              disabled={!puedeDecidir || enviando}
              onClick={() => setDecisionPendiente('approve')}
            >
              Aprobar
            </button>
            <button
              type="button"
              className="sig-btn sig-btn-secondary"
              disabled={!puedeDecidir || enviando}
              onClick={() => setDecisionPendiente('reject')}
            >
              Rechazar
            </button>
            {requiereRelectura && (
              <button type="button" className="sig-btn sig-btn-secondary" disabled={enviando} onClick={onReintentar}>
                Volver a leer estado actual
              </button>
            )}
          </div>
        )}
        {enviando && <p role="status" className="sig-action-note">Enviando una sola decisión al backend…</p>}
      </>
    );
  }
  return (
    <>
      {resultado && (
        <div role="status" aria-label="Decisión confirmada por el backend" className="sig-action-note">
          El backend confirmó el {resultado.decision === 'approve' ? 'dictamen de aprobación' : 'rechazo'}:
          {' '}estado <strong>{resultado.estado}</strong>, versión v{resultado.version}.
          <p>Digest revisado: <code>{resultado.digest}</code></p>
        </div>
      )}
      <p className="sig-action-note">
        En el estado <strong>{alerta.lifecycleState}</strong> no hay acciones pendientes para el rol de Aprobación.
      </p>
    </>
  );
}

function AccionesAdmin() {
  return (
    <p className="sig-action-note">
      El rol de Administración no crea, aprueba ni firma alertas. Las operaciones de auditoría y
      trabajos de anclaje están diferidas en el MVP.
    </p>
  );
}

interface PropsPanelAcciones extends Omit<PropsAccionesAutor, 'alerta'> {
  alerta: AlertaInterna;
  rol: Rol;
  accionesAprobador: PropsAccionesAprobador;
}

function PanelAcciones({ alerta, rol, accionesAprobador, ...accionesAutor }: PropsPanelAcciones) {
  return (
    <section className="sig-action-section" aria-label="Acciones disponibles">
      <p className="sig-section-title">Dictamen · {rol === 'APPROVER' ? 'Aprobación' : rol === 'AUTHOR' ? 'Autoría' : 'Administración'}</p>
      <div className="sig-actions-group" style={{ flexDirection: 'column' }}>
        {rol === 'AUTHOR' && <AccionesAutor alerta={alerta} {...accionesAutor} />}
        {rol === 'APPROVER' && <AccionesAprobador {...accionesAprobador} />}
        {rol === 'ADMIN' && <AccionesAdmin />}
      </div>
    </section>
  );
}

// ─── Trazabilidad (4 fases) ───────────────────────────────────────────────────

interface FaseTraza {
  num: string;
  nombre: string;
  filas: Array<{ clave: string; valor: string; mono?: boolean }>;
  nota?: string;
}

function FaseTrazabilidad({ fase }: { fase: FaseTraza }) {
  return (
    <div className="sig-trace-phase">
      <div className="sig-trace-phase-header">
        <span className="sig-trace-phase-num">FASE {fase.num}</span>
        <span className="sig-trace-phase-name">{fase.nombre}</span>
      </div>
      <div className="sig-trace-row">
        {fase.filas.map((f) => (
          <Fragment key={f.clave}>
            <span className="sig-trace-key">{f.clave}</span>
            <span className={`sig-trace-val${f.mono ? ' sig-trace-val-mono' : ''}`}>{f.valor}</span>
          </Fragment>
        ))}
      </div>
      {fase.nota && <p className="sig-anchor-note">{fase.nota}</p>}
    </div>
  );
}

function PanelTrazabilidad({ alerta }: { alerta: AlertaInterna }) {
  const fase1: FaseTraza = {
    num: '01',
    nombre: 'Origen · Payload',
    filas: [
      { clave: 'Emisor', valor: alerta.sender ?? 'No incluido en el DTO de detalle' },
      { clave: 'Identificador', valor: alerta.identifier, mono: true },
      { clave: 'Enviado', valor: alerta.sent ?? 'No incluido en el DTO de detalle', mono: true },
      { clave: 'Versión', valor: alerta.version === undefined ? 'No incluida en el resumen' : `v${alerta.version}` },
      {
        clave: 'Autor',
        valor: alerta.author?.name ?? 'No incluido en el DTO de detalle',
      },
      {
        clave: 'Digest SHA-256',
        valor: alerta.frozenPayload
          ? alerta.frozenPayload.payloadDigestHex
          : 'No incluido en el DTO de detalle',
        mono: true,
      },
      {
        clave: 'Bytes',
        valor: alerta.frozenPayload?.bytesCount === undefined ? 'No informado' : String(alerta.frozenPayload.bytesCount),
      },
    ],
  };

  const fase2: FaseTraza = {
    num: '02',
    nombre: 'Dictamen · Aprobación',
    filas: alerta.approver
      ? [
          { clave: 'Aprobador', valor: alerta.approver.name },
          { clave: 'Aprobado en', valor: alerta.approver.approvedAt, mono: true },
          { clave: 'Estado', valor: alerta.lifecycleState, mono: true },
        ]
      : [
          { clave: 'Estado', valor: alerta.lifecycleState, mono: true },
          { clave: 'Aprobador', valor: '(pendiente)' },
        ],
  };

  const fase3: FaseTraza = {
    num: '03',
    nombre: 'Integridad · Firma JWS ES256',
    filas: [
      {
        clave: 'JWS compacto',
        valor:
          alerta.lifecycleState === 'SIGNED_PENDING_ANCHOR' ||
          alerta.lifecycleState === 'PUBLISHED'
            ? '(comprobación pendiente en este cliente — Contrato OpenAPI v1.2)'
            : '(no firmada todavía)',
        mono: true,
      },
      {
        clave: 'jws_hash',
        valor: '(se calculará como SHA-256(ASCII(jws_compact)) tras la firma)',
        mono: true,
      },
    ],
    nota: 'La clave privada ES256 reside exclusivamente en el servidor (M3). Este cliente no asume ni declara firmas válidas a partir de fixtures sin verificación criptográfica activa.',
  };

  const fase4: FaseTraza = {
    num: '04',
    nombre: 'Registro · Soroban Testnet',
    filas: [
      {
        clave: 'Anclaje',
        valor: alerta.anchorStatus,
        mono: true,
      },
      {
        clave: 'tx_hash',
        valor:
          alerta.anchorStatus === 'CONFIRMED'
            ? '(reportado por API — NO COMPROBADO SOBERANAMENTE EN ESTE CLIENTE)'
            : '(no disponible)',
        mono: true,
      },
    ],
    nota:
      FUENTE_ANCLAJE +
      ' Metadato informativo de API. La comprobación soberana e independiente del estado on-chain requiere la CLI notarial externa (siga-e-cli verify).',
  };

  return (
    <section className="sig-trace-section" aria-label="Trazabilidad criptográfica">
      <p className="sig-section-title">Trazabilidad · 4 Fases</p>
      <FaseTrazabilidad fase={fase1} />
      <FaseTrazabilidad fase={fase2} />
      <FaseTrazabilidad fase={fase3} />
      <FaseTrazabilidad fase={fase4} />
    </section>
  );
}

// ─── Panel principal de detalle ───────────────────────────────────────────────

interface PanelDetalleProps {
  alerta: AlertaInterna;
  auditoria?: readonly { seq: string; occurredAt: string; action: string }[];
  rol: Rol;
  onVolver?: () => void;
  esSesionReal: boolean;
  detalleCargando: boolean;
  errorDetalle: string | null;
  onReintentarDetalle: () => void;
  puedeEnviarRevision: boolean;
  enviandoRevision: boolean;
  errorEnvio: string | null;
  resultadoEnvio: ResultadoEnvioRevision | null;
  onEnviarRevision: () => void | Promise<void>;
  detalleRevision: DatosRevisionVerificada | null;
  puedeDecidirRevision: boolean;
  enviandoDecision: boolean;
  requiereRelecturaDecision: boolean;
  errorDecision: string | null;
  resultadoDecision: ResultadoDecisionRevision | null;
  onDecidirRevision: (decision: DecisionRevision, motivo: string) => void | Promise<void>;
  onReintentarRevision: () => void;
}

function fechaUtc(valor?: string): string {
  if (!valor) return 'No incluida en el DTO consultado';
  const fecha = new Date(valor);
  return Number.isNaN(fecha.valueOf())
    ? 'Fecha no válida recibida del servidor'
    : `${fecha.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function PanelDetalle({
  alerta,
  auditoria = [],
  rol,
  onVolver,
  esSesionReal,
  detalleCargando,
  errorDetalle,
  onReintentarDetalle,
  puedeEnviarRevision,
  enviandoRevision,
  errorEnvio,
  resultadoEnvio,
  onEnviarRevision,
  detalleRevision,
  puedeDecidirRevision,
  enviandoDecision,
  requiereRelecturaDecision,
  errorDecision,
  resultadoDecision,
  onDecidirRevision,
  onReintentarRevision,
}: PanelDetalleProps) {
  return (
    <article className="sig-detail-panel" aria-label={`Detalle: ${alerta.identifier}`}>
      {/* Botón de volver (visible solo en móvil) */}
      {onVolver && (
        <button type="button" className="sig-btn-back" onClick={onVolver}>
          ← Volver a la Bandeja
        </button>
      )}

      {/* Ficha principal */}
      <div className="sig-detail-hero">
        <div className="sig-detail-label">
          <span>SIMULACRO OPERATIVO</span>
          <span className="sig-detail-id">{alerta.identifier}</span>
          <span style={{ marginLeft: 'auto' }}>
            <BadgeCiclo estado={alerta.lifecycleState} />
          </span>
        </div>

        <h2 className="sig-detail-headline">
          {rol === 'APPROVER'
            ? 'Alerta congelada para revisión'
            : alerta.info?.headline ?? 'Titular no incluido en el resumen'}
        </h2>

        {detalleCargando && <p role="status" className="sig-action-note">Consultando detalle autoritativo…</p>}
        {errorDetalle && <p role="alert" className="sig-action-note">{errorDetalle}</p>}
        {errorDetalle && esSesionReal && (
          <button type="button" className="sig-btn sig-btn-secondary" onClick={onReintentarDetalle}>
            Volver a consultar detalle
          </button>
        )}

        {rol === 'APPROVER' ? (
          detalleRevision ? (
            <>
              <dl className="sig-review-metadata">
                <div><dt>Identidad AUTHOR</dt><dd><code>{detalleRevision.authorId}</code></dd></div>
                <div><dt>Versión leída</dt><dd>v{detalleRevision.version}</dd></div>
                <div><dt>ETag fuerte</dt><dd><code>{detalleRevision.etag}</code></dd></div>
              </dl>
              <section className="sig-review-digest" aria-label="Verificación local del digest de revisión">
                <h4>Digest del contenido congelado</h4>
                <code>{detalleRevision.digest}</code>
                <p>SHA-256 se calculó en este navegador sobre los bytes originales del payload.</p>
              </section>
              <section className="sig-review-snapshot" aria-label="Contenido no confiable de la instantánea">
                <h4>Contenido congelado · texto no confiable</h4>
                <pre dir="auto">{detalleRevision.contenido}</pre>
              </section>
            </>
          ) : (
            <p role="status" className="sig-action-note">
              El contenido congelado solo se mostrará cuando el detalle de revisión del backend y su digest hayan sido verificados.
            </p>
          )
        ) : (
          <div className="sig-untrusted-text">
            <span className="sig-untrusted-label">Descripción (texto no confiable del payload)</span>
            {alerta.info?.description ?? 'Descripción no incluida en el resumen.'}
          </div>
        )}

        {/* Metadatos */}
        <div className="sig-meta-grid">
          <div className="sig-meta-item">
            <span className="sig-meta-label">Severidad</span>
            <span className="sig-meta-value">
              {alerta.info?.severity ? <BadgeSeveridad severidad={alerta.info.severity} /> : 'No incluida en el resumen'}
            </span>
          </div>
          <div className="sig-meta-item">
            <span className="sig-meta-label">Área</span>
            <span className="sig-meta-value">{alerta.info?.areaDesc ?? 'No incluida en el resumen'}</span>
          </div>
          <div className="sig-meta-item">
            <span className="sig-meta-label">Tipo de evento</span>
            <span className="sig-meta-value">{alerta.info?.event ?? 'No incluido en el resumen'}</span>
          </div>
          <div className="sig-meta-item">
            <span className="sig-meta-label">Enviado</span>
            <span className="sig-meta-value sig-meta-value-mono">
              {fechaUtc(alerta.sent)}
            </span>
          </div>
          <div className="sig-meta-item">
            <span className="sig-meta-label">Expira</span>
            <span className="sig-meta-value sig-meta-value-mono">
              {fechaUtc(alerta.info?.expires)}
            </span>
          </div>
          <div className="sig-meta-item">
            <span className="sig-meta-label">Autor</span>
            <span className="sig-meta-value">{alerta.author?.name ?? 'No incluido en el DTO de detalle'}</span>
          </div>
        </div>
      </div>

      {/* Acciones por rol */}
      <PanelAcciones
        alerta={alerta}
        rol={rol}
        esSesionReal={esSesionReal}
        puedeEnviar={puedeEnviarRevision}
        enviando={enviandoRevision}
        error={errorEnvio}
        resultado={resultadoEnvio}
        onEnviar={onEnviarRevision}
        accionesAprobador={{
          alerta,
          esSesionReal,
          detalleRevision,
          puedeDecidir: puedeDecidirRevision,
          enviando: enviandoDecision,
          requiereRelectura: requiereRelecturaDecision,
          error: errorDecision,
          resultado: resultadoDecision,
          onDecidir: onDecidirRevision,
          onReintentar: onReintentarRevision,
        }}
      />

      {/* Trazabilidad */}
      <PanelTrazabilidad alerta={alerta} />
      {esSesionReal && (
        <section className="sig-trace-section" aria-label="Registro de auditoría">
          <p className="sig-section-title">Auditoría · eventos confirmados</p>
          {auditoria.length === 0 ? (
            <p className="sig-action-note">Sin eventos disponibles en esta consulta.</p>
          ) : (
            <ol className="sig-audit-list">
              {auditoria.map((evento) => (
                <li key={evento.seq}>
                  <code>{evento.seq}</code>
                  <strong>{evento.action}</strong>
                  <span>{fechaUtc(evento.occurredAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </article>
  );
}

// ─── Estado sin selección ────────────────────────────────────────────────────

export function SinSeleccion() {
  return (
    <div className="sig-empty-state" role="status" aria-live="polite">
      <div className="sig-empty-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </div>
      <p className="sig-empty-title">Selecciona una alerta</p>
      <p className="sig-empty-body">
        Elige una alerta de la bandeja para ver su ficha completa, acciones disponibles y trazabilidad criptográfica.
      </p>
    </div>
  );
}
