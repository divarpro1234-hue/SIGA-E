// Campo para pegar el mensaje, carga de archivo y acción. La entrada es no confiable: aquí solo se
// recoge; la validación de forma y la verificación viven fuera.
import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { nombreArchivoSeguro } from '../lib/nombre-archivo.mjs';
import { Icono } from './Icono';
import { TextoAjeno } from './TextoAjeno';

/** Máximo en grafemas del nombre mostrado; el resto se recorta con aviso. */
const MAX_GRAFEMAS_NOMBRE = 120;

interface Props {
  valor: string;
  alCambiar: (valor: string) => void;
  alElegirArchivo: (archivo: File) => void;
  alEnviar: () => void;
  verificando: boolean;
  /** Mensaje de error a mostrar, o null. */
  error: string | null;
}

export function CampoVerificar({ valor, alCambiar, alElegirArchivo, alEnviar, verificando, error }: Props) {
  const idArea = useId();
  const idArchivo = useId();
  const idAviso = useId();
  const idNombre = useId();
  // Nombre ya reducido a un nombre sin ruta; es texto ajeno y se dibuja con TextoAjeno.
  const [nombre, setNombre] = useState<string | null>(null);
  const mostrarError = !verificando && error !== null;

  const alEnviarForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!verificando) alEnviar();
  };
  const alCambiarArchivo = (e: ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    if (archivo) {
      setNombre(nombreArchivoSeguro(archivo.name));
      alElegirArchivo(archivo);
    }
    e.target.value = '';
  };

  return (
    <form className="form form-verificar" noValidate onSubmit={alEnviarForm}>
      <div className="campo-grupo">
        <label htmlFor={idArea} className="campo-etiqueta-destacada">
          Mensaje firmado JWS (formato compacto Base64URL)
        </label>
        <p className="campo-ayuda">
          Introduce el token completo de tres segmentos separados por punto: <code>encabezado.contenido.firma</code>.
        </p>
        <textarea
          id={idArea}
          className="campo campo-jws"
          rows={6}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="eyJhbGciOiJFUzI1NiIsImtpZCI6InNpZ2EtZS1jbGF2ZS0wMSJ9.eyJzZW5kZXIiOiJ1cm46c2lnYS1lOnNpbXVsYWNybyIsImlkZW50aWZpZXIiOiJTSUdBLUUtMjAyNi0wMDAxIn0.…"
          value={valor}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? idAviso : undefined}
          onChange={(e) => {
            // Si se edita el texto, ya no corresponde al archivo elegido.
            setNombre(null);
            alCambiar(e.target.value);
          }}
        />
      </div>

      <div className="campo-grupo campo-grupo-archivo">
        <label htmlFor={idArchivo} className="campo-etiqueta-secundaria">
          O carga un archivo de alerta
        </label>
        <div className="archivo-selector-wrap">
          <input
            id={idArchivo}
            className="archivo"
            type="file"
            accept=".jws,.txt,.json,text/plain,application/json"
            aria-describedby={idNombre}
            onChange={alCambiarArchivo}
          />
        </div>
        <p className="archivo-nombre" id={idNombre} role="status" aria-live="polite">
          {nombre === null ? (
            <span className="archivo-estado-vacio">Formatos aceptados: .jws, .json, .txt (hasta 128 KB)</span>
          ) : (
            <>
              <span>Archivo cargado: </span>
              {nombre === '' ? (
                <span>(sin nombre)</span>
              ) : (
                <TextoAjeno valor={nombre} max={MAX_GRAFEMAS_NOMBRE} className="archivo-nombre-valor" />
              )}
            </>
          )}
        </p>
      </div>

      <div className="form-acciones">
        <button className="boton boton-primario-verificar" type="submit" disabled={verificando}>
          {verificando ? 'Comprobando criptográficamente…' : 'Verificar firma localmente →'}
        </button>
      </div>

      <div className={mostrarError ? 'aviso-vivo aviso-error' : 'aviso-vivo'} role="status" aria-live="polite" id={idAviso}>
        {verificando ? <span>Comprobando la firma ES256 y la clave en este dispositivo…</span> : null}
        {mostrarError ? (
          <>
            <Icono nombre="aviso" clase="ico ico-grande" />
            <span>{error}</span>
          </>
        ) : null}
      </div>
    </form>
  );
}
