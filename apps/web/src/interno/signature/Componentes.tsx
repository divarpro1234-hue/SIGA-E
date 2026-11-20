// SIGA-E SIGNATURE — Componentes de presentación atómicos (F3).
// Badge de estado del ciclo, badge de severidad, tarjeta de alerta.
// Todos son puramente presentacionales; no mutan estado global.

import type { AlertaInterna } from '../bandeja/tipos';

// ─── Badge de ciclo de vida ──────────────────────────────────────────────────

const PILL_CLASS: Record<string, string> = {
  DRAFT: 'sig-pill sig-pill-draft',
  PENDING_APPROVAL: 'sig-pill sig-pill-pending',
  REJECTED: 'sig-pill sig-pill-rejected',
  READY_TO_SIGN: 'sig-pill sig-pill-ready',
  SIGNING: 'sig-pill sig-pill-signing',
  SIGNED_PENDING_ANCHOR: 'sig-pill sig-pill-anchor',
  PUBLISHED: 'sig-pill sig-pill-published',
};

const PILL_LABEL: Record<string, string> = {
  DRAFT: 'BORRADOR',
  PENDING_APPROVAL: 'PEND. APROBACIÓN',
  REJECTED: 'RECHAZADA',
  READY_TO_SIGN: 'LISTA PARA EMITIR',
  SIGNING: 'FIRMANDO',
  SIGNED_PENDING_ANCHOR: 'PEND. ANCLAJE',
  PUBLISHED: 'PUBLICADA',
};

export function BadgeCiclo({ estado }: { estado: string }) {
  const cls = PILL_CLASS[estado] ?? 'sig-pill sig-pill-draft';
  const label = PILL_LABEL[estado] ?? estado;
  return (
    <span className={cls} aria-label={`Estado: ${label}`}>
      {label}
    </span>
  );
}

// ─── Badge de severidad ──────────────────────────────────────────────────────

const SEV_CLASS: Record<string, string> = {
  Extreme: 'sig-sev-badge sig-sev-extreme',
  Severe: 'sig-sev-badge sig-sev-severe',
  Moderate: 'sig-sev-badge sig-sev-moderate',
  Minor: 'sig-sev-badge sig-sev-minor',
  Unknown: 'sig-sev-badge',
};

export function BadgeSeveridad({ severidad }: { severidad: string }) {
  const cls = SEV_CLASS[severidad] ?? 'sig-sev-badge sig-sev-moderate';
  return (
    <span className={cls} aria-label={`Severidad: ${severidad}`}>
      {severidad.toUpperCase()}
    </span>
  );
}

// ─── Clase de borde por severidad ────────────────────────────────────────────

export function claseTarjeta(severidad: string): string {
  const map: Record<string, string> = {
    Extreme: 'sig-alert-card sig-card-sev-extreme',
    Severe: 'sig-alert-card sig-card-sev-severe',
    Moderate: 'sig-alert-card sig-card-sev-moderate',
    Minor: 'sig-alert-card sig-card-sev-minor',
  };
  return map[severidad] ?? 'sig-alert-card';
}

// ─── Tarjeta de alerta en la bandeja ─────────────────────────────────────────

interface TarjetaAlertaProps {
  alerta: AlertaInterna;
  seleccionada: boolean;
  onClick: () => void;
}

export function TarjetaAlerta({ alerta, seleccionada, onClick }: TarjetaAlertaProps) {
  const severidad = alerta.info?.severity;
  const fecha = alerta.sent ? new Date(alerta.sent) : null;
  const horaUtc =
    fecha && !Number.isNaN(fecha.valueOf())
      ? `${fecha.toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : 'Fecha no incluida';

  return (
    <div
      className={claseTarjeta(severidad ?? '')}
      role="option"
      aria-selected={seleccionada}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="sig-card-head">
        {severidad ? <BadgeSeveridad severidad={severidad} /> : null}
        <span className="sig-card-id">{alerta.identifier}</span>
        <BadgeCiclo estado={alerta.lifecycleState} />
      </div>
      <p className="sig-card-headline">
        {alerta.info?.headline ?? 'Titular no incluido en el resumen'}
      </p>
      <div className="sig-card-meta">
        <span className="sig-card-ts">{horaUtc}</span>
        {alerta.version ? <span className="sig-card-ts">v{alerta.version}</span> : null}
      </div>
    </div>
  );
}

// ─── Estado vacío ─────────────────────────────────────────────────────────────

export function EstadoVacio({ mensaje }: { mensaje: string }) {
  return (
    <div className="sig-empty-state" role="status">
      <div className="sig-empty-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </div>
      <p className="sig-empty-title">Bandeja al día</p>
      <p className="sig-empty-body">{mensaje}</p>
    </div>
  );
}

// ─── Estado de carga ──────────────────────────────────────────────────────────

export function EstadoCarga({ texto }: { texto: string }) {
  return (
    <div className="sig-loading-state" role="status" aria-live="polite">
      <div className="sig-loading-spinner" aria-hidden="true" />
      <p className="sig-loading-text">{texto}</p>
    </div>
  );
}

// ─── Estado de error ──────────────────────────────────────────────────────────

interface EstadoErrorProps {
  mensaje: string;
  onReintentar?: () => void;
}

export function EstadoError({ mensaje, onReintentar }: EstadoErrorProps) {
  return (
    <div className="sig-error-state" role="alert">
      <span className="sig-error-icon" aria-hidden="true">⚠</span>
      <p className="sig-error-text">{mensaje}</p>
      {onReintentar && (
        <button type="button" className="sig-btn sig-btn-secondary" onClick={onReintentar}>
          Volver a intentar
        </button>
      )}
    </div>
  );
}
