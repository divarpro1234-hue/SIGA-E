// Fechas: hora del dispositivo y UTC visible (decisión de D03). Entrada: ISO 8601.
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dos = (n: number) => String(n).padStart(2, '0');

const FORMATO_DISPOSITIVO = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const valida = (d: Date) => !Number.isNaN(d.getTime());

export const FECHA_NO_VALIDA = 'fecha no válida';

/** «10 oct, 19:02 UTC» */
export function fechaUtc(iso: string): string {
  const d = new Date(iso);
  if (!valida(d)) return FECHA_NO_VALIDA;
  return `${dos(d.getUTCDate())} ${MESES[d.getUTCMonth()] ?? ''}, ${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())} UTC`;
}

/** «10 oct, 15:30» en la zona del dispositivo, seguido de su equivalente UTC. */
export function fechaDispositivoConUtc(iso: string): string {
  const d = new Date(iso);
  if (!valida(d)) return FECHA_NO_VALIDA;
  return `${FORMATO_DISPOSITIVO.format(d)} (${fechaUtc(iso)})`;
}
