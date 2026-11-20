import { Suspense, useState } from 'react';
import { CasosDemo } from '../app/demo-lazy';
import { navegar } from '../app/ruta';
import { RUTAS, TITULOS } from '../app/router.mjs';
import { ejecutarVerificacion } from '../app/verificacion';
import { CampoVerificar } from '../componentes/CampoVerificar';
import { Titulo } from '../componentes/Titulo';
import { ERROR_FORMA } from '../dominio/textos';
import { MAX_CARACTERES_JWS, validarFormaJws } from '../lib/forma-jws.mjs';

// Un archivo de este tamaño en bytes ya excede el máximo en caracteres, sea cual sea la codificación.
const MAX_BYTES_ARCHIVO = MAX_CARACTERES_JWS * 4;

// UTF-8 estricto y sin quitar la marca de orden de bytes: el texto del archivo llega entero al campo, y
// cualquier byte ajeno al JWS (BOM, salto de línea final) lo rechaza validarFormaJws al enviar.
const DECODIFICADOR_ARCHIVO = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Acepta un JWS compacto o un archivo de fixture `{ "jws": "..." }`. De este último se toma la cadena
 * tal cual, sin normalizarla. Cualquier otro JSON se rechaza. El texto plano se devuelve sin tocar.
 */
function extraerJws(texto: string): string | null {
  // Con BOM no se intenta leer JSON: el texto pasa entero y se rechaza por espacios, no por forma.
  if (texto.startsWith('﻿') || !texto.trimStart().startsWith('{')) return texto;
  try {
    const dato: unknown = JSON.parse(texto);
    const jws = typeof dato === 'object' && dato !== null ? (dato as Record<string, unknown>).jws : undefined;
    return typeof jws === 'string' ? jws : null;
  } catch {
    return null;
  }
}

export function Verificar() {
  const [valor, setValor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verificando, setVerificando] = useState(false);

  const enviar = async () => {
    const forma = validarFormaJws(valor);
    if (!forma.ok) {
      setError(ERROR_FORMA[forma.motivo]);
      return;
    }
    setError(null);
    setVerificando(true);
    const salida = await ejecutarVerificacion(forma.jws);
    setVerificando(false);
    if (salida.ok) navegar(RUTAS.resultado);
    else setError(salida.mensaje);
  };

  const elegirArchivo = async (archivo: File) => {
    if (archivo.size > MAX_BYTES_ARCHIVO) {
      setError(ERROR_FORMA.grande);
      return;
    }
    // El contenido del archivo es no confiable: solo se coloca en el campo; la forma se valida al enviar.
    let texto: string;
    try {
      texto = DECODIFICADOR_ARCHIVO.decode(await archivo.arrayBuffer());
    } catch {
      setError(ERROR_FORMA.caracteres);
      return;
    }
    const jws = extraerJws(texto);
    if (jws === null) {
      setError(ERROR_FORMA.segmentos);
      return;
    }
    setValor(jws);
    setError(null);
  };

  return (
    <>
      <Titulo>{TITULOS.verificar}</Titulo>
      <CampoVerificar
        valor={valor}
        alCambiar={setValor}
        alElegirArchivo={elegirArchivo}
        alEnviar={enviar}
        verificando={verificando}
        error={error}
      />
      {CasosDemo ? (
        <Suspense fallback={null}>
          <CasosDemo />
        </Suspense>
      ) : null}
    </>
  );
}
