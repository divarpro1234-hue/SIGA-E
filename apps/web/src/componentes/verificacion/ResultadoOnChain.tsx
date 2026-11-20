// Componente modular: Comprobación on-chain (Stellar Testnet / Soroban)
// INVARIANTE (ADR-005 / ENM-002): La PWA ciudadana NUNCA consulta Soroban en el navegador.
// Su conclusión técnica es siempre NO_COMPROBABLE en este dispositivo.
// Los metadatos de backend no constituyen evidencia confirmada soberanamente.
import { Icono } from '../Icono';

interface Props {
  sinConexion?: boolean;
}

export function ResultadoOnChain({ sinConexion }: Props) {
  return (
    <div className="dim dim-neutro" role="group" aria-label="Comprobación en Blockchain">
      <p className="dim-num">Dimensión 4 · Registro Soroban Testnet</p>
      <p className="dim-estado">
        <Icono nombre="dash" clase="ico ico-enorme" />
        <span>No comprobable localmente</span>
      </p>
      <p>
        Esta aplicación cliente no realiza consultas directas al contrato inteligente Soroban.
        La ausencia de comprobación no invalida la firma criptográfica local ni certifica el anclaje.
      </p>
      <p className="dim-nota-tecnica">
        Para una verificación independiente y soberana del anclaje on-chain (contrato <code>AlertRegistry</code>),
        utiliza la herramienta notarial de línea de comandos: <code>siga-e-cli verify &lt;archivo.jws&gt;</code>.
        {sinConexion ? ' (Dispositivo actualmente sin conexión)' : ''}
      </p>
    </div>
  );
}
