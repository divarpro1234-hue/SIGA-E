import { useEffect, useRef, useState } from 'react';
import { useEnLinea } from './app/conexion';
import { navegar, useRuta } from './app/ruta';
import { esRutaInterna, redireccion, resolverRuta, tituloDocumento, TITULOS } from './app/router.mjs';
import { useResultado } from './app/verificacion';
import { AvisoActualizacion } from './componentes/AvisoActualizacion';
import { Cabecera, type PestanaActiva } from './componentes/Cabecera';
import { Inicio } from './pantallas/Inicio';
import { NoExiste } from './pantallas/NoExiste';
import { Resultado } from './pantallas/Resultado';
import { Verificar } from './pantallas/Verificar';
import { PasaporteAlerta } from './publico/PasaporteAlerta';
import { PasaporteDemo } from './publico/PasaporteDemo';
import { AppInterna } from './interno/AppInterna';
import { useDesafio } from './interno/sesion';

const PESTANA: Record<string, PestanaActiva> = { inicio: 'inicio', verificar: 'verificar', resultado: 'verificar' };

export function App() {
  const ruta = useRuta();
  const enLinea = useEnLinea();
  const resultado = useResultado();
  const desafio = useDesafio();

  // Resultado sin resultado en memoria vuelve a Verificar; el código TOTP sin desafío, al acceso.
  const destino = redireccion(ruta.nombre, resultado !== null, desafio !== null);
  useEffect(() => {
    if (destino) navegar(destino, { reemplazar: true });
  }, [destino]);
  // Mientras se aplica la redirección se dibuja ya la pantalla de destino.
  const nombre = destino === null ? ruta.nombre : resolverRuta(destino).nombre;

  // Accesibilidad en cada cambio de ruta: título, foco al h1 y anuncio en región viva.
  const [anuncio, setAnuncio] = useState('');
  const previa = useRef<string | null>(null);
  useEffect(() => {
    document.title = tituloDocumento(nombre);
    if (previa.current !== null && previa.current !== nombre) {
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>('main h1')?.focus();
      setAnuncio(`Pantalla: ${TITULOS[nombre]}`);
    }
    previa.current = nombre;
  }, [nombre]);

  // Portal interno: cabecera y disposición propias; el portal ciudadano no cambia.
  if (esRutaInterna(nombre)) {
    return (
      <>
        <AppInterna nombre={nombre} />
        <p className="sr-only" role="status" aria-live="polite">
          {anuncio}
        </p>
      </>
    );
  }

  return (
    <>
      <Cabecera activa={PESTANA[nombre] ?? null} enLinea={enLinea} ultimaSync={null} />
      <AvisoActualizacion />
      <main className="pantalla" id="contenido">
        {nombre === 'inicio' ? <Inicio /> : null}
        {nombre === 'verificar' ? <Verificar /> : null}
        {nombre === 'resultado' ? <Resultado /> : null}
        {nombre === 'pasaporte' ? <PasaporteAlerta id={ruta.id ?? ''} /> : null}
        {nombre === 'demo-pasaporte' ? <PasaporteDemo /> : null}
        {nombre === 'no-existe' ? <NoExiste /> : null}
      </main>
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </>
  );
}
