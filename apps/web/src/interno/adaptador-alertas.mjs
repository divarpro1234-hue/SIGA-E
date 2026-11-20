import { crearTransporte, falloComun } from './http-interno.mjs';

/**
 * @typedef {'INUNDACION' | 'DESLIZAMIENTO' | 'SISMO'} EscenarioCAP
 * @typedef {'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'} SeveridadCAP
 * @typedef {'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown'} UrgenciaCAP
 * @typedef {'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown'} CertezaCAP
 * @typedef {'Alert' | 'Update' | 'Cancel'} TipoMensajeCAP
 *
 * @typedef {{
 *   scenario: EscenarioCAP,
 *   event: string,
 *   severity: SeveridadCAP,
 *   urgency: UrgenciaCAP,
 *   certainty: CertezaCAP,
 *   headline: string,
 *   description: string,
 *   expires: string,
 *   areaDesc: string,
 * }} InfoInput
 *
 * @typedef {{ sender: string, identifier: string, sent: string }} ReferenciaMensaje
 *
 * @typedef {{
 *   kind: TipoMensajeCAP,
 *   info: InfoInput,
 *   references?: readonly ReferenciaMensaje[],
 * }} AlertInput
 *
 * @typedef {import('./bandeja/tipos').AlertaInterna} AlertaInterna
 * @typedef {{
 *   id: string,
 *   identifier: string,
 *   lifecycleState: AlertaInterna['lifecycleState'],
 *   anchorStatus: AlertaInterna['anchorStatus'],
 *   notice: 'SIMULACRO',
 * }} AlertSummary
 *
 * @typedef {AlertSummary & {
 *   version: number,
 *   kind: TipoMensajeCAP,
 *   info: InfoInput,
 *   lastRejectionReason?: string,
 * }} AlertAuthorDetail
 *
 * @typedef {{
 *   payloadBase64Url: string,
 *   payloadDigestHex: string,
 * }} ReviewSnapshot
 *
 * @typedef {AlertSummary & {
 *   authorId: string,
 *   kind: TipoMensajeCAP,
 *   severity: SeveridadCAP,
 *   version: number,
 *   reviewSnapshot: ReviewSnapshot,
 *   etag: string,
 * }} AlertApproverDetail
 *
 * @typedef {{ ok: true, alerta: AlertSummary, etag: string, version: number }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'invalido' | 'conflicto' | 'no-disponible' | 'error-servidor' | 'error-red' | 'limitado', codigo?: string | null }} ResultadoCrearAlerta
 *
 * @typedef {{ ok: true, alerta: AlertSummary, etag: string, version: number }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'invalido' | 'conflicto' | 'no-encontrada' | 'no-disponible' | 'error-servidor' | 'error-red' | 'limitado' }} ResultadoEditarBorrador

 * @typedef {{ ok: true, alertas: AlertaInterna[], page: number, total: number }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoListarAlertas
 *
 * @typedef {{ ok: true, alerta: AlertaInterna, etag: string }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoObtenerAlerta
 *
 * @typedef {{ ok: true, lifecycleState: AlertaInterna['lifecycleState'], payloadDigestHex: string, etag: string, version: number }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'conflicto' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoEnviarRevision
 *
 * @typedef {{ ok: true, alerta: AlertApproverDetail, etag: string }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoObtenerRevision
 *
 * @typedef {{ ok: true, alerta: AlertSummary, etag: string, version: number }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'conflicto' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoDecisionRevision
 *
 * @typedef {{ ok: true, eventos: Array<{ seq: string, occurredAt: string, actorId: string | null, action: string, redactedDetails: unknown }> }
 *   | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'conflicto' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoConsultarAuditoria
 *
 * @typedef {{ ok: true, evidencia: {
 *   anchorStatus: AlertaInterna['anchorStatus'],
 *   network: 'TESTNET' | null,
 *   contractId: string | null,
 *   txHash: string | null,
 *   confirmedLedger: string | null,
 *   digestVerification: 'MATCHED' | 'NOT_CHECKED',
 *   checkedAt: string | null,
 *   unavailableReason: 'M5_DISABLED' | null,
 * } } | { ok: false, motivo: 'sin-sesion' | 'prohibido' | 'no-encontrada' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red' }} ResultadoConsultarAnclaje
 */

