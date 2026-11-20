// Textos ciudadanos. PROVISIONALES (P3): se validan con MT8 antes de darlos por finales.
// Cada Record es exhaustivo: añadir un estado en tipos.ts sin su texto falla en tsc.
import type { Cadena, ClaveDimension, Dimension, Firma, NombreIcono, Severidad, TipoMensaje, Tono, Vigencia } from './tipos';
import type { MotivoForma } from '../lib/forma-jws.mjs';

export interface TextoEstado {
  etiqueta: string;
  explica: string;
  icono: NombreIcono;
  tono: Tono;
}

export const TEXTO_FIRMA: Record<Firma, TextoEstado> = {
  VALIDA: {
    etiqueta: 'Firma válida',
    explica: 'La firma coincide con una clave de confianza guardada en este dispositivo. El contenido no cambió desde que se firmó.',
    icono: 'check',
    tono: 'ok',
  },
  INVALIDA: {
    etiqueta: 'Firma inválida',
    explica: 'El contenido no coincide con su firma: pudo alterarse o llegó incompleto. No lo uses.',
    icono: 'cross',
    tono: 'mal',
  },
  CLAVE_DESCONOCIDA: {
    etiqueta: 'Clave desconocida',
    explica: 'La clave que firmó este mensaje no está entre las claves de confianza de este dispositivo. No se pudo comprobar la firma.',
    icono: 'help',
    tono: 'alerta',
  },
  CLAVE_REVOCADA: {
    etiqueta: 'Clave revocada',
    explica: 'La clave que firmó este mensaje figura como revocada en el catálogo de este dispositivo. No se muestra su contenido: no lo uses.',
    icono: 'cross',
    tono: 'mal',
  },
  FUERA_DE_POLITICA: {
    etiqueta: 'Fuera de política',
    explica: 'La firma es correcta, pero el mensaje o su clave incumplen las reglas de SIGA-E. No se muestra su contenido ni se trata como alerta válida.',
    icono: 'aviso',
    tono: 'mal',
  },
};

export const TEXTO_VIGENCIA: Record<Vigencia, TextoEstado> = {
  VIGENTE: {
    etiqueta: 'Vigente',
    explica: 'Según el reloj de este dispositivo, la fecha de vencimiento firmada todavía no pasó.',
    icono: 'clock',
    tono: 'ok',
  },
  VENCIDA: {
    etiqueta: 'Vencida',
    explica: 'La fecha de vencimiento firmada ya pasó según el reloj de este dispositivo. El mensaje ya no está activo.',
    icono: 'clock-off',
    tono: 'alerta',
  },
  DESCONOCIDA: {
    etiqueta: 'Vigencia desconocida',
    explica: 'Sin una firma comprobada no se puede confiar en la fecha de vencimiento del mensaje.',
    icono: 'clock-help',
    tono: 'neutro',
  },
};

// Solo NO_COMPROBABLE: la PWA no lee el contrato (ADR-005). Los textos de COINCIDE y NO_COINCIDE de
// D03–D06a quedan como diseño histórico en apps/web/mocks y docs/diseno/capturas, no aquí.
export const TEXTO_CADENA: Record<Cadena, TextoEstado> = {
  NO_COMPROBABLE: {
    etiqueta: 'No comprobable',
    explica: 'Esta aplicación no consulta el registro de Stellar Testnet. Esto no significa que el mensaje sea falso: solo que no se comprobó.',
    icono: 'dash',
    tono: 'neutro',
  },
};

/** Orden fijo en toda la interfaz: firma, vigencia, registro. */
export const DIMENSIONES: readonly ClaveDimension[] = ['firma', 'vigencia', 'cadena'];

export const TITULO_DIMENSION: Record<ClaveDimension, string> = {
  firma: 'Firma',
  vigencia: 'Vigencia',
  cadena: 'Registro en Stellar Testnet',
};

export function textoDeDimension(d: Dimension): TextoEstado {
  switch (d.clave) {
    case 'firma':
      return TEXTO_FIRMA[d.estado];
    case 'vigencia':
      return TEXTO_VIGENCIA[d.estado];
    case 'cadena':
      return TEXTO_CADENA[d.estado];
  }
}

export const TEXTO_SEVERIDAD: Record<Severidad, { etiqueta: string; nivel: number }> = {
  Extreme: { etiqueta: 'Extrema', nivel: 4 },
  Severe: { etiqueta: 'Severa', nivel: 3 },
  Moderate: { etiqueta: 'Moderada', nivel: 2 },
  Minor: { etiqueta: 'Menor', nivel: 1 },
  Unknown: { etiqueta: 'Sin clasificar', nivel: 0 },
};

export const LIMITE =
  'Una firma válida y un registro coincidente no prueban que el evento sea real ni que el emisor sea una autoridad oficial. SIGA-E es un simulacro académico.';

export const VERIFICADOR_NO_DISPONIBLE = 'La verificación todavía no está disponible en esta versión del prototipo';
export const CATALOGO_NO_DISPONIBLE =
  'No se pudo cargar el catálogo de claves de confianza, así que no se comprobó la firma. No uses este mensaje.';
export const SIN_CAMBIOS_CONOCIDOS =
  'No se conocen cambios posteriores; no se puede confirmar si la alerta fue actualizada o cancelada.';
