// Lista de casos de demostración en Verificar (solo desarrollo). Llama al adaptador con a–h.
import { useId, useState } from 'react';
import { RUTAS } from '../app/router.mjs';
import { navegar } from '../app/ruta';
import { ejecutarVerificacion } from '../app/verificacion';
import { CASOS_DEMO, type ClaveCaso } from './datos-demo';
import { verificadorDemo } from './verificador-demo';
import './demo.css';

const CLAVES = Object.keys(CASOS_DEMO) as ClaveCaso[];

export default function CasosDemo() {
  const id = useId();
  const [error, setError] = useState<string | null>(null);

  const elegir = async (clave: ClaveCaso) => {
    setError(null);
    const salida = await ejecutarVerificacion(clave, verificadorDemo);
    if (salida.ok) navegar(RUTAS.resultado);
    else setError(salida.mensaje);
  };

  return (
    <section className="demo-hero" aria-labelledby={id} style={{ marginTop: '24px' }}>
      <div className="demo-tag-ambiente">
        <span className="demo-tag-dot" aria-hidden="true" />
        <span>FIXTURES DE PRUEBA · ADAPTADOR DEMO</span>
      </div>
      <h2 id={id} className="demo-titulo" style={{ fontSize: '1.25rem' }}>
        Probar casos de verificación predefinidos
      </h2>
      <p className="demo-subtitulo">
        Estos botones muestran resultados fijos de prueba. No ejecutan WebCrypto ni verifican un JWS; cada
        resultado se identifica como simulación y no demuestra la firma, vigencia o identidad de un mensaje.
      </p>
      <ul className="demo-lista" aria-label="Casos de demostración">
        {CLAVES.map((clave) => (
          <li key={clave}>
            <button type="button" className="demo-caso" onClick={() => void elegir(clave)}>
              <span className="id" style={{ color: 'var(--c-acento-cian)' }}>[{clave}]</span>
              <span>{CASOS_DEMO[clave].nombre}</span>
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="aviso-error" style={{ marginTop: '12px' }}>{error}</p> : null}
    </section>
  );
}
