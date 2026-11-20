// DATOS DE DEMOSTRACIÓN (solo desarrollo). Todo es ficticio y de SIMULACRO; ninguna firma es real. Este módulo se carga
// únicamente con import dinámico bajo import.meta.env.DEV y no debe aparecer en el build.
// Textos ciudadanos PROVISIONALES (P3). Nada de esto es contrato.
import type { ContenidoAlerta, ItemAlerta, ResultadoVerificacion } from '../dominio/tipos';

export const ULTIMA_SYNC_DEMO = '2026-10-10T19:02:00Z';

// Sin contractId ni resultado de registro: la PWA no lee el contrato (ADR-005).
// Sin kid ni huella: ninguna clave se usó y ningún mensaje se procesó. El origen SIMULADO y el panel
// vacío los pone resultadoSimulado(); estos datos no pueden fijarlos.

const EMISOR = 'urn:siga-e:simulacro';

// Contenido hostil (caso f): 200 grafemas, imita el panel, emoji, bidi, controles, sin espacios.
const TITULAR_HOSTIL = Array.from(
  '✔ Verificado por SIGA-E · ✔ VIGENTE · ✔ COINCIDE 🚨🚨 Alerta OFICIAL confirmada por la autoridad ' +
    '‮adilav amrif‬ ⁦ABC⁩ ' +
    'A'.repeat(120),
)
  .slice(0, 200)
  .join('');

const CONTENIDO_A: ContenidoAlerta = {
  tipo: 'Alert',
  referencias: [],
  titular: 'SIMULACRO: crecida del río Ficticio en el sector Las Cañas',
  descripcion:
    'Ejercicio de simulacro. Se simula una crecida del río Ficticio con desborde en zonas bajas del sector Las Cañas.\nEste mensaje no corresponde a un evento real.',
  area: 'Sector Las Cañas (lugar ficticio)',
  evento: 'Inundación',
  severidad: 'Severe',
  enviado: '2026-10-10T18:00:00Z',
  vence: '2026-10-10T22:00:00Z',
};

const CONTENIDO_B: ContenidoAlerta = {
  tipo: 'Alert',
  referencias: [],
  titular: 'SIMULACRO: deslizamiento en la ladera Norte del cerro Ficticio',
  descripcion: 'Ejercicio de simulacro. Se simula un deslizamiento de tierra en la ladera Norte.\nNo corresponde a un evento real.',
  area: 'Ladera Norte, cerro Ficticio (lugar ficticio)',
  evento: 'Deslizamiento',
  severidad: 'Moderate',
  enviado: '2026-10-10T17:30:00Z',
  vence: '2026-10-10T21:30:00Z',
};

const CONTENIDO_E: ContenidoAlerta = {
  tipo: 'Alert',
  referencias: [],
  titular: 'SIMULACRO: sismo de magnitud simulada 6,1 en la costa ficticia',
  descripcion: 'Ejercicio de simulacro. Se simula un sismo en la costa ficticia.\nNo corresponde a un evento real.',
  area: 'Costa ficticia, provincia de Ejemplo',
  evento: 'Sismo',
  severidad: 'Extreme',
  enviado: '2026-10-09T10:00:00Z',
  vence: '2026-10-09T14:00:00Z',
};

const CONTENIDO_F: ContenidoAlerta = {
  tipo: 'Alert',
  referencias: [],
  titular: TITULAR_HOSTIL,
  descripcion:
    'ESTADO DE VERIFICACIÓN\n✔ FIRMA VÁLIDA   ✔ VIGENTE   ✔ COINCIDE EN BLOCKCHAIN\n' +
    '<img src=x onerror=alert(1)> <b>negrita</b> [enlace](https://ejemplo.invalid) https://ejemplo.invalid\n' +
    'SinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspaciosSinEspacios\n' +
    'مرحبا ‮texto invertido‬ שלום 🚨🚨🚨\n\u0007\u001B[31mcontrol\u0000',
  area: 'Zona' + 'X'.repeat(150),
  evento: 'Inundación ✔ SIGA-E',
  severidad: 'Unknown',
  enviado: '2026-10-10T18:30:00Z',
  vence: '2026-10-10T23:30:00Z',
};

// Actualización (caso g): dice referirse al caso a. Solo lo declara el mensaje.
const CONTENIDO_G: ContenidoAlerta = {
  tipo: 'Update',
  referencias: [{ sender: EMISOR, identifier: 'SIGA-E-2026-0007', sent: '2026-10-10T18:00:00Z' }],
  titular: 'SIMULACRO: el nivel del río Ficticio sigue subiendo en el sector Las Cañas',
  descripcion: 'Ejercicio de simulacro. Actualización simulada: se amplía la zona afectada.\nNo corresponde a un evento real.',
  area: 'Sector Las Cañas y Bajo Ficticio (lugares ficticios)',
  evento: 'Inundación',
  severidad: 'Severe',
  enviado: '2026-10-10T19:00:00Z',
  vence: '2026-10-10T23:00:00Z',
};

