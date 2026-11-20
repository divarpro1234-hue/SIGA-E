// Nombre de archivo elegido por la persona: contenido NO confiable. Esta función solo lo reduce a un
// nombre sin ruta y con longitud acotada; los caracteres de control y de dirección los neutraliza
// TextoAjeno al dibujarlo. Nunca se interpreta como HTML ni se usa como ruta o URL.

/** Máximo en unidades UTF-16 que se conservan del nombre (cota de coste antes de segmentar). */
export const MAX_NOMBRE_ARCHIVO = 255;

/**
 * Último segmento del nombre, sin rutas locales (separadores «/» y «\»), con espacios recortados.
 * @param {unknown} nombre
 * @returns {string} Cadena vacía si no queda nada que mostrar.
 */
export function nombreArchivoSeguro(nombre) {
  if (typeof nombre !== 'string') return '';
  const base = nombre.slice(0, MAX_NOMBRE_ARCHIVO * 4);
  const corte = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  return base.slice(corte + 1).trim().slice(0, MAX_NOMBRE_ARCHIVO);
}
