/** El llamador establece este catálogo mediante un canal de confianza previo. */
export interface ClavePublicaConfiable {
  readonly kid: string;
  readonly estado: "activa" | "retirada" | "revocada";
  readonly validFrom: string;
  readonly retiredAt?: string | null;
  readonly revokedAt?: string | null;
  readonly publicJwk: Readonly<JsonWebKey>;
}

export interface CatalogoConfianza {
  readonly claves: readonly ClavePublicaConfiable[];
}

export type EstadoFirma =
  | "VALIDA"
  | "INVALIDA"
  | "CLAVE_DESCONOCIDA"
  | "CLAVE_REVOCADA"
  | "FUERA_DE_POLITICA";

export type EstadoVigencia = "VIGENTE" | "VENCIDA" | "DESCONOCIDA";

export interface ResultadoFirma {
  readonly firma: EstadoFirma;
  readonly vigencia: EstadoVigencia;
  readonly kid: string | null;
  /** SHA-256 de los bytes ASCII exactos del JWS, en hexadecimal minúsculo. */
  readonly jwsHash: string | null;
  /** Solo existe cuando firma=VALIDA y se cumple toda la política. */
  readonly payload: unknown | null;
}

export interface AlertaFirmada {
  readonly sender: string;
  readonly identifier: string;
  readonly sent: string;
  readonly status: "Exercise";
  readonly scope: "Public";
  readonly msgType: "Alert" | "Update" | "Cancel";
  readonly info: {
    readonly scenario: "INUNDACION" | "DESLIZAMIENTO" | "SISMO";
    readonly event: string;
    readonly severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
    readonly urgency: string;
    readonly certainty: string;
    readonly headline: string;
    readonly description: string;
    readonly expires: string;
    readonly areaDesc: string;
  };
  readonly references?: readonly {
    readonly sender: string;
    readonly identifier: string;
    readonly sent: string;
  }[];
}
