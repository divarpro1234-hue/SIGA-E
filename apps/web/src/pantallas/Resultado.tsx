// Resultado: pantalla con ruta propia; el resultado vive solo en memoria.
import { RUTAS, TITULOS } from '../app/router.mjs';
import { limpiarResultado, useResultado } from '../app/verificacion';
import { ContenidoAjeno } from '../componentes/ContenidoAjeno';
import { Enlace } from '../componentes/Enlace';
import { SIN_CONTENIDO_FIRMA } from '../dominio/textos';
import { esResultadoSimulado } from '../lib/origen-resultado.mjs';
import { PanelVerificacion } from '../componentes/PanelVerificacion';
import { Titulo } from '../componentes/Titulo';

export function Resultado() {
  const resultado = useResultado();
  // Sin resultado en memoria, App redirige a Verificar; aquí no se dibuja nada.
  if (!resultado) return null;

  // Defensa: sin firma VALIDA no hay nada que dar por firmado, aunque el verificador entregue contenido.
  const contenido = resultado.firma === 'VALIDA' ? resultado.contenido : null;
  const simulado = esResultadoSimulado(resultado);

  return (
    <>
      <Titulo>{TITULOS.resultado}</Titulo>
      <PanelVerificacion resultado={resultado} />
      <ContenidoAjeno contenido={contenido} sinContenido={SIN_CONTENIDO_FIRMA[resultado.firma]} simulado={simulado} />
      <Enlace a={RUTAS.verificar} className="boton boton-enlace" onNavegar={limpiarResultado}>
        Verificar otro mensaje
      </Enlace>
    </>
  );
}
