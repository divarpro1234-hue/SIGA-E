// Tipos del dominio de la interfaz. No hay lógica de verificación aquí: la real vendrá de
// packages/verify (P11, carril de Codex) a través de la interfaz Verificador.

// Estados de firma = los de @siga-e/verify. CANCELADA y ACTUALIZADA no existen aquí: requieren
// historial firmado con referencias verificadas, que esta interfaz no tiene (ENM-002 §5 y §7).
// Añadir un estado aquí obliga a añadir su texto en textos.ts (Record exhaustivo).
export type Firma = 'VALIDA' | 'INVALIDA' | 'CLAVE_DESCONOCIDA' | 'CLAVE_REVOCADA' | 'FUERA_DE_POLITICA';
export type Vigencia = 'VIGENTE' | 'VENCIDA' | 'DESCONOCIDA';
// La PWA nunca consulta Soroban (ADR-005): su única conclusión posible es NO_COMPROBABLE.
// COINCIDE, NO_COINCIDE y NO_REGISTRADA son conclusiones de la CLI externa y no se representan aquí.
export type Cadena = 'NO_COMPROBABLE';

/** msgType firmado. Update y Cancel se refieren a otro aviso; nunca son una alerta inicial. */
export type TipoMensaje = 'Alert' | 'Update' | 'Cancel';

/** Aviso al que un Update o Cancel dice referirse. Lo declara el mensaje: texto no confiable y no comprobado. */
export interface ReferenciaDeclarada {
  sender: string;
  identifier: string;
  sent: string;
}

export type ClaveDimension = 'firma' | 'vigencia' | 'cadena';

export type Dimension =
  | { clave: 'firma'; estado: Firma }
  | { clave: 'vigencia'; estado: Vigencia }
  | { clave: 'cadena'; estado: Cadena };

// Severidad CAP. Se muestra en un medidor ordinal en tinta neutra (P13 pendiente de validación).
export type Severidad = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';

// El color nunca va solo: cada estado lleva icono y etiqueta.
export type Tono = 'ok' | 'mal' | 'alerta' | 'neutro';

export type NombreIcono =
  | 'check'
  | 'cross'
  | 'help'
  | 'clock'
  | 'clock-off'
  | 'clock-help'
  | 'link'
  | 'link-off'
  | 'dash'
  | 'online'
  | 'offline'
  | 'aviso';

/** Campos del mensaje que escribe un tercero: texto no confiable. Fechas en ISO 8601 UTC. */
export interface ContenidoAlerta {
  tipo: TipoMensaje;
  /** Vacío en una alerta inicial sin referencias; al menos una en Update y Cancel. */
  referencias: readonly ReferenciaDeclarada[];
  titular: string;
  descripcion: string;
  area: string;
  evento: string;
  severidad: Severidad;
  enviado: string;
  vence: string;
}

/** Valores del panel: vienen de la configuración de confianza o del cálculo local, nunca del mensaje. */
export interface DatosPanel {
  /** null cuando el encabezado no trae un identificador con forma válida. */
  kid: string | null;
  /** null cuando la estructura del JWS no es aceptable. */
  hashJws: string | null;
  /** Catálogo de confianza usado y su huella SHA-256 calculada localmente. */
  catalogo?: { etiqueta: string; huella: string } | null;
}

/**
 * De dónde sale el resultado. VERIFICACION_LOCAL: @siga-e/verify comprobó la firma en este dispositivo.
 * SIMULADO: datos fijos de demostración, sin ninguna comprobación criptográfica. La interfaz trata como
 * SIMULADO cualquier valor distinto de VERIFICACION_LOCAL (ver lib/origen-resultado.mjs).
 */
export type OrigenResultado = 'VERIFICACION_LOCAL' | 'SIMULADO';

export interface ResultadoVerificacion {
  origen: OrigenResultado;
  firma: Firma;
  vigencia: Vigencia;
  cadena: Cadena;
  /** null cuando no hay nada que dar por firmado. La interfaz tampoco lo muestra sin firma VALIDA. */
  contenido: ContenidoAlerta | null;
  panel: DatosPanel;
  sinConexion: boolean;
  /** Última sincronización conocida (ISO UTC); null si no hay. */
  ultimaSync: string | null;
}

export interface Verificador {
  verificar(jws: string): Promise<ResultadoVerificacion>;
}

/** Ítem de la lista de Inicio (P16 pendiente: el listado público no trae estos datos). */
export interface ItemAlerta {
  identifier: string;
  tipo: TipoMensaje;
  firma: Firma;
  vigencia: Vigencia;
  /** Solo con firma VALIDA; en otro caso null y la lista muestra únicamente el identificador. */
  titular: string | null;
  severidad: Severidad | null;
}

/** Longitudes máximas por campo, en grafemas, según OpenAPI. */
export const LIMITES_TEXTO = {
  titular: 200,
  descripcion: 4000,
  area: 200,
  evento: 120,
  /** sender e identifier de una referencia: el contrato no los acota; se recortan al mostrarlos. */
  referencia: 200,
} as const;

/** Referencias declaradas que se muestran como máximo; del resto solo se dice cuántas hay. */
export const MAX_REFERENCIAS_VISIBLES = 3;
