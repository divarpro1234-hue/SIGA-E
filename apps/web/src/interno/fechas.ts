// Horas del portal interno en la zona del dispositivo (24 h). Solo presentación.
const FORMATO_HORA = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function horaLocal(instante: number): string {
  return FORMATO_HORA.format(new Date(instante));
}
