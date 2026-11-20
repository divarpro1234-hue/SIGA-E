// Verificación local: llama a @siga-e/verify y traduce su resultado a los tipos de la interfaz.
// Nada de lo que devuelve el servidor decide el veredicto; aquí no hay red.
import { verificarJws } from '@siga-e/verify';

/**
 * @typedef {import('../dominio/tipos').ResultadoVerificacion} ResultadoVerificacion
 * @typedef {import('../dominio/tipos').ContenidoAlerta} ContenidoAlerta
 * @typedef {import('@siga-e/verify').CatalogoConfianza} CatalogoConfianza
 */

const FIRMAS = new Set(['VALIDA', 'INVALIDA', 'CLAVE_DESCONOCIDA', 'CLAVE_REVOCADA', 'FUERA_DE_POLITICA']);
const VIGENCIAS = new Set(['VIGENTE', 'VENCIDA', 'DESCONOCIDA']);
const SEVERIDADES = new Set(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']);
const TIPOS = new Set(['Alert', 'Update', 'Cancel']);
// El kid del encabezado lo escribe un tercero: solo se muestra si tiene forma de identificador.
const KID_SEGURO = /^[A-Za-z0-9._:-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

/** @param {unknown} v */
const texto = (v) => (typeof v === 'string' ? v : null);

/**
 * Referencias declaradas por el mensaje, copiadas tal cual. No se comprueba que el aviso referido
 * exista ni cuál es su estado: eso exige historial firmado (ENM-002 §5).
 * @param {unknown} valor
 * @returns {ContenidoAlerta['referencias'] | null}
 */
function referenciasDe(valor) {
  if (valor === undefined) return [];
  if (!Array.isArray(valor)) return null;
  /** @type {ContenidoAlerta['referencias'][number][]} */
  const salida = [];
  for (const r of valor) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
    const { sender, identifier, sent } = /** @type {Record<string, unknown>} */ (r);
    if (typeof sender !== 'string' || typeof identifier !== 'string' || typeof sent !== 'string') return null;
    salida.push({ sender, identifier, sent });
  }
  return salida;
}

/**
 * Extrae los campos mostrables de un payload ya validado por la política de @siga-e/verify.
 * Defensa adicional: si la forma no es la esperada, devuelve null.
 * @param {unknown} payload
 * @returns {ContenidoAlerta | null}
 */
export function contenidoDe(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const info = /** @type {Record<string, unknown> | null} */ (typeof p.info === 'object' ? p.info : null);
  if (!info) return null;
  const tipo = texto(p.msgType);
  if (tipo === null || !TIPOS.has(tipo)) return null;
  const referencias = referenciasDe(p.references);
  // Un Update o Cancel sin referencias no dice a qué aviso afecta: no hay forma segura de mostrarlo.
  if (referencias === null || (tipo !== 'Alert' && referencias.length === 0)) return null;
  const titular = texto(info.headline);
  const descripcion = texto(info.description);
  const area = texto(info.areaDesc);
  const evento = texto(info.event);
  const enviado = texto(p.sent);
  const vence = texto(info.expires);
  const severidad = texto(info.severity);
  if (
    titular === null || descripcion === null || area === null || evento === null ||
    enviado === null || vence === null || severidad === null ||
    !SEVERIDADES.has(severidad)
  ) {
    return null;
  }
  return {
    tipo: /** @type {ContenidoAlerta['tipo']} */ (tipo),
    referencias,
    titular,
    descripcion,
    area,
    evento,
    severidad: /** @type {ContenidoAlerta['severidad']} */ (severidad),
    enviado,
    vence,
  };
}

/**
 * @param {string} jws Cadena exacta aceptada por validarFormaJws; no se recorta ni se reconstruye.
 * @param {CatalogoConfianza} catalogo
 * @param {Date} ahora
 * @param {{ huella: string, sinConexion: boolean }} contexto
 * @returns {Promise<ResultadoVerificacion>}
 */
export async function verificarLocal(jws, catalogo, ahora, contexto) {
  const r = await verificarJws(jws, catalogo, ahora);
  if (!FIRMAS.has(r.firma) || !VIGENCIAS.has(r.vigencia)) throw new Error('Resultado de verificación no reconocido');
  const valida = r.firma === 'VALIDA';
  const contenido = valida ? contenidoDe(r.payload) : null;
  if (valida && contenido === null) throw new Error('Contenido firmado con forma inesperada');
  return {
    origen: 'VERIFICACION_LOCAL',
    firma: /** @type {ResultadoVerificacion['firma']} */ (r.firma),
    vigencia: valida ? /** @type {ResultadoVerificacion['vigencia']} */ (r.vigencia) : 'DESCONOCIDA',
    // La PWA no consulta Soroban: nunca hay lectura confiable del registro.
    cadena: 'NO_COMPROBABLE',
    contenido,
    panel: {
      kid: r.kid !== null && KID_SEGURO.test(r.kid) ? r.kid : null,
      hashJws: r.jwsHash !== null && HASH.test(r.jwsHash) ? r.jwsHash : null,
      catalogo: { etiqueta: 'DEMOSTRACIÓN (fixtures públicos de prueba)', huella: contexto.huella },
    },
    sinConexion: contexto.sinConexion,
    ultimaSync: null,
  };
}
