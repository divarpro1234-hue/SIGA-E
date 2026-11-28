import { useLayoutEffect, useRef, useState } from 'react';
import { ImagenCodigoQR } from './ImagenCodigoQR';
import { abrirDialogoQr, cerrarDialogoQr, restaurarFocoQr } from './pasaporte-qr.mjs';
import {
  copiarEnlacePasaporteDemo,
  esUrlPasaporteDemoSegura,
} from './pasaporte-demo.mjs';
import './publico.css';

interface PasaporteDemostrativo {
  slug: string;
  identificador: string;
  titulo: string;
}

interface Props {
  pasaporte: PasaporteDemostrativo;
  enlace: string;
  origen: string;
  produccion: boolean;
  disparador: HTMLButtonElement;
  onCerrar: () => void;
}

export function CodigoQRSimulacro({
  pasaporte,
  enlace,
  origen,
  produccion,
  disparador,
  onCerrar,
}: Props) {
  const dialogoRef = useRef<HTMLDialogElement>(null);
  const botonCerrarRef = useRef<HTMLButtonElement>(null);
  const [estadoCopia, setEstadoCopia] = useState('');
  const enlaceSeguro = esUrlPasaporteDemoSegura(enlace, origen, pasaporte.slug, produccion);

  useLayoutEffect(() => {
    const dialogo = dialogoRef.current;
    const botonCerrar = botonCerrarRef.current;
    if (dialogo && botonCerrar) abrirDialogoQr(dialogo, botonCerrar);
  }, []);

  const cerrar = () => {
    const dialogo = dialogoRef.current;
    if (dialogo) cerrarDialogoQr(dialogo, onCerrar, disparador);
    else onCerrar();
  };

  const alCerrarDialogo = () => {
    onCerrar();
    restaurarFocoQr(disparador);
  };

  const copiar = async () => {
    setEstadoCopia('');
    try {
      await copiarEnlacePasaporteDemo(enlace, origen, pasaporte.slug, navigator.clipboard, produccion);
      setEstadoCopia('Enlace copiado.');
    } catch {
      setEstadoCopia('No se pudo copiar. Puedes seleccionar y copiar el enlace mostrado.');
    }
  };

  return (
    <dialog
      ref={dialogoRef}
      className="qr-dialogo"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-simulacro-titulo"
      aria-describedby="qr-simulacro-descripcion"
      onClose={alCerrarDialogo}
      onClick={(event) => {
        if (event.target === event.currentTarget) cerrar();
      }}
    >
      <div className="qr-dialogo-cabecera">
        <h2 id="qr-simulacro-titulo">Código QR del simulacro</h2>
        <button ref={botonCerrarRef} className="qr-boton-cerrar" type="button" onClick={cerrar}>
          Cerrar
        </button>
      </div>
      <p className="qr-simulacro" id="qr-simulacro-descripcion">DEMOSTRACIÓN ACADÉMICA · DATOS FICTICIOS</p>
      <p className="qr-identificador">{pasaporte.identificador} — {pasaporte.titulo}</p>
      {enlaceSeguro ? (
        <>
          <div className="qr-imagen">
            <ImagenCodigoQR value={enlace} title={`Código QR del pasaporte ficticio ${pasaporte.identificador}`} />
          </div>
          <p className="qr-enlace-rotulo">Enlace HTTPS exclusivo de este simulacro</p>
          <a className="qr-enlace" href={enlace} target="_blank" rel="noopener noreferrer">{enlace}</a>
          <p className="live-nota">Este registro no está publicado, firmado ni anclado.</p>
          <div className="qr-acciones">
            <button className="boton" type="button" onClick={() => void copiar()}>Copiar enlace</button>
            <a className="boton boton-enlace" href={enlace} target="_blank" rel="noopener noreferrer">
              Abrir enlace
            </a>
          </div>
          <p className="qr-estado-copia" role="status" aria-live="polite">{estadoCopia}</p>
        </>
      ) : <p className="live-error" role="alert">La URL de este código QR no superó la validación de origen y ruta.</p>}
    </dialog>
  );
}
