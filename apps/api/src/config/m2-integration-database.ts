export class M2IntegrationDatabaseError extends Error {
  override readonly name = "M2IntegrationDatabaseError";

  constructor() {
    super("Configuración PostgreSQL de integración M2 inválida.");
  }
}

// Lista positiva literal, sin normalización, decodificación ni captura del secreto.
// (?![\s\S]) exige el final real, incluso ante un salto de línea final.
const dedicatedUrl = /^postgres(?:ql)?:\/\/sigae_m2_itest:[A-Za-z0-9._~-]+@127\.0\.0\.1:55432\/sigae_m2_submit_itest(?![\s\S])/;

/**
 * Guard puro: recibe un objeto explícito con DATABASE_URL obligatoria y
 * DIRECT_URL opcional. Si se incluye DIRECT_URL, debe ser una string idéntica
 * a DATABASE_URL (también protocolo y contraseña). Rechaza toda otra propiedad,
 * propiedades heredadas y accesores. No acepta un objeto process.env completo.
 *
 * Solo admite postgres:// o postgresql:// en minúsculas, usuario sigae_m2_itest,
 * host literal 127.0.0.1, puerto 55432 y base sigae_m2_submit_itest.
 * La contraseña debe contener uno o más caracteres URL no reservados ASCII
 * (letras, dígitos, punto, guion, guion bajo o tilde). No admite escapes %, query,
 * fragmentos, espacios, controles ni rutas adicionales. No transforma la URL.
 *
 * Devuelve void: no retorna ni conserva credenciales. No consulta el entorno,
 * no carga .env, no conecta y no habilita escrituras ni migraciones.
 * Validar el nombre del usuario NO demuestra sus permisos efectivos: antes de
 * cualquier escritura se requiere una revisión independiente del rol, sus
 * privilegios y el aislamiento real del servidor/base. La futura integración
 * debe evitar overrides de conexión y conservar TimeZone=UTC del cliente.
 */
export function validateM2IntegrationDatabase(source: unknown): void {
  try {
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
      throw new M2IntegrationDatabaseError();
    }
    const prototype: unknown = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new M2IntegrationDatabaseError();
    }
    const keys = Reflect.ownKeys(source);
    if (!keys.includes("DATABASE_URL") ||
        keys.some((key) => key !== "DATABASE_URL" && key !== "DIRECT_URL")) {
      throw new M2IntegrationDatabaseError();
    }
    const database = Object.getOwnPropertyDescriptor(source, "DATABASE_URL");
    const direct = Object.getOwnPropertyDescriptor(source, "DIRECT_URL");
    if (!database || !("value" in database) ||
        typeof database.value !== "string" || !dedicatedUrl.test(database.value) ||
        (keys.includes("DIRECT_URL") &&
          (!direct || !("value" in direct) || direct.value !== database.value))) {
      throw new M2IntegrationDatabaseError();
    }
  } catch {
    // Tampoco propagar errores de inspección de objetos externos ni sus causas.
    throw new M2IntegrationDatabaseError();
  }
}
