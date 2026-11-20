// SIGA-E SIGNATURE — AppShell del portal interno (F3).
// Envuelve toda la interfaz del portal con el tema dark y el layout de dos columnas
// (Sidebar + Main). Es el único lugar que importa signature.css.
// No crea sesión ni gestiona autenticación: eso sigue en AppInterna.tsx.

import '../../styles/signature.css';
import { type ReactNode } from 'react';

interface AppShellProps {
  sidebar: ReactNode;
  topbar: ReactNode;
  demoBanner?: ReactNode;
  mobileTabs?: ReactNode;
  workspace: ReactNode;
  drawerOpen: boolean;
  onBackdropClick: () => void;
}

export function AppShell({
  sidebar,
  topbar,
  demoBanner,
  mobileTabs,
  workspace,
  drawerOpen,
  onBackdropClick,
}: AppShellProps) {
  return (
    <div className="sig-theme">
      {/* Backdrop del drawer móvil */}
      <div
        className={`sig-drawer-backdrop${drawerOpen ? ' sig-open' : ''}`}
        aria-hidden="true"
        onClick={onBackdropClick}
      />
      <div className="sig-app-shell">
        {sidebar}
        <div className="sig-main-container">
          {topbar}
          {demoBanner}
          {mobileTabs}
          {workspace}
        </div>
      </div>
    </div>
  );
}
