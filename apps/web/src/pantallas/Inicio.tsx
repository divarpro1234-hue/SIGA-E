import { TITULOS } from '../app/router.mjs';
import { Titulo } from '../componentes/Titulo';
import { BandejaPublicaLive } from '../publico/BandejaPublicaLive';
import { DemoQRLocal } from '../publico/DemoQRLocal';

export function Inicio() {
  return (
    <>
      <Titulo>{TITULOS.inicio}</Titulo>
      <BandejaPublicaLive />
      {import.meta.env.DEV ? <DemoQRLocal /> : null}
    </>
  );
}