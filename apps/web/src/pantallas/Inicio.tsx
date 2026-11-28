import { TITULOS } from '../app/router.mjs';
import { Titulo } from '../componentes/Titulo';
import { BandejaPublicaLive } from '../publico/BandejaPublicaLive';
import { DemoQRLocal } from '../publico/DemoQRLocal';
import { navegar } from '../app/ruta';
import { RUTAS } from '../app/router.mjs';

export function Inicio() {
  return (
    <>
      <Titulo>{TITULOS.inicio}</Titulo>
      <section className="live-seccion demo-publico-acceso" aria-label="Demostración pública">
        <p className="live-nota">Explora el pasaporte digital de un simulacro académico con datos ficticios.</p>
        <button className="boton" type="button" onClick={() => navegar(RUTAS['demo-pasaporte'])}>
          Probar Pasaporte Digital QR
        </button>
      </section>
      <BandejaPublicaLive />
      {import.meta.env.DEV ? <DemoQRLocal /> : null}
    </>
  );
}