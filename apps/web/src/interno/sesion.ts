// Estado de acceso interno SOLO en memoria (variables de módulo), como el resultado de verificación.
// Nunca en la URL, localStorage, sessionStorage, IndexedDB ni history.state. Al recargar se pierde a
// propósito: el desafío de login muere y la sesión se vuelve a consultar con GET /auth/me.
// La cookie de sesión es HttpOnly: la interfaz no puede leerla y no presume que exista.
import { useSyncExternalStore } from 'react';
import { crearClienteAuth, type UsuarioInterno } from './cliente-auth.mjs';

export const cliente = crearClienteAuth();

export type EstadoSesion =
  | { fase: 'sin-comprobar' }
  | { fase: 'comprobando' }
  /** confirmadaEn: última vez (ms) que GET /auth/me la aceptó. Solo /auth/me fija este estado. */
  /** sinConfirmar: la última comprobación falló por red o servidor; se muestra un aviso, no se oculta. */
  | { fase: 'activa'; usuario: UsuarioInterno; csrf: string; confirmadaEn: number; sinConfirmar?: 'red' | 'servidor' }
  /** ausente: nunca hubo sesión confirmada aquí; vencida: la había y el servidor ya no la acepta. */
  | { fase: 'sin-sesion'; motivo: 'ausente' | 'vencida' | 'cerrada' }
  | { fase: 'no-disponible' }
  | { fase: 'error'; motivo: 'red' | 'servidor' | 'respuesta' };

/** Desafío de /auth/login: confirma solo la contraseña; nunca es una sesión. */
export interface Desafio {
  challengeId: string;
  /** Instante de caducidad (ms), según el servidor. */
  expiraEn: number;
  /** Códigos rechazados en este desafío, contados en el cliente. El backend revoca al tercero. */
  rechazos: number;
}

export const MAX_RECHAZOS_CODIGO = 3;

let estado: EstadoSesion = { fase: 'sin-comprobar' };
let desafio: Desafio | null = null;
const oyentes = new Set<() => void>();

function avisar(): void {
  oyentes.forEach((o) => o());
}

function suscribir(aviso: () => void): () => void {
  oyentes.add(aviso);
  return () => {
    oyentes.delete(aviso);
  };
}

export function useSesion(): EstadoSesion {
  return useSyncExternalStore(suscribir, () => estado, () => estado);
}

export function useDesafio(): Desafio | null {
  return useSyncExternalStore(suscribir, () => desafio, () => null);
}

export function fijarSesion(nuevo: EstadoSesion): void {
  estado = nuevo;
  avisar();
}

export function fijarDesafio(nuevo: Desafio | null): void {
  desafio = nuevo;
  avisar();
}

export function leerSesion(): EstadoSesion {
  return estado;
}

let enCurso: Promise<void> | null = null;
// Generación del contexto de autenticación. Cambia al cerrar sesión y al completar el TOTP: una
// consulta a /auth/me lanzada antes ya no describe la sesión actual y su respuesta se descarta.
let generacion = 0;

/**
 * Pregunta al servidor si hay sesión. Mientras tanto, una sesión ya confirmada sigue a la vista
 * (no parpadea); cualquier otra situación pasa a «comprobando» y no muestra nada interno.
 */
export function comprobarSesion(): Promise<void> {
  if (enCurso) return enCurso;
  const previa = estado;
  const mia = generacion;
  if (previa.fase !== 'activa') fijarSesion({ fase: 'comprobando' });
  const peticion: Promise<void> = cliente
    .consultarSesion()
    .then((r) => {
      if (mia !== generacion) return;
      // Un corte de red o un 5xx no dicen que la sesión terminó: la ya confirmada sigue a la vista
      // (el servidor decide en cada operación) con un aviso, y «Cerrar sesión» sigue disponible.
      if (previa.fase === 'activa' && (r.tipo === 'error-red' || r.tipo === 'error-servidor')) {
        fijarSesion({ ...previa, sinConfirmar: r.tipo === 'error-red' ? 'red' : 'servidor' });
        return;
      }
      switch (r.tipo) {
        case 'sesion':
          fijarSesion({ fase: 'activa', usuario: r.usuario, csrf: r.csrf, confirmadaEn: Date.now() });
          break;
        case 'sin-sesion':
          fijarSesion({ fase: 'sin-sesion', motivo: previa.fase === 'activa' ? 'vencida' : 'ausente' });
          break;
        case 'no-disponible':
          fijarSesion({ fase: 'no-disponible' });
          break;
        case 'error-red':
          fijarSesion({ fase: 'error', motivo: 'red' });
          break;
        case 'error-servidor':
          fijarSesion({ fase: 'error', motivo: 'servidor' });
          break;
        default:
          fijarSesion({ fase: 'error', motivo: 'respuesta' });
      }
    })
    .finally(() => {
      if (enCurso === peticion) enCurso = null;
    });
  enCurso = peticion;
  return peticion;
}

/** Contexto nuevo: invalida cualquier consulta en vuelo. */
function nuevaGeneracion(): void {
  generacion += 1;
  enCurso = null;
}

/**
 * El servidor aceptó el código TOTP. Su respuesta no abre el portal: se olvida el desafío y se deja la
 * sesión «comprobando» hasta que GET /auth/me la confirme.
 */
export function codigoAceptado(): void {
  nuevaGeneracion();
  desafio = null;
  estado = { fase: 'comprobando' };
  avisar();
}

/** Tras cerrar sesión, o si el servidor ya no la reconoce: nada interno queda en memoria. */
export function olvidarTodo(motivo: 'cerrada' | 'vencida' | 'ausente'): void {
  nuevaGeneracion();
  desafio = null;
  estado = { fase: 'sin-sesion', motivo };
  avisar();
}
