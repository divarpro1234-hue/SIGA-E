// SIGA-E SIGNATURE — Topbar del portal interno (F3).
// Barra superior inspirada en Nova Control Panel.
// Incluye botón hamburguesa, breadcrumb, buscador y badge SIMULACRO.
// NO muestra telemetría Stellar como dato en vivo: está removida por restricción de seguridad F3.

interface TopbarProps {
  seccionActual: string;
  busqueda: string;
  onBusquedaChange: (v: string) => void;
  onMenuClick: () => void;
}

function IconMenu() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function Topbar({ seccionActual, busqueda, onBusquedaChange, onMenuClick }: TopbarProps) {
  return (
    <header className="sig-topbar" role="banner">
      {/* Botón hamburguesa (visible en móvil) */}
      <button
        type="button"
        className="sig-btn-menu"
        onClick={onMenuClick}
        aria-label="Abrir menú de navegación"
        aria-expanded={false}
      >
        <IconMenu />
      </button>

      {/* Breadcrumb */}
      <nav className="sig-breadcrumb" aria-label="Ubicación actual">
        <span>SIGA-E</span>
        <span className="sig-breadcrumb-sep" aria-hidden="true">/</span>
        <span>SIGNATURE</span>
        <span className="sig-breadcrumb-sep" aria-hidden="true">/</span>
        <strong className="sig-breadcrumb-current">{seccionActual}</strong>
      </nav>

      {/* Buscador */}
      <div className="sig-search-wrap" role="search">
        <span className="sig-search-icon">
          <IconSearch />
        </span>
        <label className="sr-only" htmlFor="sig-search">
          Filtrar alertas por ID, título o estado
        </label>
        <input
          id="sig-search"
          type="search"
          className="sig-search-input"
          placeholder="Filtrar por ID, título o estado..."
          value={busqueda}
          onChange={(e) => onBusquedaChange(e.target.value)}
          autoComplete="off"
        />
        <span className="sig-search-kbd" aria-hidden="true">Ctrl+K</span>
      </div>

      {/* Zona derecha: solo badge SIMULACRO */}
      <div className="sig-topbar-right">
        <span className="sig-badge-sim-topbar" role="note" aria-label="Entorno de simulacro">
          SIMULACRO
        </span>
      </div>
    </header>
  );
}