const ESTADOS_CICLO = new Set([
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'READY_TO_SIGN',
  'SIGNING',
  'SIGNED_PENDING_ANCHOR',
  'PUBLISHED',
]);
const ESTADOS_ANCLAJE = new Set([
  'NOT_REQUESTED',
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'RETRYABLE_ERROR',
  'CONFLICT',
  'UNVERIFIABLE',
  'FAILED',
  'REVIEW_REQUIRED',
]);
const ESCENARIOS = new Set(['INUNDACION', 'DESLIZAMIENTO', 'SISMO']);
const SEVERIDADES = new Set(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']);
const URGENCIAS = new Set(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']);
const CERTEZAS = new Set(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']);
const FORMATO_ETAG = /^"v([1-9][0-9]*)"$/;
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATO_DIGEST = /^[a-f0-9]{64}$/;
const FORMATO_BASE64URL = /^[A-Za-z0-9_-]+$/;

/** @param {unknown} valor @returns {valor is TipoMensajeCAP} */
function esTipoMensaje(valor) {
  return valor === 'Alert' || valor === 'Update' || valor === 'Cancel';
}

/** @param {unknown} valor @returns {valor is Record<string, unknown>} */
function esObjeto(valor) {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** @param {string | null} etag */
function leerVersionEtag(etag) {
  if (typeof etag !== 'string') return null;
  const coincidencia = FORMATO_ETAG.exec(etag);
  if (!coincidencia) return null;
  const version = Number(coincidencia[1]);
  return Number.isSafeInteger(version) ? version : null;
}

/** @param {unknown} valor @returns {valor is AlertSummary & Record<string, unknown>} */
function esResumenAlerta(valor) {
  return (
    esObjeto(valor) &&
    typeof valor.id === 'string' &&
    FORMATO_UUID.test(valor.id) &&
    typeof valor.identifier === 'string' &&
    valor.identifier.length > 0 &&
    typeof valor.lifecycleState === 'string' &&
    ESTADOS_CICLO.has(valor.lifecycleState) &&
    typeof valor.anchorStatus === 'string' &&
    ESTADOS_ANCLAJE.has(valor.anchorStatus) &&
    valor.notice === 'SIMULACRO'
  );
}

/** @param {unknown} valor @returns {AlertSummary | null} */
function mapearResumenAlerta(valor) {
  if (!esResumenAlerta(valor)) return null;
  return {
    id: valor.id,
    identifier: valor.identifier,
    lifecycleState: valor.lifecycleState,
    anchorStatus: valor.anchorStatus,
    notice: /** @type {'SIMULACRO'} */ ('SIMULACRO'),
  };
}

/** @param {unknown} valor @returns {valor is InfoInput & Record<string, unknown>} */
function esInfoInput(valor) {
  return (
    esObjeto(valor) &&
    typeof valor.scenario === 'string' &&
    ESCENARIOS.has(valor.scenario) &&
    typeof valor.event === 'string' &&
    typeof valor.severity === 'string' &&
    SEVERIDADES.has(valor.severity) &&
    typeof valor.urgency === 'string' &&
    URGENCIAS.has(valor.urgency) &&
    typeof valor.certainty === 'string' &&
    CERTEZAS.has(valor.certainty) &&
    typeof valor.headline === 'string' &&
    typeof valor.description === 'string' &&
    typeof valor.expires === 'string' &&
    typeof valor.areaDesc === 'string'
  );
}

/** @param {unknown} valor @param {string | null} etag */
function mapearDetalleAutor(valor, etag) {
  if (!esObjeto(valor)) return null;
  const resumen = mapearResumenAlerta(valor);
  const version = valor.version;
  const kind = valor.kind;
  const info = valor.info;
  if (
    !resumen ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !esTipoMensaje(kind) ||
    !esInfoInput(info) ||
    typeof etag !== 'string' ||
    leerVersionEtag(etag) !== version
  ) {
    return null;
  }

  return {
    ...resumen,
    version,
    msgType: kind,
    info: {
      scenario: info.scenario,
      event: info.event,
      severity: info.severity,
      urgency: info.urgency,
      certainty: info.certainty,
      headline: info.headline,
      description: info.description,
      expires: info.expires,
      areaDesc: info.areaDesc,
    },
    etag,
  };
}

/**
 * @param {unknown} valor
 * @param {string | null} etag
 * @returns {AlertApproverDetail | null}
 */
function mapearDetalleAprobador(valor, etag) {
  if (!esObjeto(valor)) return null;
  const resumen = mapearResumenAlerta(valor);
  const version = valor.version;
  const kind = valor.kind;
  const severity = valor.severity;
  const authorId = valor.authorId;
  const snapshot = valor.reviewSnapshot;
  if (
    !resumen ||
    resumen.lifecycleState !== 'PENDING_APPROVAL' ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !esTipoMensaje(kind) ||
    typeof severity !== 'string' ||
    !SEVERIDADES.has(severity) ||
    (severity !== 'Severe' && severity !== 'Extreme') ||
    typeof authorId !== 'string' ||
    !FORMATO_UUID.test(authorId) ||
    !esObjeto(snapshot) ||
    Object.keys(snapshot).length !== 2 ||
    typeof snapshot.payloadBase64Url !== 'string' ||
    !FORMATO_BASE64URL.test(snapshot.payloadBase64Url) ||
    snapshot.payloadBase64Url.length % 4 === 1 ||
    typeof snapshot.payloadDigestHex !== 'string' ||
    !FORMATO_DIGEST.test(snapshot.payloadDigestHex) ||
    typeof etag !== 'string' ||
    leerVersionEtag(etag) !== version
  ) {
    return null;
  }

  return {
    ...resumen,
    authorId,
    kind,
    severity: /** @type {SeveridadCAP} */ (severity),
    version,
    reviewSnapshot: {
      payloadBase64Url: snapshot.payloadBase64Url,
      payloadDigestHex: snapshot.payloadDigestHex,
    },
    etag,
  };
}

/**
 * @param {import('./http-interno.mjs').ResultadoLlamada} res
 * @returns {'sin-sesion' | 'prohibido' | 'no-encontrada' | 'conflicto' | 'invalido' | 'no-disponible' | 'error-servidor' | 'error-red'}
 */
function motivoComun(res) {
  if ('tipo' in res) {
    if (res.tipo === 'no-disponible') return 'no-disponible';
    if (res.tipo === 'error-red') return 'error-red';
    if (res.tipo === 'limitado') return 'no-disponible';
    return 'error-servidor';
  }
  const { r, cuerpo } = res;
  if (r.status === 401) return 'sin-sesion';
  if (r.status === 403) return 'prohibido';
  if (r.status === 404) return 'no-encontrada';
  if (r.status === 409) return 'conflicto';
  if (r.status === 422) return 'invalido';
  const fallo = falloComun(r, cuerpo);
  if (fallo?.tipo === 'no-disponible') return 'no-disponible';
  if (fallo?.tipo === 'error-red') return 'error-red';
  if (fallo?.tipo === 'error-servidor') return 'error-servidor';
  if (fallo?.tipo === 'prohibido') return 'prohibido';
  if (fallo?.tipo === 'invalido') return 'invalido';
  return 'error-servidor';
}

/**
 * @param {import('./http-interno.mjs').Fetch} [fetchImpl]
 */
export function crearClienteAlertas(fetchImpl) {
  const transporte = crearTransporte(fetchImpl);

  return {
    /**
     * @param {AlertInput} input
     * @param {string} csrf
     * @returns {Promise<ResultadoCrearAlerta>}
     */
    async crearBorrador(input, csrf) {
      if (typeof csrf !== 'string' || csrf.trim() === '') {
        return { ok: false, motivo: 'prohibido', codigo: 'CSRF_AUSENTE' };
      }

      const res = await transporte('POST', '/alerts', { cuerpo: input, csrf });
      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'no-encontrada' || motivo === 'conflicto' ? 'error-servidor' : motivo };
      }

      const { r, cuerpo } = res;
      if (r.status === 201) {
        const alerta = mapearResumenAlerta(cuerpo);
        const etag = r.headers.get('etag');
        const version = leerVersionEtag(etag);
        if (alerta && etag && version === 1) {
          return { ok: true, alerta, etag, version };
        }
        return { ok: false, motivo: 'error-servidor' };
      }

      const motivo = motivoComun(res);
      if (motivo === 'no-encontrada') return { ok: false, motivo: 'no-disponible' };
      if (motivo === 'prohibido') {
        const fallo = falloComun(r, cuerpo);
        const codigo = fallo?.tipo === 'prohibido' ? fallo.codigo : null;
        return { ok: false, motivo, ...(codigo ? { codigo } : {}) };
      }
      return { ok: false, motivo };
    },

    /**
     * Edita un borrador existente con control de version.
     * @param {string} id
     * @param {AlertInput} input
     * @param {number} expectedVersion
     * @param {string} etag
     * @param {string} csrf
     * @returns {Promise<ResultadoEditarBorrador>}
     */
    async editarBorrador(id, input, expectedVersion, etag, csrf) {
      if (typeof csrf !== 'string' || csrf.trim() === '') {
        return { ok: false, motivo: 'prohibido' };
      }

      if (
        typeof id !== 'string' ||
        id.trim() === '' ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        leerVersionEtag(etag) !== expectedVersion
      ) {
        return { ok: false, motivo: 'conflicto' };
      }

      const res = await transporte(
        'PATCH',
        `/alerts/${encodeURIComponent(id.trim())}`,
        {
          cuerpo: input,
          csrf,
          ifMatch: etag,
        }
      );

      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return {
          ok: false,
          motivo:
            motivo === 'no-encontrada' || motivo === 'conflicto'
              ? 'error-servidor'
              : motivo,
        };
      }

      const { r, cuerpo } = res;

      if (r.status === 200) {
        const alerta = mapearResumenAlerta(cuerpo);
        const nuevoEtag = r.headers.get('etag');
        const nuevaVersion = leerVersionEtag(nuevoEtag);

        if (
          alerta &&
          nuevoEtag &&
          nuevaVersion === expectedVersion + 1
        ) {
          return {
            ok: true,
            alerta,
            etag: nuevoEtag,
            version: nuevaVersion,
          };
        }

        return { ok: false, motivo: 'error-servidor' };
      }

      return { ok: false, motivo: motivoComun(res) };
    },

    /**
     * @param {{ page?: number, limit?: number }} [opciones]
     * @returns {Promise<ResultadoListarAlertas>}
     */
    async listarAlertas({ page = 1, limit = 20 } = {}) {
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        return { ok: false, motivo: 'invalido' };
      }

      const res = await transporte('GET', `/alerts?page=${page}&limit=${limit}`);
      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'no-encontrada' || motivo === 'conflicto' ? 'error-servidor' : motivo };
      }

      const { r, cuerpo } = res;
      if (r.status === 200) {
        if (!esObjeto(cuerpo) || !Array.isArray(cuerpo.items)) {
          return { ok: false, motivo: 'error-servidor' };
        }
        const alertas = [];
        for (const item of cuerpo.items) {
          const alerta = mapearResumenAlerta(item);
          if (!alerta) return { ok: false, motivo: 'error-servidor' };
          alertas.push(alerta);
        }
        if (
          typeof cuerpo.page !== 'number' ||
          cuerpo.page !== page ||
          typeof cuerpo.total !== 'number' ||
          !Number.isSafeInteger(cuerpo.total) ||
          cuerpo.total < 0
        ) {
          return { ok: false, motivo: 'error-servidor' };
        }
        return { ok: true, alertas, page: cuerpo.page, total: cuerpo.total };
      }

      const motivo = motivoComun(res);
      return { ok: false, motivo: motivo === 'no-encontrada' || motivo === 'conflicto' ? 'error-servidor' : motivo };
    },

    /**
     * @param {string} id
     * @returns {Promise<ResultadoObtenerAlerta>}
     */
    async obtenerAlerta(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, motivo: 'no-encontrada' };
      }
      const res = await transporte('GET', `/alerts/${encodeURIComponent(id.trim())}`);
      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
      }

      const { r, cuerpo } = res;
      if (r.status === 200) {
        const etag = r.headers.get('etag');
        const alerta = mapearDetalleAutor(cuerpo, etag);
        if (alerta && etag) return { ok: true, alerta, etag };
        return { ok: false, motivo: 'error-servidor' };
      }

      const motivo = motivoComun(res);
      return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
    },

    /**
     * Detalle de revisión autorizado. No transforma ni reserializa los bytes congelados.
     * @param {string} id
     * @returns {Promise<ResultadoObtenerRevision>}
     */
    async obtenerDetalleRevision(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, motivo: 'no-encontrada' };
      }
      const res = await transporte('GET', `/alerts/${encodeURIComponent(id.trim())}`);
      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
      }

      const { r, cuerpo } = res;
      if (r.status === 200) {
        const etag = r.headers.get('etag');
        const alerta = mapearDetalleAprobador(cuerpo, etag);
        if (alerta && etag) return { ok: true, alerta, etag };
        return { ok: false, motivo: 'error-servidor' };
      }

      const motivo = motivoComun(res);
      return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
    },

    /**
     * @param {string} id
     * @param {number} expectedVersion
     * @param {string} etag
     * @param {string} expectedDigestHex
     * @param {string} csrf
     * @returns {Promise<ResultadoDecisionRevision>}
     */
    async aprobarAlerta(id, expectedVersion, etag, expectedDigestHex, csrf) {
      return decidirRevision('approve', id, expectedVersion, etag, expectedDigestHex, csrf, transporte);
    },

    /**
     * @param {string} id
     * @param {number} expectedVersion
     * @param {string} etag
     * @param {string} expectedDigestHex
     * @param {string} reason
     * @param {string} csrf
     * @returns {Promise<ResultadoDecisionRevision>}
     */
    async rechazarAlerta(id, expectedVersion, etag, expectedDigestHex, reason, csrf) {
      if (
        typeof reason !== 'string' ||
        Array.from(reason.trim()).length < 3 ||
        Array.from(reason).length > 500 ||
        /[\r\n\u2028\u2029]/u.test(reason)
      ) {
        return { ok: false, motivo: 'invalido' };
      }
      return decidirRevision('reject', id, expectedVersion, etag, expectedDigestHex, csrf, transporte, { reason });
    },

    /**
     * @param {string} id
     * @param {number} expectedVersion
     * @param {string} etag
     * @param {string} csrf
     * @returns {Promise<ResultadoEnviarRevision>}
     */
    async enviarARevision(id, expectedVersion, etag, csrf) {
      if (typeof csrf !== 'string' || csrf.trim() === '') {
        return { ok: false, motivo: 'prohibido' };
      }
      if (
        typeof id !== 'string' ||
        id.trim() === '' ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        leerVersionEtag(etag) !== expectedVersion
      ) {
        return { ok: false, motivo: 'conflicto' };
      }

      const res = await transporte('POST', `/alerts/${encodeURIComponent(id.trim())}/submit`, {
        cuerpo: { expectedVersion },
        csrf,
      });
      if ('tipo' in res) return { ok: false, motivo: motivoComun(res) };

      const { r, cuerpo } = res;
      if (r.status === 200) {
        const version = leerVersionEtag(r.headers.get('etag'));
        if (
          esObjeto(cuerpo) &&
          (cuerpo.lifecycleState === 'PENDING_APPROVAL' || cuerpo.lifecycleState === 'READY_TO_SIGN') &&
          typeof cuerpo.payloadDigestHex === 'string' &&
          FORMATO_DIGEST.test(cuerpo.payloadDigestHex) &&
          version === expectedVersion + 1
        ) {
          return {
            ok: true,
            lifecycleState: cuerpo.lifecycleState,
            payloadDigestHex: cuerpo.payloadDigestHex,
            etag: /** @type {string} */ (r.headers.get('etag')),
            version,
          };
        }
        return { ok: false, motivo: 'error-servidor' };
      }

      return { ok: false, motivo: motivoComun(res) };
    },

    /**
     * @param {string} id
     * @returns {Promise<ResultadoConsultarAuditoria>}
     */
    async consultarAuditoria(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, motivo: 'no-encontrada' };
      }
      const res = await transporte('GET', `/alerts/${encodeURIComponent(id.trim())}/audit`);
      if ('tipo' in res) return { ok: false, motivo: motivoComun(res) };
      const { r, cuerpo } = res;
      if (r.status !== 200) return { ok: false, motivo: motivoComun(res) };
      if (!esObjeto(cuerpo) || !Array.isArray(cuerpo.items)) {
        return { ok: false, motivo: 'error-servidor' };
      }
      const eventos = [];
      for (const item of cuerpo.items) {
        if (!esObjeto(item) ||
            typeof item.seq !== 'string' ||
            typeof item.occurredAt !== 'string' ||
            typeof item.action !== 'string') {
          return { ok: false, motivo: 'error-servidor' };
        }
        eventos.push({
          seq: item.seq,
          occurredAt: item.occurredAt,
          actorId: typeof item.actorId === 'string' ? item.actorId : null,
          action: item.action,
          redactedDetails: item.redactedDetails,
        });
      }
      return { ok: true, eventos };
    },

    /**
     * Evidencia de anclaje almacenada por el backend. Lectura sola; no activa Stellar.
     * @param {string} id
     * @returns {Promise<ResultadoConsultarAnclaje>}
     */
    async consultarAnclaje(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, motivo: 'no-encontrada' };
      }
      const res = await transporte('GET', `/alerts/${encodeURIComponent(id.trim())}/anchor`);
      if ('tipo' in res) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
      }
      const { r, cuerpo } = res;
      if (r.status !== 200) {
        const motivo = motivoComun(res);
        return { ok: false, motivo: motivo === 'conflicto' ? 'error-servidor' : motivo };
      }
      if (
        !esObjeto(cuerpo) ||
        typeof cuerpo.anchorStatus !== 'string' ||
        !ESTADOS_ANCLAJE.has(cuerpo.anchorStatus) ||
        (cuerpo.network !== null && cuerpo.network !== 'TESTNET') ||
        (cuerpo.contractId !== null && typeof cuerpo.contractId !== 'string') ||
        (cuerpo.txHash !== null && typeof cuerpo.txHash !== 'string') ||
        (cuerpo.confirmedLedger !== null && typeof cuerpo.confirmedLedger !== 'string') ||
        (cuerpo.digestVerification !== 'MATCHED' && cuerpo.digestVerification !== 'NOT_CHECKED') ||
        (cuerpo.checkedAt !== null && typeof cuerpo.checkedAt !== 'string') ||
        (cuerpo.unavailableReason !== null && cuerpo.unavailableReason !== 'M5_DISABLED')
      ) {
        return { ok: false, motivo: 'error-servidor' };
      }
      return {
        ok: true,
        evidencia: {
          anchorStatus: /** @type {AlertaInterna['anchorStatus']} */ (cuerpo.anchorStatus),
          network: /** @type {'TESTNET' | null} */ (cuerpo.network),
          contractId: cuerpo.contractId,
          txHash: cuerpo.txHash,
          confirmedLedger: cuerpo.confirmedLedger,
          digestVerification: cuerpo.digestVerification,
          checkedAt: cuerpo.checkedAt,
          unavailableReason: cuerpo.unavailableReason,
        },
      };
    },
  };
}

