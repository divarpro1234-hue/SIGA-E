import { fechaUtc } from '../lib/fechas';
import { Icono } from './Icono';

export function AvisoConexion({ ultimaSync }: { ultimaSync: string | null }) {
  const desde = ultimaSync ? ` desde ${fechaUtc(ultimaSync)}` : '';
  return (
    <p className="aviso aviso-conexion">
      <Icono nombre="offline" />
      <span>{`Sin conexión: la vigencia usa el reloj de este dispositivo y no se conocen cambios${desde}.`}</span>
    </p>
  );
}
