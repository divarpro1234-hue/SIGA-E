// Shell del portal interno (SIGA-E SIGNATURE).
// Regla central: nada interno se dibuja hasta que GET /auth/me confirma la sesión. El rol que
// decide la navegación es el que devuelve el servidor; no hay selector de rol en producción ni en desarrollo.
import { useEffect, useRef, useState } from 'react';
import { RUTAS, TITULOS, type RutaInterna } from '../app/router.mjs';
import { navegar } from '../app/ruta';
import { AvisoActualizacion } from '../componentes/AvisoActualizacion';
import { Enlace } from '../componentes/Enlace';
import { EstadoPagina } from '../componentes/EstadoPagina';
import { Titulo } from '../componentes/Titulo';
import { BandejaOperativa } from './bandeja/BandejaOperativa';
import { AvisoInterno } from './componentes/AvisoInterno';
import { Acceso } from './pantallas/Acceso';
import { Codigo } from './pantallas/Codigo';
import { SeccionAdministracion, SeccionInicio, SeccionRevision } from './pantallas/Secciones';
import { NOMBRE_ROL, seccionPermitida, seccionesPara, type Seccion } from './roles.mjs';
import { cliente, comprobarSesion, olvidarTodo, useSesion, type EstadoSesion } from './sesion';
import {
  AVISO_ENTORNO,
  AVISO_ERROR_RED,
  AVISO_ERROR_SERVIDOR,
  AVISO_NO_DISPONIBLE,
  AVISO_RESPUESTA_INVALIDA,
  CIERRE_FALLIDO,
  COMPROBANDO_SESION,
  SESION_AUSENTE,
  SESION_CERRADA,
  SESION_SIN_CONFIRMAR_RED,
  SESION_SIN_CONFIRMAR_SERVIDOR,
  SESION_VENCIDA,
} from './textos';

type SesionActiva = Extract<EstadoSesion, { fase: 'activa' }>;

function CabeceraInterna({ sesion, alSalir, saliendo }: { sesion: SesionActiva | null; alSalir: () => void; saliendo: boolean }) {
  return (
    <header className="cab-interna">
      <div className="cab-interna-fila">
        <p className="marca">
          SIGA-E <span className="marca-sub">Portal interno</span>
        </p>
        <span className="simulacro">SIMULACRO</span>
        {sesion ? (
          <div className="cab-usuario">
            <p className="cab-usuario-datos">
              <span className="cab-usuario-nombre">{sesion.usuario.nombre}</span>
              <span className="cab-usuario-rol">{NOMBRE_ROL[sesion.usuario.rol]}</span>
            </p>
            <button type="button" className="boton-salir" onClick={alSalir} disabled={saliendo}>
              {saliendo ? 'Cerrando…' : 'Cerrar sesión'}
            </button>
          </div>
        ) : null}
      </div>
      <p className="cab-interna-entorno">{AVISO_ENTORNO}</p>
    </header>
  );
}

