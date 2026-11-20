// Aviso no bloqueante de versión nueva. El contenedor es siempre una región viva para que el
// anuncio llegue al insertar el contenido. Texto PROVISIONAL (P3).
import { aplicarActualizacion, useActualizacionDisponible } from '../app/sw-registro';

export function AvisoActualizacion() {
  const disponible = useActualizacionDisponible();
  return (
    <div className="aviso-actualizacion" role="status">
      {disponible ? (
        <div className="aviso-actualizacion-cuerpo">
          <p>Hay una versión nueva de SIGA-E. Al actualizar se recarga la página y se borra lo que tengas en pantalla.</p>
          <button className="boton" type="button" onClick={aplicarActualizacion}>
            Actualizar
          </button>
        </div>
      ) : null}
    </div>
  );
}