export const AVISO_CATALOGO =
  'Claves de DEMOSTRACIÓN: sirven solo para mensajes de prueba, no para alertas reales. La información de revocación es la de la copia guardada en esta aplicación y puede no estar actualizada.';
// Resultado de demostración: ningún estado del panel procede de una verificación criptográfica.
export const AVISO_SIMULADO = {
  titulo: 'DEMOSTRACIÓN SIMULADA — No se ha verificado ninguna firma criptográfica',
  cuerpo:
    'Los estados de abajo son datos fijos de desarrollo elegidos a mano. No dicen nada sobre ningún mensaje real ni sobre su firma.',
} as const;
export const TECNICO_SIMULADO =
  'Sin datos técnicos: en una demostración simulada no se usó ninguna clave ni se calculó la huella de ningún mensaje.';
export const TITULO_LIMITES = 'Límites de esta comprobación';
export const TITULO_CONTENIDO = 'Contenido del mensaje';

export interface TextoTipo {
  /** Nombre del tipo, visible en el contenido y en la lista. */
  etiqueta: string;
  /** Encabezado de la región de contenido. */
  tituloContenido: string;
  /** Aviso de la aplicación cuando el mensaje no es una alerta inicial; null en Alert. */
  aviso: { titulo: string; cuerpo: string } | null;
  vencida: string;
}

// Update y Cancel se refieren a otro aviso. Sin historial firmado no se concluye ACTUALIZADA ni
// CANCELADA para ese aviso, ni se afirma que exista (ENM-002 §5 y §7, ADR-005).
export const TEXTO_TIPO: Record<TipoMensaje, TextoTipo> = {
  Alert: {
    etiqueta: 'Alerta inicial',
    tituloContenido: TITULO_CONTENIDO,
    aviso: null,
    vencida: 'Esta alerta venció: no está activa. Se muestra solo como registro de lo que se firmó.',
  },
  Update: {
    etiqueta: 'Mensaje de actualización',
    tituloContenido: 'Contenido del mensaje de actualización',
    aviso: {
      titulo: 'No es una alerta inicial: dice actualizar otro aviso',
      cuerpo:
        'Esta aplicación no tiene el historial firmado de ese aviso. No puede saber cuál es su estado actual, si esta actualización le corresponde ni si hubo mensajes posteriores.',
    },
    vencida: 'Este mensaje de actualización venció. Se muestra solo como registro de lo que se firmó.',
  },
  Cancel: {
    etiqueta: 'Mensaje de cancelación',
    tituloContenido: 'Contenido del mensaje de cancelación',
    aviso: {
      titulo: 'No es una alerta inicial: dice cancelar otro aviso',
      cuerpo:
        'Esta aplicación no tiene el historial firmado de ese aviso. No puede confirmar que esté cancelado, si esta cancelación le corresponde ni si hubo mensajes posteriores.',
    },
    vencida: 'Este mensaje de cancelación venció. Se muestra solo como registro de lo que se firmó.',
  },
};

/** Vencida sin tipo conocido (defensa: con firma VALIDA siempre hay tipo). */
export const AVISO_VENCIDA = 'Este mensaje venció: no está activo. Se muestra solo como registro de lo que se firmó.';

export const ROTULO_TIPO = 'Tipo de mensaje: ';
export const SUFIJO_NO_INICIAL = ' · no es una alerta inicial';
export const TITULO_REFERENCIAS = 'Avisos a los que dice referirse';
export const referenciasOcultas = (n: number): string =>
  n === 1 ? 'Y 1 referencia más que no se muestra.' : `Y ${n} referencias más que no se muestran.`;
export const ROTULO_REFERENCIAS =
  'Lo declara el mensaje. Esta aplicación no comprobó que esos avisos existan ni cuál es su estado.';
export const SIN_CONTENIDO_FIRMA: Record<Firma, string> = {
  VALIDA: 'El mensaje no incluye contenido que mostrar.',
  INVALIDA: 'No se muestra: la firma no es válida.',
  CLAVE_DESCONOCIDA: 'No se muestra: no se pudo comprobar la firma.',
  CLAVE_REVOCADA: 'No se muestra: la clave que lo firmó está revocada.',
  FUERA_DE_POLITICA: 'No se muestra: el mensaje incumple las reglas de SIGA-E.',
};
export const VERIFICACION_FALLIDA ='No se pudo completar la verificación. Inténtalo de nuevo.';

export const ERROR_FORMA: Record<MotivoForma, string> = {
  vacio: 'No hay nada que verificar. Pega el mensaje o carga el archivo.',
  espacios:
    'El mensaje tiene espacios o saltos de línea, al principio, al final o en medio. Un mensaje firmado no los lleva y no se quitan por ti: cópialo de nuevo sin añadir nada o usa un archivo que contenga solo el mensaje.',
  segmentos: 'Esto no parece un mensaje firmado: debe tener tres partes separadas por puntos (encabezado.contenido.firma).',
  caracteres: 'El texto tiene caracteres que no pueden formar parte de un mensaje firmado.',
  grande: 'El mensaje es demasiado grande para ser un mensaje firmado de SIGA-E.',
};

export const INICIO_VACIO =
  'Todavía no hay alertas en este dispositivo. Esta versión del prototipo aún no obtiene ni guarda alertas.';