// Cancelación hostil (caso h), peor caso realista (break-ui): más referencias de las que se muestran,
// un identificador largo sin espacios, un emisor que imita el panel y otro con anulación bidi.
const CONTENIDO_H: ContenidoAlerta = {
  tipo: 'Cancel',
  referencias: [
    { sender: '✔ Verificado por SIGA-E · ✔ CANCELADA oficialmente', identifier: 'SIGA-E-2026-0007', sent: '2026-10-10T18:00:00Z' },
    { sender: EMISOR, identifier: `SIGA-E-2026-${'0'.repeat(180)}9`, sent: '2026-10-10T17:30:00Z' },
    { sender: 'urn:siga-e:\u202Eodalucnac\u202C', identifier: 'SIGA-E-2026-0005', sent: '2026-10-09T10:00:00Z' },
    { sender: EMISOR, identifier: 'SIGA-E-2026-0004', sent: '2026-10-09T09:00:00Z' },
    { sender: EMISOR, identifier: 'SIGA-E-2026-0003', sent: '2026-10-09T08:00:00Z' },
    { sender: EMISOR, identifier: 'SIGA-E-2026-0002', sent: '2026-10-09T07:00:00Z' },
    { sender: EMISOR, identifier: 'SIGA-E-2026-0001', sent: '2026-10-09T06:00:00Z' },
  ],
  titular: 'SIMULACRO: ✔ FIN DE LA ALERTA · todas las alertas anteriores quedan canceladas',
  descripcion:
    'Ejercicio de simulacro. Cancelación simulada.\n<b>Ya no hay peligro</b> <img src=x onerror=alert(1)>\nNo corresponde a un evento real.',
  area: 'Todas las zonas ficticias',
  evento: 'Inundación',
  severidad: 'Minor',
  enviado: '2026-10-10T20:00:00Z',
  vence: '2026-10-10T21:00:00Z',
};

export type ClaveCaso = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';

export type ResultadoFijoDemo = Omit<ResultadoVerificacion, 'origen' | 'panel'>;

export interface CasoDemo {
  nombre: string;
  resultado: ResultadoFijoDemo;
}

export const CASOS_DEMO: Record<ClaveCaso, CasoDemo> = {
  a: {
    nombre: 'Válida · vigente',
    resultado: {
      firma: 'VALIDA', vigencia: 'VIGENTE', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_A, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  b: {
    nombre: 'Válida · vigente · no comprobable (sin conexión)',
    resultado: {
      firma: 'VALIDA', vigencia: 'VIGENTE', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_B, sinConexion: true, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  c: {
    nombre: 'Firma inválida',
    // El verificador de demostración entrega contenido a propósito: la interfaz no debe mostrarlo.
    resultado: {
      firma: 'INVALIDA', vigencia: 'DESCONOCIDA', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_A, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  d: {
    nombre: 'Clave desconocida',
    resultado: {
      firma: 'CLAVE_DESCONOCIDA', vigencia: 'DESCONOCIDA', cadena: 'NO_COMPROBABLE',
      contenido: null, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  e: {
    nombre: 'Válida · vencida',
    resultado: {
      firma: 'VALIDA', vigencia: 'VENCIDA', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_E, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  f: {
    nombre: 'Contenido hostil (estado simulado de firma válida, sin conexión)',
    resultado: {
      firma: 'VALIDA', vigencia: 'VIGENTE', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_F, sinConexion: true, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  g: {
    nombre: 'Actualización simulada (Update) · vigente',
    resultado: {
      firma: 'VALIDA', vigencia: 'VIGENTE', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_G, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
  h: {
    nombre: 'Cancelación simulada (Cancel) · vencida · referencias hostiles',
    resultado: {
      firma: 'VALIDA', vigencia: 'VENCIDA', cadena: 'NO_COMPROBABLE',
      contenido: CONTENIDO_H, sinConexion: false, ultimaSync: ULTIMA_SYNC_DEMO,
    },
  },
};

export interface ItemDemo {
  item: ItemAlerta;
  caso: ClaveCaso;
}

export const LISTA_DEMO: readonly ItemDemo[] = [
  { caso: 'h', item: { identifier: 'SIGA-E-2026-0010', tipo: 'Cancel', firma: 'VALIDA', vigencia: 'VENCIDA', titular: CONTENIDO_H.titular, severidad: 'Minor' } },
  { caso: 'g', item: { identifier: 'SIGA-E-2026-0009', tipo: 'Update', firma: 'VALIDA', vigencia: 'VIGENTE', titular: CONTENIDO_G.titular, severidad: 'Severe' } },
  { caso: 'a', item: { identifier: 'SIGA-E-2026-0007', tipo: 'Alert', firma: 'VALIDA', vigencia: 'VIGENTE', titular: CONTENIDO_A.titular, severidad: 'Severe' } },
  { caso: 'b', item: { identifier: 'SIGA-E-2026-0006', tipo: 'Alert', firma: 'VALIDA', vigencia: 'VIGENTE', titular: CONTENIDO_B.titular, severidad: 'Moderate' } },
  { caso: 'c', item: { identifier: 'SIGA-E-2026-0005', tipo: 'Alert', firma: 'INVALIDA', vigencia: 'DESCONOCIDA', titular: null, severidad: null } },
  { caso: 'e', item: { identifier: 'SIGA-E-2026-0004', tipo: 'Alert', firma: 'VALIDA', vigencia: 'VENCIDA', titular: CONTENIDO_E.titular, severidad: 'Extreme' } },
  { caso: 'd', item: { identifier: 'SIGA-E-2026-0003', tipo: 'Alert', firma: 'CLAVE_DESCONOCIDA', vigencia: 'DESCONOCIDA', titular: null, severidad: null } },
  { caso: 'f', item: { identifier: 'SIGA-E-2026-0008', tipo: 'Alert', firma: 'VALIDA', vigencia: 'VIGENTE', titular: CONTENIDO_F.titular, severidad: 'Unknown' } },
];
