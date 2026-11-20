// Adaptador de DEMOSTRACIÓN (solo desarrollo): devuelve resultados fijos para las claves a–h.
// No verifica nada: cada resultado sale con origen SIMULADO y sin datos técnicos.
// Cualquier otra entrada se rechaza como lo haría el adaptador de producción.
import { VerificadorNoDisponible } from '../dominio/errores';
import type { ResultadoVerificacion, Verificador } from '../dominio/tipos';
import { CASOS_DEMO, type ClaveCaso } from './datos-demo';
import { resultadoSimulado } from './resultado-simulado.mjs';

const esClave = (valor: string): valor is ClaveCaso => Object.hasOwn(CASOS_DEMO, valor);

export const verificadorDemo: Verificador = {
  async verificar(jws: string): Promise<ResultadoVerificacion> {
    if (!esClave(jws)) throw new VerificadorNoDisponible();
    return resultadoSimulado(CASOS_DEMO[jws].resultado);
  },
};