/**
 * @param {'approve' | 'reject'} decision
 * @param {string} id
 * @param {number} expectedVersion
 * @param {string} etag
 * @param {string} expectedDigestHex
 * @param {string} csrf
 * @param {ReturnType<typeof crearTransporte>} transporte
 * @param {{ reason: string }} [extra]
 * @returns {Promise<ResultadoDecisionRevision>}
 */
async function decidirRevision(decision, id, expectedVersion, etag, expectedDigestHex, csrf, transporte, extra) {
  if (typeof csrf !== 'string' || csrf.trim() === '') {
    return { ok: false, motivo: 'prohibido' };
  }
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    leerVersionEtag(etag) !== expectedVersion ||
    typeof expectedDigestHex !== 'string' ||
    !FORMATO_DIGEST.test(expectedDigestHex)
  ) {
    return { ok: false, motivo: 'conflicto' };
  }

  const cuerpo = {
    ...(extra ?? {}),
    expectedDigestHex,
    expectedVersion,
  };
  const res = await transporte('POST', `/alerts/${encodeURIComponent(id.trim())}/${decision}`, { cuerpo, csrf });
  if ('tipo' in res) return { ok: false, motivo: motivoComun(res) };

  const { r, cuerpo: respuesta } = res;
  if (r.status === 200) {
    const version = leerVersionEtag(r.headers.get('etag'));
    const estadoEsperado = decision === 'approve' ? 'READY_TO_SIGN' : 'REJECTED';
    const alerta = mapearResumenAlerta(respuesta);
    if (
      alerta &&
      alerta.lifecycleState === estadoEsperado &&
      alerta.id === id.trim() &&
      version === expectedVersion + 1
    ) {
      return { ok: true, alerta, etag: /** @type {string} */ (r.headers.get('etag')), version };
    }
    return { ok: false, motivo: 'error-servidor' };
  }

  return { ok: false, motivo: motivoComun(res) };
}

export const clienteAlertas = crearClienteAlertas();
