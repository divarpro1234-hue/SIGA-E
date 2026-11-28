import { useState } from 'react';
import { navegar } from '../app/ruta';
import { CodigoQRSimulacro } from './CodigoQRSimulacro';
import {
  construirUrlPasaporteDemo,
  obtenerPasaporteDemo,
  PASAPORTES_DEMO,
  rutaPasaporteDemo,
} from './pasaporte-demo.mjs';
import './publico.css';

export function BandejaSimulacrosDemostrativos() {
  const [qr, setQr] = useState<{ slug: string; url: string; disparador: HTMLButtonElement } | null>(null);
  const [error, setError] = useState('');
  const pasaporteQr = qr ? obtenerPasaporteDemo(qr.slug) : undefined;

  const mostrarQr = (slug: string, disparador: HTMLButtonElement) => {
    setError('');
    try {
      setQr({
        slug,
        url: construirUrlPasaporteDemo(slug, window.location.origin, import.meta.env.PROD),
        disparador,
      });
    } catch {
      setError('No se pudo crear una URL HTTPS segura para el pasaporte demostrativo.');
    }
  };

  return (
    <>
      <section className="live-seccion demo-bandeja" aria-labelledby="demo-bandeja-titulo">
        <div className="live-cabecera">
          <div>
            <p className="live-etiqueta">DATOS ESTÁTICOS · SIN API</p>
            <h2 id="demo-bandeja-titulo">Bandeja de Simulacros Demostrativos</h2>
          </div>
          <span className="demo-distintivo">DEMOSTRACIÓN</span>
        </div>
        <p className="demo-bandeja-aviso" role="note">
          DEMOSTRACIÓN ACADÉMICA. Los registros de esta sección son ficticios y no corresponden a alertas publicadas,
          firmadas ni ancladas.
        </p>
        <ul className="demo-lista" aria-label="Tres simulacros demostrativos ficticios">
          {PASAPORTES_DEMO.map((simulacro) => (
            <li key={simulacro.identificador}>
              <article className="demo-tarjeta" aria-labelledby={`demo-titulo-${simulacro.slug}`}>
                <div className="demo-tarjeta-cabecera">
                  <span className="demo-distintivo">DEMOSTRACIÓN</span>
                  <span className={`demo-severidad demo-severidad-${simulacro.severidad.toLowerCase()}`}>
                    {simulacro.severidad}
                  </span>
                </div>
                <p className="demo-identificador">ID: {simulacro.identificador}</p>
                <h3 id={`demo-titulo-${simulacro.slug}`}>{simulacro.titulo}</h3>
                <p className="demo-area"><strong>Área:</strong> {simulacro.area}</p>
                <p className="demo-descripcion">{simulacro.descripcion}</p>
                <div className="demo-acciones">
                  <button
                    className="boton"
                    type="button"
                    onClick={() => navegar(rutaPasaporteDemo(simulacro.slug))}
                  >
                    Ver pasaporte
                  </button>
                  <button
                    className="boton boton-enlace"
                    type="button"
                    onClick={(event) => mostrarQr(simulacro.slug, event.currentTarget)}
                    aria-label={`Ver código QR de ${simulacro.identificador}`}
                  >
                    Ver código QR
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
        {error ? <p className="live-error" role="alert">{error}</p> : null}
      </section>
      {qr && pasaporteQr ? (
        <CodigoQRSimulacro
          pasaporte={pasaporteQr}
          enlace={qr.url}
          origen={window.location.origin}
          produccion={import.meta.env.PROD}
          disparador={qr.disparador}
          onCerrar={() => setQr(null)}
        />
      ) : null}
    </>
  );
}
