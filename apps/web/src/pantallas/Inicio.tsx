import { TITULOS } from '../app/router.mjs';
import { Titulo } from '../componentes/Titulo';
import { BandejaPublicaLive } from '../publico/BandejaPublicaLive';

export function Inicio() {
  return (
    <>
      <Titulo>{TITULOS.inicio}</Titulo>
      <BandejaPublicaLive />
    </>
  );
}