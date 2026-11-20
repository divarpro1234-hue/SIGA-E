// Tipos de la Bandeja Operativa (F3).
// Derivados del contrato OpenAPI v1.2 y de estados-alerta.mjs.
// Este archivo NO importa datos de demostración.

export type EstadoCiclo =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'READY_TO_SIGN'
  | 'SIGNING'
  | 'SIGNED_PENDING_ANCHOR'
  | 'PUBLISHED';

export type EstadoAnclaje =
  | 'NOT_REQUESTED'
  | 'PENDING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'RETRYABLE_ERROR'
  | 'CONFLICT'
  | 'UNVERIFIABLE'
  | 'FAILED'
  | 'REVIEW_REQUIRED';

export type Severidad = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';

export interface AlertaInterna {
  id: string;
  identifier: string;
  notice?: 'SIMULACRO';
  sender?: string;
  sent?: string;
  version?: number;
  etag?: string;
  msgType?: 'Alert' | 'Update' | 'Cancel';
  lifecycleState: EstadoCiclo;
  anchorStatus: EstadoAnclaje;
  info?: {
    scenario?: 'INUNDACION' | 'DESLIZAMIENTO' | 'SISMO';
    severity?: Severidad;
    urgency?: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
    certainty?: 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
    headline?: string;
    description?: string;
    event?: string;
    areaDesc?: string;
    expires?: string;
  };
  author?: { id: string; name: string };
  approver?: { id: string; name: string; approvedAt: string } | null;
  frozenPayload?: {
    payloadDigestHex: string;
    bytesCount?: number;
  } | null;
}

/** Acciones disponibles según rol y estado de la alerta. */
export interface AccionesDisponibles {
  puedeEnviarARevision: boolean;
  puedeSolicitarEmision: boolean;
  puedeAprobar: boolean;
  puedeRechazar: boolean;
  /** Todas las acciones están diferidas (backend M2 no implementado). */
  diferidas: true;
}
