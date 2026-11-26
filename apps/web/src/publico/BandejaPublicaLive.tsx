import { useEffect, useState } from 'react';
import { navegar } from '../app/ruta';
import { RUTAS } from '../app/router.mjs';
import { ejecutarVerificacion } from '../app/verificacion';
import { verificadorLocal } from '../adaptadores/verificador-local';
import { EstadoCarga, EstadoError, EstadoVacio } from '../interno/signature/Componentes';
import { listarAlertasPublicas, obtenerAlertaPublica, type AlertaPublica } from './cliente-publico';
import './publico.css';

function mensajeFallo(motivo: 'no-encontrada' | 'no-disponible' | 'error' | 'respuesta-invalida'): string {
  if (motivo === 'no-encontrada') return 'La alerta no se encontró. Puede no estar publicada o ya no estar disponible.';
  if (motivo === 'no-disponible') return 'Servicio público no disponible. No se mostrarán datos DEMO como sustituto.';
  if (motivo === 'respuesta-invalida') return 'La API devolvió una respuesta no válida. No se mostrarán alertas sin forma verificable.';
  return 'No fue posible consultar el servicio público. No se mostrarán datos DEMO como sustituto.';
}

export function BandejaPublicaLive() {
  const [estado, setEstado] = useState<'cargando' | 'lista' | 'vacia' | 'error'>('cargando');
  const [alertas, setAlertas] = useState<AlertaPublica[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState<string | null>(null);

  const cargar = async () => {
    setEstado('cargando');
    setError(null);
    const resultado = await listarAlertasPublicas();
    if (!resultado.ok) {
      setEstado('error');
      setError(mensajeFallo(resultado.motivo));
      return;
    }
    setAlertas(resultado.items);
    setEstado(resultado.items.length === 0 ? 'vacia' : 'lista');
  };

  useEffect(() => {
    void cargar();
  }, []);

  const abrir = async (alerta: AlertaPublica) => {
    if (abriendo) return;
    setAbriendo(alerta.id);
    setError(null);
    const detalle = await obtenerAlertaPublica(alerta.id);
    if (!detalle.ok) {
      setAbriendo(null);
      setError(mensajeFallo(detalle.motivo));
      return;
    }
    const verificacion = await ejecutarVerificacion(detalle.detalle.jwsCompact, verificadorLocal);
    setAbriendo(null);
    if (!verificacion.ok) {
      setError(`No se pudo verificar localmente el JWS de ${alerta.identifier}. La alerta no se marcará como firma válida.`);
      return;
    }
    navegar(RUTAS.resultado);
  };

  return (
    <section className="live-seccion" aria-labelledby="alertas-live-titulo">
      <div className="live-cabecera">
        <div>
          <p className="live-etiqueta">DATOS LIVE · API SIGA-E</p>
          <h2 id="alertas-live-titulo">Alertas publicadas</h2>
        </div>
        <span className="simulacro">SIMULACRO</span>
      </div>
      <p className="live-nota">
        Solo se muestran alertas que la API confirmó como publicadas tras firma y anclaje. La PWA no consulta Stellar directamente.
      </p>
      {estado === 'cargando' ? <EstadoCarga texto="Consultando alertas publicadas en la API…" /> : null}
      {estado === 'error' && error ? <EstadoError mensaje={error} onReintentar={() => void cargar()} /> : null}
      {estado === 'vacia' ? <EstadoVacio mensaje="La API no tiene alertas publicadas disponibles." /> : null}
      {estado === 'lista' ? (
        <ul className="live-lista" aria-label="Alertas publicadas desde la API">
          {alertas.map((alerta) => (
            <li key={alerta.id}>
              <button type="button" className="live-tarjeta" onClick={() => void abrir(alerta)} disabled={abriendo !== null}>
                <span className="live-tarjeta-cabecera">
                  <span className="live-estado">PUBLICADA</span>
                  <span className="id">{alerta.identifier}</span>
                </span>
                <span className="live-tarjeta-pie">
                  <span>Firma: pendiente de verificación local</span>
                  <span>{abriendo === alerta.id ? 'Verificando…' : 'Ver detalle →'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error && estado !== 'error' ? <p className="live-error" role="alert">{error}</p> : null}
    </section>
  );
}
