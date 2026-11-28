import { useState } from 'react';
import { navegar } from '../app/ruta';
import { NoExiste } from '../pantallas/NoExiste';
import { Titulo } from '../componentes/Titulo';
import { ImagenCodigoQR } from './ImagenCodigoQR';
import {
  construirUrlPasaporteDemo,
  copiarEnlacePasaporteDemo,
  obtenerPasaporteDemo,
} from './pasaporte-demo.mjs';
import './publico.css';

interface Props {
  slug: string;
}

export function PasaporteDemoIndividual({ slug }: Props) {
  const pasaporte = obtenerPasaporteDemo(slug);
  const [estadoAccion, setEstadoAccion] = useState('');

  if (!pasaporte) return <NoExiste />;

  let enlace: string | null = null;
  try {
    enlace = construirUrlPasaporteDemo(slug, window.location.origin, import.meta.env.PROD);
  } catch {
    enlace = null;
  }

  const copiar = async () => {
    if (!enlace) return;
    try {
      await copiarEnlacePasaporteDemo(enlace, window.location.origin, slug, navigator.clipboard, import.meta.env.PROD);
      setEstadoAccion('Enlace copiado.');
    } catch {
      setEstadoAccion('No se pudo copiar el enlace.');
    }
  };

  return (
    <>
      <Titulo>{pasaporte.titulo}</Titulo>
      <p className="demo-pasaporte-aviso" role="note">
        DEMOSTRACIÓN ACADÉMICA. DATOS FICTICIOS. Este registro no corresponde a una alerta publicada, firmada ni anclada.
      </p>
      <section className="live-seccion demo-pasaporte-seccion" aria-labelledby="demo-pasaporte-individual-titulo">
        <h2 id="demo-pasaporte-individual-titulo">Pasaporte del simulacro</h2>
        <dl className="pasaporte-datos">
          <dt>Identificador</dt><dd>{pasaporte.identificador}</dd>
          <dt>Título</dt><dd>{pasaporte.titulo}</dd>
          <dt>Severidad</dt><dd>{pasaporte.severidad}</dd>
          <dt>Área</dt><dd>{pasaporte.area}</dd>
          <dt>Descripción</dt><dd>{pasaporte.descripcion}</dd>
          <dt>Estado</dt><dd>{pasaporte.estado}</dd>
          <dt>Firma digital</dt><dd>{pasaporte.firmaDigital}</dd>
          <dt>Anclaje blockchain</dt><dd>{pasaporte.anclajeBlockchain}</dd>
        </dl>
      </section>
      <section className="live-seccion demo-pasaporte-seccion" aria-labelledby="demo-pasaporte-qr-titulo">
        <h2 id="demo-pasaporte-qr-titulo">Código QR individual</h2>
        {enlace ? (
          <>
            <div className="qr-imagen">
              <ImagenCodigoQR value={enlace} title={`Código QR del pasaporte ficticio ${pasaporte.identificador}`} />
            </div>
            <a className="qr-enlace" href={enlace} target="_blank" rel="noopener noreferrer">{enlace}</a>
            <p className="demo-pasaporte-aviso" role="note">SIN FIRMA DIGITAL NI ANCLAJE BLOCKCHAIN.</p>
            <div className="qr-acciones">
              <button className="boton" type="button" onClick={() => void copiar()}>Copiar enlace</button>
              <a className="boton boton-enlace" href={enlace} target="_blank" rel="noopener noreferrer">
                Abrir enlace
              </a>
              <button className="boton" type="button" onClick={() => navegar('/')}>Volver a la bandeja pública</button>
            </div>
          </>
        ) : <p className="live-error" role="alert">No se pudo validar el origen HTTPS de SIGA-E.</p>}
        <p className="qr-estado-copia" role="status" aria-live="polite">{estadoAccion}</p>
      </section>
    </>
  );
}
