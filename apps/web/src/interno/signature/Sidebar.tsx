// SIGA-E SIGNATURE — Sidebar del portal interno (F3).
// Navegación lateral inspirada en Obsidian Dashboard.
// Los ítems de módulos no implementados se muestran deshabilitados visualmente,
// con la nota "No disponible en este MVP" en aria-label.
// El rol del usuario lo determina el servidor; este componente solo dibuja
// qué secciones corresponden al rol recibido como prop.

import type { ReactNode } from 'react';
import type { Rol } from '../roles.mjs';

interface NavItem {
  id: string;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  badge?: number | string;
  disabled?: boolean;
  icon: ReactNode;
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  nombreUsuario: string;
  rol: Rol;
  /** Letras del avatar (máximo 2). */
  iniciales: string;
}

function IconBandeja() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function IconAprobacion() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function IconTrazabilidad() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconStellar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function IconAuditoria() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function SigLogoIcon() {
  return (
    <div className="sig-logo-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}

const ROL_LABEL: Record<Rol, string> = {
  AUTHOR: 'AUTHOR · Autoría',
  APPROVER: 'APPROVER · Aprobación',
  ADMIN: 'ADMIN · Administración',
};

export function Sidebar({ open, onClose, nombreUsuario, rol, iniciales }: SidebarProps) {
  // Ítems del módulo de seguridad: visibles siempre, deshabilitados si no corresponden al rol
  const itemsSeguridad: NavItem[] = [
    {
      id: 'bandeja',
      label: 'Bandeja Operativa',
      href: '/interno/alertas',
      active: true,
      icon: <IconBandeja />,
      disabled: false,
    },
    {
      id: 'aprobacion',
      label: 'Mesa de Aprobación',
      href: '/interno/revision',
      icon: <IconAprobacion />,
      disabled: rol !== 'APPROVER',
    },
    {
      id: 'trazabilidad',
      label: 'Trazabilidad Cripto',
      icon: <IconTrazabilidad />,
      disabled: true,
    },
  ];

  const itemsInfraestructura: NavItem[] = [
    {
      id: 'stellar',
      label: 'Registro Stellar Testnet',
      icon: <IconStellar />,
      disabled: true,
    },
    {
      id: 'auditoria',
      label: 'Cadena de Auditoría',
      href: '/interno/administracion',
      icon: <IconAuditoria />,
      disabled: rol !== 'ADMIN',
    },
  ];

  return (
    <aside
      className={`sig-sidebar${open ? ' sig-sidebar-open' : ''}`}
      aria-label="Navegación del portal SIGA-E"
    >
      {/* Marca */}
      <div className="sig-sidebar-brand">
        <SigLogoIcon />
        <div className="sig-brand-text">
          SIGA-E
          <span className="sig-brand-sub">SIGNATURE // EVOLUTION</span>
        </div>
        <span className="sig-badge-simulacro">SIMULACRO</span>
        <button
          type="button"
          className="sig-sidebar-close"
          onClick={onClose}
          aria-label="Cerrar navegación"
        >
          ✕
        </button>
      </div>

      {/* Navegación */}
      <nav className="sig-nav" aria-label="Módulos del portal">
        <span className="sig-nav-category">Módulos de Seguridad</span>
        {itemsSeguridad.map((item) => (
          <NavLink key={item.id} item={item} />
        ))}

        <span className="sig-nav-category" style={{ marginTop: '14px' }}>Infraestructura</span>
        {itemsInfraestructura.map((item) => (
          <NavLink key={item.id} item={item} />
        ))}
      </nav>

      {/* Sesión del operador */}
      <div className="sig-sidebar-footer" aria-label="Sesión activa">
        <div className="sig-user-card">
          <div className="sig-user-avatar" aria-hidden="true">{iniciales}</div>
          <div className="sig-user-info">
            <span className="sig-user-name">{nombreUsuario}</span>
            <span className="sig-user-role">
              <span className="sig-mfa-dot" aria-hidden="true" />
              {ROL_LABEL[rol]}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const classBase = 'sig-nav-item';
  const classActive = item.active ? ' sig-nav-active' : '';
  const classDisabled = item.disabled ? ' sig-nav-disabled' : '';
  const className = `${classBase}${classActive}${classDisabled}`;

  const ariaLabel = item.disabled
    ? `${item.label} (no disponible en este MVP)`
    : item.label;

  const inner = (
    <>
      <span className="sig-nav-icon">{item.icon}</span>
      <span>{item.label}</span>
      {item.badge != null && <span className="sig-nav-badge">{item.badge}</span>}
    </>
  );

  if (item.href && !item.disabled) {
    return (
      <a
        href={item.href}
        className={className}
        aria-current={item.active ? 'page' : undefined}
        aria-label={ariaLabel}
      >
        {inner}
      </a>
    );
  }

  return (
    <span
      className={className}
      role="link"
      aria-disabled="true"
      aria-label={ariaLabel}
      tabIndex={item.disabled ? -1 : 0}
    >
      {inner}
    </span>
  );
}
