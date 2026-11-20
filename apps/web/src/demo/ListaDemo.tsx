// Lista de Inicio con datos de demostración (solo desarrollo). Abre el resultado por el adaptador demo.
import { Suspense, useId, useState, type MouseEvent } from 'react';
import { BandejaDemo } from '../app/demo-lazy';
import { RUTAS } from '../app/router.mjs';
import { navegar } from '../app/ruta';
import { ejecutarVerificacion } from '../app/verificacion';
import { BloqueLista } from '../componentes/BloqueLista';
import { LISTA_DEMO, type ClaveCaso } from './datos-demo';
import { verificadorDemo } from './verificador-demo';
import './demo.css';

export default function ListaDemo() {
  const id = useId();
  const [filtro, setFiltro] = useState('');
  const [mostrarBandejaDemo, setMostrarBandejaDemo] = useState(false);

  const abrir = (e: MouseEvent<HTMLAnchorElement>, caso: ClaveCaso) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void ejecutarVerificacion(caso, verificadorDemo).then((salida) => {
      if (salida.ok) navegar(RUTAS.resultado);
    });
  };

  const listaFiltrada = LISTA_DEMO.filter(({ item }) => {
    if (!filtro) return true;
    const term = filtro.toLowerCase();
    return (
      item.identifier.toLowerCase().includes(term) ||
      (item.titular && item.titular.toLowerCase().includes(term)) ||
      (item.severidad && item.severidad.toLowerCase().includes(term))
    );
  });

  return (
    <section className="demo-seccion" aria-labelledby={id}>
      <div className="demo-hero-compacto">
        <div className="demo-banner-aviso demo-banner-compacto" role="note">
          <div className="demo-banner-cabecera">
            <span className="simulacro">SIMULACRO</span>
            <span className="demo-banner-texto">
              Ambiente de demostración técnica (F1/F2). Casos de prueba controlados para evaluar verificación local WebCrypto.
            </span>
          </div>
          {BandejaDemo && (
            <button
              type="button"
              className="demo-btn-inline"
              onClick={() => setMostrarBandejaDemo((prev) => !prev)}
            >
              {mostrarBandejaDemo ? '✕ Ocultar Bandeja F3' : '🔍 Probar Bandeja F3 [DEV]'}
            </button>
          )}
        </div>
      </div>

      {mostrarBandejaDemo && BandejaDemo && (
        <Suspense fallback={<p style={{ padding: '16px', color: '#94a3b8' }}>Cargando explorador visual...</p>}>
          <BandejaDemo onCerrar={() => setMostrarBandejaDemo(false)} />
        </Suspense>
      )}

      <div className="demo-controles">
        <div className="demo-search-wrap">
          <svg className="demo-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            className="demo-search-input"
            placeholder="Filtrar por identificador (ej: SIGA-E-2026-0001), severidad o texto..."
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            aria-label="Filtrar alertas públicas"
          />
          <span className="demo-conteo-badge">{listaFiltrada.length} alertas</span>
        </div>
      </div>

      <ul className="bloques" aria-label="Lista de alertas de demostración">
        {listaFiltrada.map(({ item, caso }) => (
          <li key={item.identifier}>
            <BloqueLista item={item} href={RUTAS.resultado} alPulsar={(e) => abrir(e, caso)} />
          </li>
        ))}
        {listaFiltrada.length === 0 && (
          <li className="demo-vacio">
            No se encontraron alertas ciudadanas que coincidan con &ldquo;{filtro}&rdquo;.
          </li>
        )}
      </ul>
    </section>
  );
}
