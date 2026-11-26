import { useRef, useState } from 'react';
import { navegar } from '../app/ruta';
import { CodigoQRAlerta } from './CodigoQRAlerta';
import { construirUrlPasaporte } from './pasaporte-qr.mjs';
import './publico.css';

const ALERTA_DEMO_LOCAL = {
  id: 'f64f36e4-73aa-4f3d-b487-cf2a13f2a7b9',
  identifier: 'DEMO-LOCAL-QR-0001',
};

export function DemoQRLocal() {
  const [qr, setQr] = useState<{ enlace: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disparador = useRef<HTMLButtonElement | null>(null);

  if (!import.meta.env.DEV) return null;

  const mostrarQr = (boton: HTMLButtonElement) => {
    setError(null);
    try {
      setQr({ enlace: construirUrlPasaporte(ALERTA_DEMO_LOCAL.id, window.location.origin) });
      disparador.current = boton;
    } catch {
      setError('El QR local requiere HTTPS o un origen localhost de desarrollo.');
    }
  };

  return (
    <>
      <section className="live-seccion demo-qr-local" aria-labelledby="demo-qr-titulo">
        <p className="live-etiqueta">MODO DE DESARROLLO · SIN API</p>
        <h2 id="demo-qr-titulo">Laboratorio M7 — Pasaporte Digital</h2>
        <p className="demo-qr-aviso" role="note">DEMO LOCAL — DATOS FICTICIOS</p>
        <p>UUID sintético de prueba: <code>{ALERTA_DEMO_LOCAL.id}</code></p>
        <p className="live-nota">
          Este QR solo demuestra cómo codificar el enlace. No acredita publicación, firma digital ni anclaje.
          El identificador no existe en el backend público: si abres el pasaporte con la API disponible, devolverá 404.
          Sin backend, la consulta mostrará un error de conexión, no un fallo del QR.
        </p>
        <p className="live-nota">
          Si ejecutas Vite en localhost, el QR no será accesible automáticamente desde otro teléfono:
          localhost apunta al propio dispositivo que escanea.
        </p>
        <button
          className="boton"
          type="button"
          onClick={(event) => mostrarQr(event.currentTarget)}
          aria-label="Ver código QR de demostración local"
        >
          Ver código QR
        </button>
        {error ? <p className="live-error" role="alert">{error}</p> : null}
      </section>
      {qr ? (
        <CodigoQRAlerta
          alerta={ALERTA_DEMO_LOCAL}
          enlace={qr.enlace}
          origen={window.location.origin}
          disparador={disparador.current}
          onCerrar={() => setQr(null)}
          onAbrirPasaporte={(ruta) => navegar(ruta)}
        />
      ) : null}
    </>
  );
}