function NavegacionRol({ sesion, actual }: { sesion: SesionActiva; actual: RutaInterna }) {
  return (
    <nav className="nav-interna" aria-label="Secciones del portal">
      <ul>
        {seccionesPara(sesion.usuario.rol).map((s) => (
          <li key={s}>
            <Enlace a={RUTAS[s]} className={s === actual ? 'nav-item nav-item-activo' : 'nav-item'} actual={s === actual}>
              {s === 'portal' ? 'Inicio' : TITULOS[s]}
            </Enlace>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ContenidoSeccion({ sesion, seccion }: { sesion: SesionActiva; seccion: Seccion }) {
  // Verificación estricta de RBAC del servidor
  if (!seccionPermitida(sesion.usuario.rol, seccion)) {
    return (
      <>
        <Titulo>{TITULOS[seccion]}</Titulo>
        <AvisoInterno
          tono="info"
          aviso={{
            titulo: 'Esta sección no corresponde a tu rol',
            cuerpo: `Tu sesión es de ${NOMBRE_ROL[sesion.usuario.rol].toLowerCase()}. Los roles son excluyentes y el servidor rechaza cualquier operación ajena a tu rol.`,
          }}
        >
          <Enlace a={RUTAS.portal} className="boton boton-secundario boton-enlace">
            Ir al inicio del portal
          </Enlace>
        </AvisoInterno>
      </>
    );
  }

  // Bandeja Operativa: solo para roles autorizados (AUTHOR), integrada limpiamente en el portal interno
  if (seccion === 'portal-alertas') {
    const iniciales = sesion.usuario.nombre
      .split(' ')
      .slice(0, 2)
      .map((p) => p[0] ?? '')
      .join('')
      .toUpperCase();

    return (
      <BandejaOperativa
        nombreUsuario={sesion.usuario.nombre}
        rol={sesion.usuario.rol}
        iniciales={iniciales}
        csrf={sesion.csrf}
        esSesionReal={true}
        envoltorioCompleto={false}
      />
    );
  }

  if (seccion === 'portal-revision') return <SeccionRevision />;
  if (seccion === 'portal-administracion') return <SeccionAdministracion />;
  return <SeccionInicio usuario={sesion.usuario} confirmada={sesion.confirmadaEn} />;
}

/** Estados sin sesión confirmada: NUNCA muestran navegación ni contenido interno operativo. */
function SinPortal({ sesion }: { sesion: Exclude<EstadoSesion, SesionActiva> }) {
  if (sesion.fase === 'sin-comprobar' || sesion.fase === 'comprobando') {
    return (
      <>
        <Titulo>{TITULOS.portal}</Titulo>
        <EstadoPagina tipo="cargando" texto={COMPROBANDO_SESION} />
      </>
    );
  }
  if (sesion.fase === 'sin-sesion') {
    const aviso = sesion.motivo === 'vencida' ? SESION_VENCIDA : sesion.motivo === 'cerrada' ? SESION_CERRADA : SESION_AUSENTE;
    return (
      <>
        <Titulo>{TITULOS.portal}</Titulo>
        <AvisoInterno aviso={aviso} tono="info">
          <Enlace a={RUTAS.acceso} className="boton boton-enlace">
            Iniciar sesión
          </Enlace>
        </AvisoInterno>
      </>
    );
  }
  const aviso =
    sesion.fase === 'no-disponible'
      ? AVISO_NO_DISPONIBLE
      : sesion.motivo === 'red'
        ? AVISO_ERROR_RED
        : sesion.motivo === 'servidor'
          ? AVISO_ERROR_SERVIDOR
          : AVISO_RESPUESTA_INVALIDA;
  return (
    <>
      <Titulo>{TITULOS.portal}</Titulo>
      <AvisoInterno aviso={aviso} tono={sesion.fase === 'no-disponible' ? 'info' : 'error'}>
        <button type="button" className="boton boton-secundario" onClick={() => void comprobarSesion()}>
          Volver a comprobar
        </button>
      </AvisoInterno>
    </>
  );
}

export function AppInterna({ nombre }: { nombre: RutaInterna }) {
  const sesion = useSesion();
  const [saliendo, setSaliendo] = useState(false);
  const [errorCierre, setErrorCierre] = useState(false);
  const refError = useRef<HTMLDivElement>(null);
  const enPortal = nombre !== 'acceso' && nombre !== 'codigo';

  // Toda sección del portal consulta al servidor
  useEffect(() => {
    setErrorCierre(false);
    if (enPortal) void comprobarSesion();
  }, [enPortal, nombre]);

  const faseAnterior = useRef(sesion.fase);
  useEffect(() => {
    const venia = faseAnterior.current;
    faseAnterior.current = sesion.fase;
    if (!enPortal || venia === sesion.fase || venia !== 'comprobando') return;
    const activo = document.activeElement;
    if (!activo || activo === document.body) document.querySelector<HTMLElement>('main h1')?.focus();
  }, [sesion.fase, enPortal]);

  useEffect(() => {
    if (!enPortal) return;
    const alVolver = () => {
      if (document.visibilityState === 'visible') void comprobarSesion();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [enPortal]);

  useEffect(() => {
    if (errorCierre) refError.current?.focus();
  }, [errorCierre]);

  const activa = sesion.fase === 'activa' ? sesion : null;

  const salir = async () => {
    if (!activa || saliendo) return;
    setSaliendo(true);
    setErrorCierre(false);
    const r = await cliente.cerrarSesion(activa.csrf);
    setSaliendo(false);
    if (r.tipo === 'cerrada' || r.tipo === 'sin-sesion') {
      olvidarTodo('cerrada');
      navegar(RUTAS.acceso, { reemplazar: true });
      return;
    }
    if (r.tipo === 'prohibido') void comprobarSesion();
    setErrorCierre(true);
  };

  if (!enPortal) {
    return (
      <div className="interno interno-acceso">
        <CabeceraInterna sesion={null} alSalir={() => undefined} saliendo={false} />
        <AvisoActualizacion />
        <main className="pantalla pantalla-acceso" id="contenido">
          {nombre === 'acceso' ? <Acceso /> : <Codigo />}
        </main>
      </div>
    );
  }

  // PORTAL OPERATIVO INTERNO: Autenticación 100% obligatoria en todas las secciones
  return (
    <div className="interno">
      <CabeceraInterna sesion={activa} alSalir={() => void salir()} saliendo={saliendo} />
      <AvisoActualizacion />
      <div className={activa ? 'portal' : 'portal portal-sin-sesion'}>
        {activa ? <NavegacionRol sesion={activa} actual={nombre} /> : null}
        <main className={`portal-contenido${nombre === 'portal-alertas' ? ' portal-contenido-amplio' : ''}`} id="contenido">
          {errorCierre && activa ? <AvisoInterno ref={refError} aviso={CIERRE_FALLIDO} tono="error" /> : null}
          {activa?.sinConfirmar ? (
            <AvisoInterno aviso={activa.sinConfirmar === 'red' ? SESION_SIN_CONFIRMAR_RED : SESION_SIN_CONFIRMAR_SERVIDOR} tono="info">
              <button type="button" className="boton boton-secundario" onClick={() => void comprobarSesion()}>
                Volver a comprobar
              </button>
            </AvisoInterno>
          ) : null}
          {activa ? (
            <ContenidoSeccion sesion={activa} seccion={nombre as Seccion} />
          ) : (
            <SinPortal sesion={sesion as Exclude<EstadoSesion, SesionActiva>} />
          )}
        </main>
      </div>
    </div>
  );
}
