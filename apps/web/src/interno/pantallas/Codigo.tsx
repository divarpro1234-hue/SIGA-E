// Acceso interno, paso 2: código TOTP → POST /auth/totp/verify sobre el desafío en memoria.
// Contrato (ADR-004 §3): el desafío caduca a los cinco minutos y admite como máximo tres códigos
// erróneos; un 401 no dice cuál de las causas fue. El cliente cuenta sus rechazos solo para no
// insistir con un desafío que el servidor ya revocó. No hay recuperación ni códigos de respaldo.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RUTAS, TITULOS } from '../../app/router.mjs';
import { navegar } from '../../app/ruta';
import { Titulo } from '../../componentes/Titulo';
import { horaLocal } from '../fechas';
import { AvisoInterno, type TonoAviso } from '../componentes/AvisoInterno';
import { CampoFormulario } from '../componentes/CampoFormulario';
import { MAX_RECHAZOS_CODIGO, cliente, codigoAceptado, fijarDesafio, useDesafio } from '../sesion';
import {
  AVISO_DESAFIO_AGOTADO,
  AVISO_DESAFIO_CADUCADO,
  AVISO_ERROR_RED,
  AVISO_ERROR_SERVIDOR,
  AVISO_INVALIDO,
  AVISO_NO_DISPONIBLE,
  AVISO_PROHIBIDO,
  AVISO_RECHAZO_CODIGO,
  AVISO_RESPUESTA_INVALIDA,
  ERROR_CAMPO_CODIGO,
  avisoLimitado,
  type AvisoAcceso,
} from '../textos';
import { validarCodigo } from '../validacion.mjs';

