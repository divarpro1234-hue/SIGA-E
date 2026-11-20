// Textos del portal interno (D08A). PROVISIONALES (P3). Nunca repiten detail del servidor ni la
// entrada del usuario. Ningún mensaje distingue si una cuenta existe, está pendiente, deshabilitada
// o bloqueada: el backend responde 401 genérico en todos esos casos (ADR-004 §3).
import type { ErrorAcceso, ErrorCodigo } from './validacion.mjs';

export const ERROR_CAMPO_ACCESO: Record<ErrorAcceso, string> = {
  'correo-vacio': 'Escribe tu correo de trabajo.',
  'correo-forma': 'El correo no tiene una forma válida. Ejemplo: nombre@dominio.org',
  'correo-largo': 'El correo es demasiado largo (máximo 254 caracteres).',
  'contrasena-vacia': 'Escribe tu contraseña.',
  'contrasena-larga': 'La contraseña es demasiado larga (máximo 512 caracteres).',
};

export const ERROR_CAMPO_CODIGO: Record<ErrorCodigo, string> = {
  'codigo-vacio': 'Escribe el código de seis cifras de tu aplicación de autenticación.',
  'codigo-forma': 'El código tiene seis cifras, sin letras. Puedes dejar un espacio en medio.',
};

export interface AvisoAcceso {
  titulo: string;
  cuerpo: string;
}

export const AVISO_RECHAZO_ACCESO: AvisoAcceso = {
  titulo: 'No se pudo iniciar sesión',
  cuerpo:
    'Revisa el correo y la contraseña e inténtalo de nuevo. Tras varios intentos fallidos el acceso se bloquea durante 15 minutos.',
};

export const AVISO_RECHAZO_CODIGO: AvisoAcceso = {
  titulo: 'Código no aceptado',
  cuerpo:
    'Puede que el código fuera incorrecto, que ya se hubiera usado o que el paso de verificación haya caducado. Espera a que tu aplicación muestre un código nuevo e inténtalo otra vez.',
};

export const AVISO_DESAFIO_AGOTADO: AvisoAcceso = {
  titulo: 'Hay que empezar de nuevo',
  cuerpo: 'Tras tres códigos no aceptados este paso de verificación ya no sirve. Vuelve a escribir tu correo y contraseña.',
};

export const AVISO_DESAFIO_CADUCADO: AvisoAcceso = {
  titulo: 'El paso de verificación caducó',
  cuerpo: 'Tienes cinco minutos para escribir el código. Vuelve a escribir tu correo y contraseña para recibir otro paso de verificación.',
};

export function avisoLimitado(segundos: number | null): AvisoAcceso {
  const espera =
    segundos === null
      ? 'unos minutos'
      : segundos >= 60
        ? `${Math.ceil(segundos / 60)} ${Math.ceil(segundos / 60) === 1 ? 'minuto' : 'minutos'}`
        : `${segundos} segundos`;
  return {
    titulo: 'Demasiados intentos',
    cuerpo: `Se han hecho demasiados intentos de acceso desde esta conexión. Espera ${espera} antes de volver a intentarlo.`,
  };
}

export const AVISO_INVALIDO: AvisoAcceso = {
  titulo: 'El servidor no aceptó los datos',
  cuerpo: 'Revisa que el correo y el código tengan la forma indicada e inténtalo de nuevo.',
};

export const AVISO_NO_DISPONIBLE: AvisoAcceso = {
  titulo: 'Acceso interno no disponible',
  cuerpo:
    'Este servidor no ofrece todavía el acceso interno. No es un problema de tus datos: el servicio de autenticación no está habilitado aquí.',
};

export const AVISO_ERROR_RED: AvisoAcceso = {
  titulo: 'Sin comunicación con el servidor',
  cuerpo: 'No se recibió respuesta. Comprueba tu conexión e inténtalo de nuevo. No se ha iniciado ninguna sesión.',
};

export const AVISO_ERROR_SERVIDOR: AvisoAcceso = {
  titulo: 'El servidor no pudo completar la solicitud',
  cuerpo: 'Inténtalo de nuevo en unos minutos. Si persiste, avisa a la persona responsable del sistema.',
};

export const AVISO_RESPUESTA_INVALIDA: AvisoAcceso = {
  titulo: 'Respuesta no reconocida',
  cuerpo: 'El servidor respondió de una forma que esta aplicación no reconoce, así que no se ha dado por iniciada ninguna sesión.',
};

export const AVISO_PROHIBIDO: AvisoAcceso = {
  titulo: 'Operación no autorizada',
  cuerpo: 'El servidor rechazó la solicitud. Vuelve a intentarlo; si persiste, cierra la ventana e inicia sesión de nuevo.',
};

export const SESION_AUSENTE: AvisoAcceso = {
  titulo: 'Necesitas iniciar sesión',
  cuerpo: 'El portal interno solo se muestra cuando el servidor confirma una sesión con contraseña y código.',
};

export const SESION_VENCIDA: AvisoAcceso = {
  titulo: 'Tu sesión terminó',
  cuerpo:
    'El servidor ya no reconoce la sesión: venció (8 horas como máximo o 30 minutos sin actividad) o se cerró. Inicia sesión de nuevo.',
};

export const SESION_CERRADA: AvisoAcceso = {
  titulo: 'Sesión cerrada',
  cuerpo: 'Has salido del portal interno. Para volver, inicia sesión de nuevo.',
};

export const SESION_SIN_CONFIRMAR_RED: AvisoAcceso = {
  titulo: 'Sin conexión con el servidor',
  cuerpo:
    'No se pudo volver a confirmar tu sesión. Lo que ves es la última confirmación; cualquier operación la decidirá el servidor cuando vuelva la conexión.',
};

export const SESION_SIN_CONFIRMAR_SERVIDOR: AvisoAcceso = {
  titulo: 'El servidor no confirmó la sesión',
  cuerpo:
    'El servidor respondió con un error al volver a comprobar tu sesión. Lo que ves es la última confirmación; inténtalo de nuevo en unos minutos.',
};

export const CIERRE_FALLIDO: AvisoAcceso = {
  titulo: 'No se pudo confirmar el cierre de sesión',
  cuerpo:
    'El servidor no confirmó el cierre, así que la sesión podría seguir activa. Inténtalo de nuevo; si no hay conexión, la sesión vence sola a los 30 minutos sin actividad.',
};

export const COMPROBANDO_SESION = 'Comprobando la sesión con el servidor…';

/** Aviso permanente del portal: identidad del entorno, sin aparentar oficialidad. */
export const AVISO_ENTORNO =
  'Prototipo académico SIGA-E. Todas las alertas son SIMULACRO de un emisor ficticio.';
