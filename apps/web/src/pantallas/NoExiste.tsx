import { RUTAS, TITULOS } from '../app/router.mjs';
import { Enlace } from '../componentes/Enlace';
import { Titulo } from '../componentes/Titulo';

// No se repite la ruta pedida: es una entrada no confiable.
export function NoExiste() {
  return (
    <>
      <Titulo>{TITULOS['no-existe']}</Titulo>
      <p>La dirección no corresponde a ninguna pantalla de SIGA-E.</p>
      <Enlace a={RUTAS.inicio} className="boton boton-enlace">
        Ir al inicio
      </Enlace>
    </>
  );
}
