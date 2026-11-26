const BASE_API = '/api/v1/public';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export function esUuidPublico(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export interface AlertaPublica {
  id: string;
  identifier: string;
  lifecycleState: 'PUBLISHED';
  anchorStatus: 'CONFIRMED';
  notice: 'SIMULACRO';
}

export interface DetalleAlertaPublica {
  alert: AlertaPublica & {
    sender: string;
    sent: string;
    status: 'Exercise';
    scope: 'Public';
  };
  jwsCompact: string;
  signatureMeta: { alg: 'ES256'; kid: string };
  anchorEvidenceMeta: {
    network: 'testnet';
    contractId: string;
    anchorStatus: 'CONFIRMED';
    messageKeyHex: string;
    jwsHashHex: string;
    txHash: string | null;
    checkedAt: string | null;
    verificationSource: 'backend_metadata';
    note: string;
  };
}

export type FalloPublico = 'no-encontrada' | 'no-disponible' | 'error' | 'respuesta-invalida';

function esObjeto(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function esResumen(value: unknown): value is AlertaPublica {
  return esObjeto(value) &&
    esUuidPublico(value.id) &&
    typeof value.identifier === 'string' && value.identifier.length > 0 &&
    value.lifecycleState === 'PUBLISHED' &&
    value.anchorStatus === 'CONFIRMED' &&
    value.notice === 'SIMULACRO';
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function clasificar(response: Response): FalloPublico {
  if (response.status === 404) return 'no-encontrada';
  if (response.status === 405 || response.status === 501 || response.status === 503) {
    return 'no-disponible';
  }
  return response.status >= 500 ? 'error' : 'respuesta-invalida';
}

function esDetalle(value: unknown): value is DetalleAlertaPublica {
  if (!esObjeto(value) || !esObjeto(value.alert) || !esResumen(value.alert)) return false;
  const alert = value.alert;
  const signature = value.signatureMeta;
  const anchor = value.anchorEvidenceMeta;
  return (
    typeof alert.sender === 'string' &&
    typeof alert.sent === 'string' &&
    alert.status === 'Exercise' &&
    alert.scope === 'Public' &&
    typeof value.jwsCompact === 'string' &&
    value.jwsCompact.split('.').length === 3 &&
    esObjeto(signature) &&
    signature.alg === 'ES256' &&
    typeof signature.kid === 'string' &&
    esObjeto(anchor) &&
    anchor.network === 'testnet' &&
    typeof anchor.contractId === 'string' &&
    anchor.anchorStatus === 'CONFIRMED' &&
    typeof anchor.messageKeyHex === 'string' && HASH.test(anchor.messageKeyHex) &&
    typeof anchor.jwsHashHex === 'string' && HASH.test(anchor.jwsHashHex) &&
    (anchor.txHash === null || typeof anchor.txHash === 'string') &&
    (anchor.checkedAt === null || typeof anchor.checkedAt === 'string') &&
    anchor.verificationSource === 'backend_metadata' &&
    typeof anchor.note === 'string'
  );
}

export async function listarAlertasPublicas(): Promise<
  { ok: true; items: AlertaPublica[]; total: number } | { ok: false; motivo: FalloPublico }
> {
  try {
    const response = await fetch(`${BASE_API}/alerts?page=1&limit=20`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const body = await json(response);
    if (!response.ok) return { ok: false, motivo: clasificar(response) };
    if (!esObjeto(body) || !Array.isArray(body.items) || typeof body.total !== 'number' ||
        !Number.isSafeInteger(body.total) || body.total < 0) {
      return { ok: false, motivo: 'respuesta-invalida' };
    }
    const items: AlertaPublica[] = [];
    for (const item of body.items) {
      if (!esResumen(item)) return { ok: false, motivo: 'respuesta-invalida' };
      items.push(item);
    }
    return { ok: true, items, total: body.total };
  } catch {
    return { ok: false, motivo: 'error' };
  }
}

export async function obtenerAlertaPublica(id: string): Promise<
  { ok: true; detalle: DetalleAlertaPublica } | { ok: false; motivo: FalloPublico }
> {
  if (!esUuidPublico(id)) return { ok: false, motivo: 'respuesta-invalida' };
  try {
    const response = await fetch(`${BASE_API}/alerts/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const body = await json(response);
    if (!response.ok) return { ok: false, motivo: clasificar(response) };
    return esDetalle(body) ? { ok: true, detalle: body } : { ok: false, motivo: 'respuesta-invalida' };
  } catch {
    return { ok: false, motivo: 'error' };
  }
}
