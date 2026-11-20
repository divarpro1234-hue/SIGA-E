// SIGA-E SIGNATURE — Bandeja Operativa en Modo Demo Aislado (Solo desarrollo).
// Permite evaluar visualmente los componentes F3 sin requerir sesión activa de backend
// y SIN alterar las rutas protegidas /interno/*.
//
// GARANTÍAS DE SEGURIDAD:
// - Aislado de producción (purga automática en Vite por dead-code-elimination).
// - No conecta ni emite peticiones a endpoints de mutación reales.
// - El selector de rol aquí presente es puramente cosmético de evaluación visual.

import { useState } from 'react';
import { BandejaOperativa } from '../interno/bandeja/BandejaOperativa';
import { ALERTAS_DEMO } from '../interno/demo/alertas-demo.mjs';

interface BandejaDemoProps {
  onCerrar?: () => void;
}

export default function BandejaDemo({ onCerrar }: BandejaDemoProps) {
  const [expandido, setExpandido] = useState(true);

  if (!expandido) {
    return (
      <div style={{ margin: '16px 0', textAlign: 'center' }}>
        <button
          type="button"
          className="boton-secundario"
          onClick={() => setExpandido(true)}
        >
          👁️ Reabrir Explorador UI de Bandeja Operativa (DEMO)
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: '24px',
        border: '1px solid var(--c-borde-destacado, #9884f6)',
        borderRadius: '12px',
        overflow: 'hidden',
        background: 'var(--c-fondo, #080c14)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'rgba(152, 132, 246, 0.12)',
          borderBottom: '1px solid rgba(152, 132, 246, 0.25)',
          fontSize: '0.8125rem',
          color: '#e2e8f0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '0.6875rem',
              fontWeight: 700,
              background: '#9884f6',
              color: '#080c14',
            }}
          >
            DEMO AISLADA · SOLO DEV
          </span>
          <span>
            Explorador visual de Bandeja Operativa (F3) — Sin conexión a backend ni mutaciones reales
          </span>
        </div>
        {onCerrar && (
          <button
            type="button"
            className="boton-secundario"
            onClick={onCerrar}
            style={{ padding: '4px 12px', fontSize: '0.75rem' }}
          >
            Cerrar Explorador
          </button>
        )}
      </div>

      <div style={{ minHeight: '650px' }}>
        <BandejaOperativa
          esSesionReal={false}
          envoltorioCompleto={true}
          permitirSelectorRolDemo={true}
          fixturesDemo={ALERTAS_DEMO}
        />
      </div>
    </div>
  );
}
