import { useState } from 'react';
import { navegar } from '../app/ruta';
import { Titulo } from '../componentes/Titulo';
import { ImagenCodigoQR } from './ImagenCodigoQR';
import {
  copiarEnlaceDemoPasaporte,
  construirUrlDemoPasaporte,
  PASAPORTE_DEMO,
} from './pasaporte-demo.mjs';
import './publico.css';

type EstadoEnlace = { url: string; error: null } | { url: null; error: string };

function crearEnlace(): EstadoEnlace {
  try {
    return { url: construirUrlDemoPasaporte(window.location.origin, import.meta.env.PROD), error: null };
  } catch {
    return { url: null, error: 'El pasaporte requiere el origen HTTPS público de SIGA-E.' };
  }
}

export function PasaporteDemo() {
  const [enlace] = useState(crearEnlace);
  const [estadoAccion, setEstadoAccion] = useState('');

  const copiar = async () => {
    if (!enlace.url) return;
    try {
      await copiarEnlaceDemoPasaporte(enlace.url, window.location.origin, navigator.clipboard, import.meta.env.PROD);
      setEstadoAccion('Enlace copiado.');
    } catch {
      setEstadoAccion('No se pudo copiar el enlace.');
    }
  };

  const abrir = () => {
    if (!enlace.url) return;
    window.open(enlace.url, '_blank', 'noopener,noreferrer');
    setEstadoAccion('Se solicitó abrir el enlace en otra pestaña.');
  };

  return (
    <>
      <Titulo>Pasaporte Digital SIGA-E</Titulo>
      <p className="demo-pasaporte-aviso" role="note">DEMOSTRACIÓN ACADÉMICA — DATOS FICTICIOS</p>
      <section className="live-seccion demo-pasaporte-seccion" aria-labelledby="demo-pasaporte-titulo">
        <h2 id="demo-pasaporte-titulo">Información del simulacro</h2>
        <dl className="pasaporte-datos">
          <dt>Identificador</dt><dd>{PASAPORTE_DEMO.identificador}</dd>
          <dt>Título</dt><dd>{PASAPORTE_DEMO.titulo}</dd>
          <dt>Tipo</dt><dd>{PASAPORTE_DEMO.tipo}</dd>
          <dt>Severidad</dt><dd>{PASAPORTE_DEMO.severidad}</dd>
          <dt>Área</dt><dd>{PASAPORTE_DEMO.area}</dd>
          <dt>Estado</dt><dd>{PASAPORTE_DEMO.estado}</dd>
          <dt>Firma digital</dt><dd>{PASAPORTE_DEMO.firmaDigital}</dd>
          <dt>Anclaje blockchain</dt><dd>{PASAPORTE_DEMO.anclajeBlockchain}</dd>
        </dl>
      </section>

      <section className="live-seccion demo-pasaporte-seccion" aria-labelledby="demo-pasaporte-qr">
        <h2 id="demo-pasaporte-qr">Enlace público de demostración</h2>
        {enlace.url ? (
          <>
            <div className="qr-imagen">
              <ImagenCodigoQR value={enlace.url} title="Código QR del pasaporte ficticio de demostración" />
            </div>
            <a className="qr-enlace" href={enlace.url} target="_blank" rel="noopener noreferrer">{enlace.url}</a>
          </>
        ) : <p className="live-error" role="alert">{enlace.error}</p>}
        <p className="demo-pasaporte-aviso" role="note">
          SIN FIRMA DIGITAL NI ANCLAJE BLOCKCHAIN. Este registro es ficticio y no está publicado en la API.
        </p>
        <div className="qr-acciones">
          <button className="boton" type="button" onClick={() => void copiar()} disabled={!enlace.url}>Copiar enlace</button>
          <button className="boton boton-enlace" type="button" onClick={abrir} disabled={!enlace.url}>Abrir enlace</button>
          <button className="boton" type="button" onClick={() => navegar('/')}>Volver a la bandeja pública</button>
        </div>
        <p className="qr-estado-copia" role="status" aria-live="polite">{estadoAccion}</p>
      </section>
    </>
  );
}
