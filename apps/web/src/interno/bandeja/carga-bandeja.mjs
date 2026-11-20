/**
 * @typedef {import('./tipos').AlertaInterna} AlertaInterna
 * @typedef {'demo' | 'real'} ModoCarga
 * @typedef {{ tipo: 'cargando' } | { tipo: 'demo', alertas: readonly AlertaInterna[] } | { tipo: 'real', alertas: readonly AlertaInterna[] } | { tipo: 'error', mensaje: string }} EstadoCarga
 */

const MENSAJE_NO_DISPONIBLE = 'El endpoint de listado de alertas internas no está disponible.';
const MENSAJE_ERROR = 'Error de comunicación al consultar el servicio de alertas internas. No se mostrarán fixtures DEMO.';

/**
 * @param {{
 *   cargarReales: () => Promise<AlertaInterna[] | 'no-disponible' | 'error'>,
 *   modoActual: () => ModoCarga,
 *   publicar: (estado: EstadoCarga) => void,
 * }} opciones
 */
export function crearControladorCargaBandeja({ cargarReales, modoActual, publicar }) {
  let solicitudActual = 0;

  function invalidar() {
    solicitudActual += 1;
  }

  /**
   * @param {ModoCarga} modo
   * @param {readonly AlertaInterna[] | undefined} fixturesDemo
   */
  async function cargar(modo, fixturesDemo) {
    const solicitud = ++solicitudActual;
    if (modoActual() !== modo) return false;

    publicar({ tipo: 'cargando' });

    if (modo === 'demo') {
      if (solicitud === solicitudActual && modoActual() === modo) {
        publicar({ tipo: 'demo', alertas: fixturesDemo ?? [] });
        return true;
      }
      return false;
    }

    /** @type {EstadoCarga} */
    let resultado;
    try {
      const alertas = await cargarReales();
      if (alertas === 'no-disponible') {
        resultado = { tipo: 'error', mensaje: MENSAJE_NO_DISPONIBLE };
      } else if (alertas === 'error') {
        resultado = { tipo: 'error', mensaje: MENSAJE_ERROR };
      } else {
        resultado = { tipo: 'real', alertas };
      }
    } catch {
      resultado = { tipo: 'error', mensaje: MENSAJE_ERROR };
    }

    if (solicitud !== solicitudActual || modoActual() !== modo) return false;
    publicar(resultado);
    return true;
  }

  return { cargar, invalidar };
}
