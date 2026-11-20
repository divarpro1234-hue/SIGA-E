// Cabecera del portal ciudadano (SIGA-E SIGNATURE).
// Marca con emblema geométrico, SIMULACRO, telemetría de conexión y navegación rápida.
import { RUTAS } from '../app/router.mjs';
import { fechaUtc } from '../lib/fechas';
import { Enlace } from './Enlace';
import { Icono } from './Icono';

export type PestanaActiva = 'inicio' | 'verificar' | null;

interface Props {
  activa: PestanaActiva;
  enLinea: boolean;
  /** Última sincronización conocida (ISO UTC); null si todavía no hay ninguna. */
  ultimaSync: string | null;
}

function textoConexion(enLinea: boolean, ultimaSync: string | null): string {
  if (enLinea) {
    return ultimaSync ? `En línea · Sincronizado ${fechaUtc(ultimaSync)}` : 'En línea · Verificador local activo';
  }
  return ultimaSync ? `Sin conexión · Datos del ${fechaUtc(ultimaSync)}` : 'Sin conexión · Modo local PWA';
}

export function Cabecera({ activa, enLinea, ultimaSync }: Props) {
  return (
    <header className="cabecera" role="banner">
      <div className="cab-contenedor">
        <div className="cab-arriba">
          <div className="cab-marca-bloque">
            <div className="cab-logo-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <p className="marca">
                SIGA-E <span className="marca-sub">SIGNATURE // CIUDADANO</span>
              </p>
              <p className="marca-descripcion">Portal Público de Alertas y Verificación Criptográfica</p>
            </div>
          </div>

          <div className="cab-acciones-derecha">
            <span className="simulacro" role="note">SIMULACRO</span>
            <p className={enLinea ? 'conexion' : 'conexion conexion-sin'} role="status" aria-live="polite">
              <span className={`conexion-pulso ${enLinea ? 'pulso-online' : 'pulso-offline'}`} aria-hidden="true" />
              <Icono nombre={enLinea ? 'online' : 'offline'} />
              <span>{textoConexion(enLinea, ultimaSync)}</span>
            </p>
            <Enlace a={RUTAS.acceso} className="boton-portal-interno" aria-label="Ir al portal interno de operadores">
              <span>Bandeja Operativa</span>
              <span aria-hidden="true">→</span>
            </Enlace>
          </div>
        </div>

        <nav className="tabs" aria-label="Navegación principal">
          <div className="tabs-columna">
            <Enlace
              a={RUTAS.inicio}
              className={activa === 'inicio' ? 'tab tab-activa' : 'tab'}
              actual={activa === 'inicio'}
            >
              <span className="tab-indicador" aria-hidden="true" />
              <span>Bandeja Pública de Alertas</span>
            </Enlace>
            <Enlace
              a={RUTAS.verificar}
              className={activa === 'verificar' ? 'tab tab-activa' : 'tab'}
              actual={activa === 'verificar'}
            >
              <span className="tab-indicador" aria-hidden="true" />
              <span>Verificar Mensaje JWS</span>
            </Enlace>
          </div>
        </nav>
      </div>
    </header>
  );
}