type Aviso = { aviso: AvisoAcceso; tono: TonoAviso } | null;

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Codigo() {
  const desafio = useDesafio();
  const [codigo, setCodigo] = useState('');
  const [errCodigo, setErrCodigo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<Aviso>(null);
  const [ahora, setAhora] = useState(() => Date.now());
  // Bloqueo por 429: instante (ms) hasta el que no se permite reenviar.
  const [esperaHasta, setEsperaHasta] = useState<number | null>(null);
  const refCodigo = useRef<HTMLInputElement>(null);
  const refAviso = useRef<HTMLDivElement>(null);

  const caducado = desafio !== null && ahora >= desafio.expiraEn;
  const agotado = desafio !== null && desafio.rechazos >= MAX_RECHAZOS_CODIGO;
  const inutilizable = desafio === null || caducado || agotado;

  // El reloj solo corre mientras el desafío sirve: un desafío caducado o agotado ya no cambia.
  useEffect(() => {
    if (inutilizable) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inutilizable]);

  useEffect(() => {
    if (aviso && (aviso.tono === 'error' || aviso.tono === 'bloqueo')) refAviso.current?.focus();
  }, [aviso]);

  // App redirige al acceso si no hay desafío; aquí no se dibuja nada en ese caso.
  if (!desafio) return null;

  const bloqueado = esperaHasta !== null && ahora < esperaHasta;

  const volver = () => {
    fijarDesafio(null);
    navegar(RUTAS.acceso, { reemplazar: true });
  };

  const enviar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enviando || inutilizable || bloqueado) return;
    const v = validarCodigo(codigo);
    if (!v.ok) {
      setErrCodigo(ERROR_CAMPO_CODIGO[v.error]);
      setAviso(null);
      refCodigo.current?.focus();
      return;
    }
    setErrCodigo(null);
    setAviso(null);
    setEnviando(true);
    const r = await cliente.verificarCodigo(desafio.challengeId, v.codigo);
    // El código es de un solo uso: no se conserva en el campo tras el envío.
    setCodigo('');
    setEnviando(false);
    switch (r.tipo) {
      case 'sesion':
        // La respuesta no abre el portal por sí sola: se descarta y el portal confirma con GET /auth/me.
        codigoAceptado();
        navegar(RUTAS.portal, { reemplazar: true });
        return;
      case 'rechazado': {
        const rechazos = desafio.rechazos + 1;
        fijarDesafio({ ...desafio, rechazos });
        if (rechazos < MAX_RECHAZOS_CODIGO) {
          setAviso({ aviso: AVISO_RECHAZO_CODIGO, tono: 'error' });
          refCodigo.current?.focus();
        }
        return;
      }
      case 'limitado':
        // Reenviar durante el bloqueo solo volvería a chocar con el límite.
        setEsperaHasta(Date.now() + (r.reintentarEn ?? 900) * 1000);
        setAviso({ aviso: avisoLimitado(r.reintentarEn), tono: 'bloqueo' });
        return;
      case 'invalido':
        setAviso({ aviso: AVISO_INVALIDO, tono: 'error' });
        return;
      case 'no-disponible':
        setAviso({ aviso: AVISO_NO_DISPONIBLE, tono: 'info' });
        return;
      case 'error-red':
        setAviso({ aviso: AVISO_ERROR_RED, tono: 'error' });
        return;
      case 'error-servidor':
        setAviso({ aviso: AVISO_ERROR_SERVIDOR, tono: 'error' });
        return;
      case 'prohibido':
        setAviso({ aviso: AVISO_PROHIBIDO, tono: 'error' });
        return;
      default:
        setAviso({ aviso: AVISO_RESPUESTA_INVALIDA, tono: 'error' });
    }
  };

  const quedan = MAX_RECHAZOS_CODIGO - desafio.rechazos;

  return (
    <div className="acceso">
      <Titulo>{TITULOS.codigo}</Titulo>
      <ol className="pasos" aria-label="Pasos del acceso">
        <li className="paso paso-hecho">
          <span className="paso-num">1</span> Correo y contraseña
        </li>
        <li className="paso paso-actual" aria-current="step">
          <span className="paso-num">2</span> Código de verificación
        </li>
      </ol>
      <p className="acceso-intro">
        Abre tu aplicación de autenticación y escribe el código de seis cifras de SIGA-E. El código cambia cada 30
        segundos; si está a punto de cambiar, espera al siguiente.
      </p>

      {inutilizable ? (
        <AvisoInterno aviso={agotado ? AVISO_DESAFIO_AGOTADO : AVISO_DESAFIO_CADUCADO} tono="bloqueo">
          <button type="button" className="boton boton-secundario" onClick={volver}>
            Volver a escribir correo y contraseña
          </button>
        </AvisoInterno>
      ) : (
        <>
          <p className="plazo">
            <span>
              Este paso caduca a las <strong>{horaLocal(desafio.expiraEn)}</strong>
            </span>
            <span className="plazo-cuenta" aria-hidden="true">
              {mmss(desafio.expiraEn - ahora)}
            </span>
          </p>
          {aviso ? (
            <AvisoInterno ref={refAviso} aviso={aviso.aviso} tono={aviso.tono}>
              {aviso.aviso === AVISO_RECHAZO_CODIGO ? (
                <p className="aviso-interno-espera">
                  {quedan === 1 ? 'Queda 1 intento' : `Quedan ${quedan} intentos`} con este paso de verificación.
                </p>
              ) : null}
            </AvisoInterno>
          ) : null}
          <form className="form-interno" noValidate onSubmit={(e) => void enviar(e)} aria-busy={enviando || undefined}>
            <CampoFormulario
              ref={refCodigo}
              etiqueta="Código de seis cifras"
              ayuda="Solo cifras. Puedes dejar un espacio en medio: 123 456."
              claseCampo="entrada-codigo"
              type="text"
              name="one-time-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9 ]*"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={7}
              value={codigo}
              onChange={(e) => {
                setCodigo(e.target.value);
                if (errCodigo) setErrCodigo(null);
              }}
              error={errCodigo}
              disabled={enviando}
            />
            <button type="submit" className="boton" disabled={enviando || bloqueado}>
              {enviando ? 'Comprobando…' : 'Entrar'}
            </button>
            <p className="campo-interno-ayuda" role="status" aria-live="polite">
              {enviando ? 'Comprobando el código con el servidor. Espera un momento.' : ''}
            </p>
          </form>
          <button type="button" className="enlace-accion" onClick={volver}>
            Cancelar y volver al primer paso
          </button>
        </>
      )}
      <p className="nota">
        Sin tu aplicación de autenticación no puedes completar el acceso: no hay códigos de respaldo ni recuperación en
        línea. Contacta con la administración del sistema.
      </p>
    </div>
  );
}
