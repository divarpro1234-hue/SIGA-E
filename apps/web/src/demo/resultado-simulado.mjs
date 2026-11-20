// Construye el resultado de un caso de DEMOSTRACIÓN. Marca el origen SIMULADO de forma explícita y
// deja el panel técnico vacío: no hubo clave, ni huella, ni catálogo. Lo que traiga el caso en esos
// campos se descarta, para que ningún dato fijo pueda hacerse pasar por una verificación real.

/**
 * @typedef {import('../dominio/tipos').ResultadoVerificacion} ResultadoVerificacion
 * @typedef {import('./datos-demo').ResultadoFijoDemo} ResultadoFijoDemo
 */

/**
 * @param {ResultadoFijoDemo} caso
 * @returns {ResultadoVerificacion}
 */
export function resultadoSimulado(caso) {
  return {
    ...structuredClone(caso),
    origen: 'SIMULADO',
    panel: { kid: null, hashJws: null, catalogo: null },
  };
}
