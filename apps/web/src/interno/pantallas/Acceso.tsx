// Acceso interno, paso 1: correo y contraseña → POST /auth/login. Un 200 entrega un desafío de
// cinco minutos que vive solo en memoria; no es una sesión. Ningún mensaje revela si la cuenta existe.
// La contraseña vive en el estado del formulario mientras se escribe y se vacía tras cada envío.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RUTAS, TITULOS } from '../../app/router.mjs';
import { navegar } from '../../app/ruta';
import { Titulo } from '../../componentes/Titulo';
import { AvisoInterno, type TonoAviso } from '../componentes/AvisoInterno';
import { CampoFormulario } from '../componentes/CampoFormulario';
import { cliente, comprobarSesion, fijarDesafio, leerSesion, useSesion } from '../sesion';
import {
  AVISO_ERROR_RED,
  AVISO_ERROR_SERVIDOR,
  AVISO_INVALIDO,
  AVISO_NO_DISPONIBLE,
  AVISO_PROHIBIDO,
  AVISO_RECHAZO_ACCESO,
  AVISO_RESPUESTA_INVALIDA,
  ERROR_CAMPO_ACCESO,
  SESION_CERRADA,
  SESION_VENCIDA,
  avisoLimitado,
  type AvisoAcceso,
} from '../textos';
import { MAX_CONTRASENA, MAX_CORREO, validarAcceso } from '../validacion.mjs';

type Aviso = { aviso: AvisoAcceso; tono: TonoAviso } | null;

export function Acceso() {
  const sesion = useSesion();
  const [correo, setCorreo] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [errCorreo, setErrCorreo] = useState<string | null>(null);
  const [errContrasena, setErrContrasena] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<Aviso>(null);
  // Bloqueo por 429: instante (ms) hasta el que no se permite reenviar.
  const [esperaHasta, setEsperaHasta] = useState<number | null>(null);
  const [, setTic] = useState(0);
  const refCorreo = useRef<HTMLInputElement>(null);
  const refContrasena = useRef<HTMLInputElement>(null);
  const refAviso = useRef<HTMLDivElement>(null);

  // Sin comprobación previa, se pregunta al servidor: una sesión válida va directa al portal y una API
  // ausente se dice antes de que la persona escriba su contraseña.
  useEffect(() => {
    if (leerSesion().fase === 'sin-comprobar') void comprobarSesion();
  }, []);
  useEffect(() => {
    if (sesion.fase === 'activa') navegar(RUTAS.portal, { reemplazar: true });
  }, [sesion.fase]);

  // Cuenta atrás del bloqueo, en texto; solo se repinta mientras dura.
  useEffect(() => {
    if (esperaHasta === null) return;
    const t = setInterval(() => {
      if (Date.now() >= esperaHasta) {
        setEsperaHasta(null);
        setAviso(null);
      } else setTic((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [esperaHasta]);

  useEffect(() => {
    if (aviso && (aviso.tono === 'error' || aviso.tono === 'bloqueo')) refAviso.current?.focus();
  }, [aviso]);

  const bloqueado = esperaHasta !== null && Date.now() < esperaHasta;
  // /auth/me y /auth/login se montan juntos en el backend: sin el primero tampoco existe el segundo.
  const noDisponible = sesion.fase === 'no-disponible';

  const enviar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enviando || bloqueado) return;
    const v = validarAcceso(correo, contrasena);
    if (!v.ok) {
      setErrCorreo(v.correo ? ERROR_CAMPO_ACCESO[v.correo] : null);
      setErrContrasena(v.contrasena ? ERROR_CAMPO_ACCESO[v.contrasena] : null);
      setAviso(null);
      (v.correo ? refCorreo : refContrasena).current?.focus();
      return;
    }
    setErrCorreo(null);
    setErrContrasena(null);
    setAviso(null);
    setEnviando(true);
    const r = await cliente.iniciar(v.correo, contrasena);
    // La contraseña no se conserva tras el envío, sea cual sea el resultado.
    setContrasena('');
    setEnviando(false);
    switch (r.tipo) {
      case 'desafio':
        fijarDesafio({ challengeId: r.challengeId, expiraEn: r.expiraEn, rechazos: 0 });
        navegar(RUTAS.codigo);
        return;
      case 'rechazado':
        setAviso({ aviso: AVISO_RECHAZO_ACCESO, tono: 'error' });
        refContrasena.current?.focus();
        return;
      case 'limitado':
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

  const restante = bloqueado && esperaHasta !== null ? Math.ceil((esperaHasta - Date.now()) / 60000) : 0;
  const previo =
    sesion.fase === 'sin-sesion' && sesion.motivo === 'cerrada'
      ? SESION_CERRADA
      : sesion.fase === 'sin-sesion' && sesion.motivo === 'vencida'
        ? SESION_VENCIDA
        : null;

  return (
    <div className="acceso">
      <Titulo>{TITULOS.acceso}</Titulo>
      <p className="acceso-intro">
        Para personal de autoría, aprobación y administración. Necesitas tu correo, tu contraseña y la aplicación de
        autenticación (TOTP) que configuraste en tu alta.
      </p>
      <ol className="pasos" aria-label="Pasos del acceso">
        <li className="paso paso-actual" aria-current="step">
          <span className="paso-num">1</span> Correo y contraseña
        </li>
        <li className="paso">
          <span className="paso-num">2</span> Código de verificación
        </li>
      </ol>
      {previo && !aviso ? <AvisoInterno aviso={previo} tono="info" /> : null}
      {sesion.fase === 'no-disponible' && !aviso ? (
        <AvisoInterno aviso={AVISO_NO_DISPONIBLE} tono="info">
          {/* El servicio puede habilitarse o volver tras un fallo del proxy: se comprueba sin recargar. */}
          <button type="button" className="boton boton-secundario" onClick={() => void comprobarSesion()}>
            Volver a comprobar
          </button>
        </AvisoInterno>
      ) : null}
      {aviso ? (
        <AvisoInterno ref={refAviso} aviso={aviso.aviso} tono={aviso.tono}>
          {bloqueado ? <p className="aviso-interno-espera">Podrás volver a intentarlo en {restante} min.</p> : null}
        </AvisoInterno>
      ) : null}
      <form className="form-interno" noValidate onSubmit={(e) => void enviar(e)} aria-busy={enviando || undefined}>
        <CampoFormulario
          ref={refCorreo}
          etiqueta="Correo de trabajo"
          type="email"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
          enterKeyHint="next"
          maxLength={MAX_CORREO + 10}
          value={correo}
          onChange={(e) => {
            setCorreo(e.target.value);
            if (errCorreo) setErrCorreo(null);
          }}
          error={errCorreo}
          disabled={enviando}
        />
        <CampoFormulario
          ref={refContrasena}
          etiqueta="Contraseña"
          type="password"
          name="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={MAX_CONTRASENA + 1}
          value={contrasena}
          onChange={(e) => {
            setContrasena(e.target.value);
            if (errContrasena) setErrContrasena(null);
          }}
          error={errContrasena}
          disabled={enviando}
        />
        <button type="submit" className="boton" disabled={enviando || bloqueado || noDisponible}>
          {enviando ? 'Comprobando…' : 'Continuar'}
        </button>
        <p className="campo-interno-ayuda" role="status" aria-live="polite">
          {enviando ? 'Enviando los datos al servidor. Espera un momento.' : ''}
        </p>
      </form>
      <p className="nota">
        No hay recuperación de contraseña ni de código en línea. Si has perdido el acceso, contacta con la administración
        del sistema.
      </p>
    </div>
  );
}
