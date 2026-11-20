/** El catálogo de confianza falta, está corrupto o no pudo cargarse. Nunca se devuelve VALIDA. */
export class CatalogoNoDisponible extends Error {
  constructor() {
    super('Catálogo de confianza no disponible');
    this.name = 'CatalogoNoDisponible';
  }
}

/** El verificador del modo demostración (solo desarrollo) rechaza entradas que no son un caso fijo. */
export class VerificadorNoDisponible extends Error {
  constructor() {
    super('Verificador no disponible');
    this.name = 'VerificadorNoDisponible';
  }
}
