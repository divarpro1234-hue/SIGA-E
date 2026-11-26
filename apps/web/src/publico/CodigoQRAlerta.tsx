import { useLayoutEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { AlertaPublica } from './cliente-publico';
import {
  abrirDialogoQr,
  abrirPasaporteDesdeQr,
  cerrarDialogoQr,
  copiarEnlacePasaporte,
  restaurarFocoQr,
} from './pasaporte-qr.mjs';

interface Props {
  alerta: Pick<AlertaPublica, 'id' | 'identifier'>;
  enlace: string;
  origen: string;
  disparador: HTMLButtonElement | null;
  onCerrar: () => void;
  onAbrirPasaporte: (ruta: string) => void;
}

export function CodigoQRAlerta({ alerta, enlace, origen, disparador, onCerrar, onAbrirPasaporte }: Props) {
  const dialogoRef = useRef<HTMLDialogElement>(null);
  const botonCerrarRef = useRef<HTMLButtonElement>(null);
  const restaurarFoco = useRef(true);
  const [estadoCopia, setEstadoCopia] = useState('');

  useLayoutEffect(() => {
    const dialogo = dialogoRef.current;
    const botonCerrar = botonCerrarRef.current;
    if (dialogo && botonCerrar) abrirDialogoQr(dialogo, botonCerrar);
    // StrictMode replays effect cleanup/setup on mount; closing here fires onClose and clears parent state.
  }, []);

  const cerrar = () => {
    const dialogo = dialogoRef.current;
    if (dialogo) cerrarDialogoQr(dialogo, onCerrar, disparador);
    else onCerrar();
  };

  const alCerrarDialogo = () => {
    onCerrar();
    if (restaurarFoco.current) restaurarFocoQr(disparador);
  };

  const abrirPasaporte = () => {
    restaurarFoco.current = false;
    abrirPasaporteDesdeQr(
      alerta.id,
      () => {
        if (dialogoRef.current) cerrarDialogoQr(dialogoRef.current);
        onCerrar();
      },
      onAbrirPasaporte,
    );
  };

  const copiar = async () => {
    setEstadoCopia('');
    try {
      await copiarEnlacePasaporte(enlace, origen, navigator.clipboard);
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
      aria-labelledby="qr-dialogo-titulo"
      aria-describedby="qr-dialogo-descripcion"
      onClose={alCerrarDialogo}
    >
      <div className="qr-dialogo-cabecera">
        <h2 id="qr-dialogo-titulo">Pasaporte Digital SIGA-E</h2>
        <button ref={botonCerrarRef} className="qr-boton-cerrar" type="button" onClick={cerrar}>
          Cerrar
        </button>
      </div>
      <p className="qr-simulacro" id="qr-dialogo-descripcion">SIMULACRO ACADÉMICO</p>
      <p className="qr-identificador">Alerta: <strong>{alerta.identifier}</strong></p>
      <div className="qr-imagen">
        <QRCodeSVG
          value={enlace}
          size={240}
          level="M"
          includeMargin
          bgColor="#ffffff"
          fgColor="#111827"
          title={`Código QR del pasaporte público de ${alerta.identifier}`}
        />
      </div>
      <p className="qr-enlace-rotulo">Enlace público</p>
      <a className="qr-enlace" href={enlace} target="_blank" rel="noopener noreferrer">
        {enlace}
      </a>
      <p className="live-nota">El QR solo abre la página pública de consulta. No es una firma digital ni evidencia blockchain.</p>
      <div className="qr-acciones">
        <button className="boton" type="button" onClick={() => void copiar()}>Copiar enlace</button>
        <button className="boton boton-enlace" type="button" onClick={abrirPasaporte}>Abrir pasaporte</button>
      </div>
      <p className="qr-estado-copia" role="status" aria-live="polite">{estadoCopia}</p>
    </dialog>
  );
}
