// SIGA-E SIGNATURE — Bandeja Operativa (F3.2).
// Centro de operaciones en dark mode sofisticado.
//
// Separación estricta de seguridad:
// - Dentro del portal autenticado (esSesionReal=true), el rol es inmutable y fijado por el servidor.
// - Envolvemos con AppShell únicamente si envoltorioCompleto=true (modo demo aislado).
// - Los errores del backend REAL nunca se sustituyen por datos DEMO.
//
// INVARIANTES de seguridad:
// - No muestra firma válida sin verificación criptográfica real.
// - No muestra anclaje como prueba independiente de blockchain.
// - No permite autoaprobación desde la interfaz (control en backend).
// - No simula operaciones de negocio si no hay backend activo.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { clienteAlertas, type AlertApproverDetail, type AlertSummary } from '../adaptador-alertas.mjs';
import type { Rol } from '../roles.mjs';
import { AppShell } from '../signature/AppShell';
import { BadgeCiclo, EstadoCarga, EstadoError, EstadoVacio, TarjetaAlerta } from '../signature/Componentes';
import { Sidebar } from '../signature/Sidebar';
import { Topbar } from '../signature/Topbar';
import { crearControladorCargaBandeja } from './carga-bandeja.mjs';
import type { AlertaInterna } from './tipos';
import { PanelDetalle, SinSeleccion } from './PanelDetalle';
import { FormularioCrearAlerta } from '../autor/FormularioCrearAlerta';
import { verificarInstantanea } from '../revision/instantanea.mjs';

type ModoFuente = 'real' | 'demo' | 'cargando' | 'error';
type DecisionRevision = 'approve' | 'reject';

interface DetalleRevisionVerificado {
  id: string;
  alerta: AlertApproverDetail;
  contenido: string;
  digest: string;
}

interface ResultadoDecisionConfirmada {
  id: string;
  decision: DecisionRevision;
  estado: AlertaInterna['lifecycleState'];
  version: number;
  digest: string;
}

interface Estado {
  fuente: ModoFuente;
  alertas: readonly AlertaInterna[];
  alertaSeleccionadaId: string | null;
  busqueda: string;
  sidebarAbierto: boolean;
  vistaMovil: 'queue' | 'detail';
  mensajeError: string | null;
}

type Accion =
  | { tipo: 'cargando' }
  | { tipo: 'datos-reales'; alertas: AlertaInterna[]; seleccionarId: string | null }
  | { tipo: 'activar-demo'; alertas: readonly AlertaInterna[] }
  | { tipo: 'envio-confirmado'; id: string; estado: AlertaInterna['lifecycleState']; version: number; digest: string }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'seleccionar'; id: string | null }
  | { tipo: 'busqueda'; termino: string }
  | { tipo: 'toggle-sidebar' }
  | { tipo: 'cerrar-sidebar' }
  | { tipo: 'vista-movil'; vista: 'queue' | 'detail' };

function reducer(estado: Estado, accion: Accion): Estado {
  switch (accion.tipo) {
    case 'cargando':
      return {
        ...estado,
        fuente: 'cargando',
        alertas: [],
        alertaSeleccionadaId: null,
        mensajeError: null,
      };
    case 'datos-reales':
      return {
        ...estado,
        fuente: 'real',
        alertas: accion.alertas,
        alertaSeleccionadaId:
          accion.alertas.find((alerta) => alerta.id === accion.seleccionarId)?.id ??
          accion.alertas[0]?.id ??
          null,
        mensajeError: null,
      };
    case 'activar-demo':
      return {
        ...estado,
        fuente: 'demo',
        alertas: accion.alertas,
        alertaSeleccionadaId: accion.alertas[0]?.id ?? null,
        mensajeError: null,
      };
    case 'envio-confirmado':
      return {
        ...estado,
        alertas: estado.alertas.map((alerta) =>
          alerta.id === accion.id
            ? {
                ...alerta,
                lifecycleState: accion.estado,
                version: accion.version,
                frozenPayload: { payloadDigestHex: accion.digest },
              }
            : alerta,
        ),
      };
    case 'error':
      return {
        ...estado,
        fuente: 'error',
        alertas: [],
        alertaSeleccionadaId: null,
        mensajeError: accion.mensaje,
      };
    case 'seleccionar':
      return { ...estado, alertaSeleccionadaId: accion.id };
    case 'busqueda':
      return { ...estado, busqueda: accion.termino, alertaSeleccionadaId: null };
    case 'toggle-sidebar':
      return { ...estado, sidebarAbierto: !estado.sidebarAbierto };
    case 'cerrar-sidebar':
      return { ...estado, sidebarAbierto: false };
    case 'vista-movil':
      return { ...estado, vistaMovil: accion.vista };
    default:
      return estado;
  }
}

const estado0: Estado = {
  fuente: 'cargando',
  alertas: [],
  alertaSeleccionadaId: null,
  busqueda: '',
  sidebarAbierto: false,
  vistaMovil: 'queue',
  mensajeError: null,
};

async function cargarAlertasReales(): Promise<AlertaInterna[] | 'no-disponible' | 'error'> {
  const res = await clienteAlertas.listarAlertas({ page: 1, limit: 20 });
  if (!res.ok) return res.motivo === 'no-disponible' ? 'no-disponible' : 'error';
  return res.alertas;
}

export interface BandejaOperativaProps {
  nombreUsuario?: string;
  rol?: Rol;
  iniciales?: string;
  csrf?: string;
  esSesionReal?: boolean;
  /** Si es true, renderiza con AppShell (Sidebar y Topbar). Si es false, se integra en AppInterna sin duplicar. */
  envoltorioCompleto?: boolean;
  /** Permite auditar roles en modo demo aislado (nunca en sesión real). */
  permitirSelectorRolDemo?: boolean;
  /** Fixtures de demostración para el modo de evaluación visual aislado (solo DEV). */
  fixturesDemo?: readonly AlertaInterna[];
}

export function BandejaOperativa({
  nombreUsuario = 'Mariana Albarracín',
  rol: rolProp = 'AUTHOR',
  iniciales: inicialesProp = 'MA',
  csrf = '',
  esSesionReal = true,
  envoltorioCompleto = false,
  permitirSelectorRolDemo = false,
  fixturesDemo,
}: BandejaOperativaProps) {
  const [estado, dispatch] = useReducer(reducer, estado0);
  const [rolDemo, setRolDemo] = useState<Rol>(rolProp);
  const [modoCreacion, setModoCreacion] = useState(false);
  const [alertaEnEdicion, setAlertaEnEdicion] =
  useState<AlertaInterna | null>(null);
  const [detalleReal, setDetalleReal] = useState<{ id: string; alerta: AlertaInterna } | null>(null);
  const [detalleRevisionReal, setDetalleRevisionReal] = useState<DetalleRevisionVerificado | null>(null);
  const [detalleCargando, setDetalleCargando] = useState(false);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [auditoria, setAuditoria] = useState<readonly { seq: string; occurredAt: string; action: string }[]>([]);
  const [actualizarDetalle, setActualizarDetalle] = useState(0);
  const [enviandoRevision, setEnviandoRevision] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [resultadoEnvio, setResultadoEnvio] = useState<{
    id: string;
    estado: AlertaInterna['lifecycleState'];
    digest: string;
  } | null>(null);
  const [relecturaPendiente, setRelecturaPendiente] = useState(false);
  const [enviandoDecision, setEnviandoDecision] = useState(false);
  const [errorDecision, setErrorDecision] = useState<string | null>(null);
  const [requiereRelecturaDecision, setRequiereRelecturaDecision] = useState(false);
  const [resultadoDecision, setResultadoDecision] = useState<ResultadoDecisionConfirmada | null>(null);
  const solicitudDetalleRef = useRef(0);
  const envioEnCursoRef = useRef(false);
  const solicitudEnvioRef = useRef(0);
  const decisionEnCursoRef = useRef(false);
  const solicitudDecisionRef = useRef(0);
  const seleccionPreferidaRef = useRef<string | null>(null);
  const busquedaRef = useRef<HTMLInputElement>(null);
  const modoCarga: 'real' | 'demo' = esSesionReal ? 'real' : 'demo';
  const modoCargaRef = useRef(modoCarga);
  useLayoutEffect(() => {
    if (modoCargaRef.current !== modoCarga) {
      solicitudEnvioRef.current += 1;
      envioEnCursoRef.current = false;
      setEnviandoRevision(false);
      setErrorEnvio(null);
      setResultadoEnvio(null);
      setRelecturaPendiente(false);
      decisionEnCursoRef.current = false;
      solicitudDecisionRef.current += 1;
      setEnviandoDecision(false);
      setErrorDecision(null);
      setRequiereRelecturaDecision(false);
      setResultadoDecision(null);
      setDetalleRevisionReal(null);
    }
    modoCargaRef.current = modoCarga;
  }, [modoCarga]);
  useEffect(
    () => () => {
      solicitudEnvioRef.current += 1;
      envioEnCursoRef.current = false;
      solicitudDecisionRef.current += 1;
      decisionEnCursoRef.current = false;
    },
    [],
  );
  const [controladorCarga] = useState(() =>
    crearControladorCargaBandeja({
      cargarReales: cargarAlertasReales,
      modoActual: () => modoCargaRef.current,
      publicar: (resultado) => {
        if (resultado.tipo === 'cargando') {
          dispatch({ tipo: 'cargando' });
        } else if (resultado.tipo === 'demo') {
          dispatch({ tipo: 'activar-demo', alertas: resultado.alertas });
        } else if (resultado.tipo === 'real') {
          dispatch({
            tipo: 'datos-reales',
            alertas: [...resultado.alertas],
            seleccionarId: seleccionPreferidaRef.current,
          });
          seleccionPreferidaRef.current = null;
        } else {
          dispatch({ tipo: 'error', mensaje: resultado.mensaje });
        }
      },
    }),
  );

  // En sesión real, el rol es ESTRICTAMENTE el provisto por la autenticación del backend
  const rolEfectivo: Rol = esSesionReal ? rolProp : rolDemo;

  const nombreEfectivo = esSesionReal
    ? nombreUsuario
    : rolEfectivo === 'APPROVER'
      ? 'Mariana Albarracín'
      : rolEfectivo === 'AUTHOR'
        ? 'Carlos Méndez'
        : 'Valeria Rivas';

  const inicialesEfectivas = esSesionReal
    ? inicialesProp
    : rolEfectivo === 'APPROVER'
      ? 'MA'
      : rolEfectivo === 'AUTHOR'
        ? 'CM'
        : 'VR';

  useEffect(() => {
    void controladorCarga.cargar(modoCarga, fixturesDemo);
    return () => controladorCarga.invalidar();
  }, [controladorCarga, modoCarga, fixturesDemo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        busquedaRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const alertasFiltradas = estado.alertas.filter((a) => {
    if (!estado.busqueda) return true;
    const t = estado.busqueda.toLowerCase();
    return (
      a.identifier.toLowerCase().includes(t) ||
      (a.info?.headline ?? '').toLowerCase().includes(t) ||
      (a.info?.severity ?? '').toLowerCase().includes(t) ||
      a.lifecycleState.toLowerCase().includes(t)
    );
  });

  const alertaSeleccionada =
    alertasFiltradas.find((a) => a.id === estado.alertaSeleccionadaId) ?? alertasFiltradas[0] ?? null;
  const detalleRevisionActual =
    esSesionReal &&
    rolProp === 'APPROVER' &&
    detalleRevisionReal?.id === alertaSeleccionada?.id
      ? detalleRevisionReal
      : null;
  const alertaDesdeRevision: AlertaInterna | null = detalleRevisionActual
    ? {
        id: detalleRevisionActual.alerta.id,
        identifier: detalleRevisionActual.alerta.identifier,
        notice: detalleRevisionActual.alerta.notice,
        version: detalleRevisionActual.alerta.version,
        etag: detalleRevisionActual.alerta.etag,
        msgType: detalleRevisionActual.alerta.kind,
        lifecycleState: detalleRevisionActual.alerta.lifecycleState,
        anchorStatus: detalleRevisionActual.alerta.anchorStatus,
        info: { severity: detalleRevisionActual.alerta.severity },
        frozenPayload: { payloadDigestHex: detalleRevisionActual.digest },
      }
    : null;
  const alertaDetalle =
    estado.fuente === 'real' && rolProp === 'APPROVER'
      ? alertaDesdeRevision ?? alertaSeleccionada
      : estado.fuente === 'real' && detalleReal && detalleReal.id === alertaSeleccionada?.id
        ? detalleReal.alerta
        : alertaSeleccionada;
  const puedeDecidirRevision = Boolean(
    esSesionReal &&
      rolProp === 'APPROVER' &&
      estado.fuente === 'real' &&
      alertaDetalle?.lifecycleState === 'PENDING_APPROVAL' &&
      detalleRevisionActual &&
      detalleRevisionActual.alerta.version === alertaDetalle.version &&
      detalleRevisionActual.alerta.etag === `"v${detalleRevisionActual.alerta.version}"` &&
      detalleRevisionActual.digest === detalleRevisionActual.alerta.reviewSnapshot.payloadDigestHex &&
      !detalleCargando &&
      !enviandoDecision &&
      !enviandoRevision &&
      !requiereRelecturaDecision &&
      !decisionEnCursoRef.current,
  );
  const puedeEnviarRevision = Boolean(
    esSesionReal &&
      rolProp === 'AUTHOR' &&
      estado.fuente === 'real' &&
      alertaDetalle &&
      detalleReal?.id === alertaDetalle.id &&
      alertaDetalle.lifecycleState === 'DRAFT' &&
      Number.isSafeInteger(alertaDetalle.version) &&
      alertaDetalle.etag === `"v${alertaDetalle.version}"` &&
      !detalleCargando &&
      !relecturaPendiente,
  );

  const puedeEditarBorrador = Boolean(
    esSesionReal &&
    rolProp === 'AUTHOR' &&
    estado.fuente === 'real' &&
    alertaSeleccionada &&
    detalleReal?.id === alertaSeleccionada.id &&
    alertaDetalle &&
    alertaDetalle.msgType === 'Alert' &&
    (
      alertaDetalle.lifecycleState === 'DRAFT' ||
      alertaDetalle.lifecycleState === 'REJECTED'
    ) &&
    Number.isSafeInteger(alertaDetalle.version) &&
    alertaDetalle.etag === `"v${alertaDetalle.version}"` &&
    alertaDetalle.info &&
    !detalleCargando &&
    !relecturaPendiente &&
    !enviandoRevision
  );

  const seleccionar = (id: string) => {
    setModoCreacion(false);
    setAlertaEnEdicion(null);
    setErrorEnvio(null);
    setResultadoEnvio(null);
    setErrorDecision(null);
    setRequiereRelecturaDecision(false);
    if (id !== estado.alertaSeleccionadaId) setResultadoDecision(null);
    dispatch({ tipo: 'seleccionar', id });
    dispatch({ tipo: 'vista-movil', vista: 'detail' });
  };

  const motivoDetalle = (motivo: string) => {
    if (motivo === 'sin-sesion') return 'Sesión inválida (401). Vuelve a iniciar sesión.';
    if (motivo === 'prohibido') return 'Acceso denegado (403). La sesión no está autorizada para consultar esta alerta.';
    if (motivo === 'no-encontrada') return 'Alerta no encontrada (404) o no visible para esta identidad.';
    if (motivo === 'conflicto') return 'La alerta cambió mientras se consultaba (409). Vuelve a leerla.';
    if (motivo === 'invalido') return 'El servidor rechazó la solicitud de detalle (422).';
    if (motivo === 'no-disponible') return 'El endpoint de detalle no está disponible.';
    if (motivo === 'error-servidor') return 'Error del servidor al consultar el detalle.';
    if (motivo === 'error-red') return 'Error de red al consultar el detalle.';
    return 'No se pudo validar la respuesta de detalle del servidor.';
  };

  useEffect(() => {
    const id = alertaSeleccionada?.id;
    const solicitud = ++solicitudDetalleRef.current;
    const esAprobadorReal = esSesionReal && rolProp === 'APPROVER';
    if (!esSesionReal || estado.fuente !== 'real' || !id) {
      setDetalleReal(null);
      setDetalleRevisionReal(null);
      setDetalleCargando(false);
      setErrorDetalle(null);
      return () => {
        solicitudDetalleRef.current += 1;
      };
    }

    setDetalleReal(null);
    setDetalleRevisionReal(null);
    setDetalleCargando(true);
    setErrorDetalle(null);
    if (esAprobadorReal && alertaSeleccionada?.lifecycleState !== 'PENDING_APPROVAL') {
      setDetalleCargando(false);
      setRequiereRelecturaDecision(false);
      setErrorDecision(null);
      return () => {
        solicitudDetalleRef.current += 1;
      };
    }

    if (esAprobadorReal) {
      void (async () => {
        try {
          const res = await clienteAlertas.obtenerDetalleRevision(id);
          if (solicitud !== solicitudDetalleRef.current || modoCargaRef.current !== 'real') return;
          if (!res.ok) {
            setErrorDetalle(motivoDetalle(res.motivo));
            return;
          }
          if (res.alerta.id !== id || res.alerta.lifecycleState !== 'PENDING_APPROVAL') {
            setErrorDetalle('El detalle de revisión no coincide con la alerta pendiente seleccionada.');
            return;
          }
          const verificacion = await verificarInstantanea(res.alerta.reviewSnapshot);
          if (solicitud !== solicitudDetalleRef.current || modoCargaRef.current !== 'real') return;
          if (!verificacion.ok) {
            const mensajes: Record<string, string> = {
              'sin-webcrypto': 'WebCrypto no está disponible en este contexto seguro; la revisión queda bloqueada.',
              'digest-distinto': 'El SHA-256 local no coincide con el digest recibido. La aprobación y el rechazo quedan bloqueados.',
              utf8: 'El contenido congelado no es UTF-8 estricto; no se mostrará ni permitirá decidir.',
              tamano: 'El contenido congelado supera el límite defensivo de visualización.',
              forma: 'La instantánea de revisión no cumple el formato esperado.',
              'digest-forma': 'El digest de revisión no tiene el formato esperado.',
              base64: 'Los bytes recibidos no usan base64url canónico.',
            };
            setErrorDetalle(mensajes[verificacion.motivo] ?? 'No se pudo verificar el contenido congelado.');
            return;
          }
          setDetalleRevisionReal({
            id,
            alerta: res.alerta,
            contenido: verificacion.texto,
            digest: verificacion.digest,
          });
          setErrorDetalle(null);
          setErrorDecision(null);
          setRequiereRelecturaDecision(false);
        } catch {
          if (solicitud === solicitudDetalleRef.current) {
            setErrorDetalle('No se pudo leer o verificar la instantánea. La decisión queda bloqueada.');
          }
        } finally {
          if (solicitud === solicitudDetalleRef.current) {
            setDetalleCargando(false);
            setRelecturaPendiente(false);
          }
        }
      })();
      return () => {
        solicitudDetalleRef.current += 1;
      };
    }

    void clienteAlertas.obtenerAlerta(id).then(
      (res) => {
        if (
          solicitud !== solicitudDetalleRef.current ||
          modoCargaRef.current !== 'real'
        ) return;
        if (res.ok) {
          setDetalleReal({ id, alerta: res.alerta });
          setErrorDetalle(null);
          void clienteAlertas.consultarAuditoria(id).then((auditoriaRes) => {
            if (solicitud !== solicitudDetalleRef.current) return;
            if (auditoriaRes.ok) {
              const eventos: readonly { seq: string; occurredAt: string; action: string }[] =
                auditoriaRes.eventos ?? [];
              setAuditoria(eventos.map((evento) => ({
                seq: evento.seq,
                occurredAt: evento.occurredAt,
                action: evento.action,
              })));
            } else {
              setAuditoria([]);
            }
          });
        } else {
          setDetalleReal(null);
          setErrorDetalle(motivoDetalle(res.motivo));
        }
        setDetalleCargando(false);
        setRelecturaPendiente(false);
      },
      () => {
        if (
          solicitud !== solicitudDetalleRef.current ||
          modoCargaRef.current !== 'real'
        ) return;
        setDetalleReal(null);
        setDetalleCargando(false);
        setErrorDetalle('Error de red al consultar el detalle.');
        setRelecturaPendiente(false);
      },
    );

    return () => {
      solicitudDetalleRef.current += 1;
    };
  }, [
    actualizarDetalle,
    alertaSeleccionada?.id,
    alertaSeleccionada?.lifecycleState,
    estado.fuente,
    esSesionReal,
    rolProp,
  ]);

  const enviarRevision = async () => {
    if (
      envioEnCursoRef.current ||
      !puedeEnviarRevision ||
      !alertaDetalle ||
      !alertaDetalle.version ||
      !alertaDetalle.etag
    ) return;

    envioEnCursoRef.current = true;
    const solicitud = ++solicitudEnvioRef.current;
    setEnviandoRevision(true);
    setErrorEnvio(null);
    setResultadoEnvio(null);

    try {
      const res = await clienteAlertas.enviarARevision(
        alertaDetalle.id,
        alertaDetalle.version,
        alertaDetalle.etag,
        csrf,
      );
      if (solicitud !== solicitudEnvioRef.current || modoCargaRef.current !== 'real') return;
      if (res.ok) {
        setResultadoEnvio({
          id: alertaDetalle.id,
          estado: res.lifecycleState,
          digest: res.payloadDigestHex,
        });
        dispatch({
          tipo: 'envio-confirmado',
          id: alertaDetalle.id,
          estado: res.lifecycleState,
          version: res.version,
          digest: res.payloadDigestHex,
        });
        setActualizarDetalle((actual) => actual + 1);
        return;
      }

      const mensajes: Record<string, string> = {
        'sin-sesion': 'Sesión inválida (401). Vuelve a iniciar sesión.',
        prohibido: 'Acceso denegado (403). Verifica tu rol AUTHOR y la protección CSRF.',
        'no-encontrada': 'Alerta no encontrada (404) o no visible para esta identidad.',
        conflicto: 'Conflicto de estado o versión (409). Se releerán los datos antes de habilitar otra operación.',
        invalido: 'El servidor rechazó la solicitud (422). Revisa el borrador y vuelve a leerlo.',
        'no-disponible': 'El endpoint /submit no está disponible.',
        'error-red': 'Error de red: el resultado de la operación es incierto. No se repetirá el envío.',
        'error-servidor': 'Error del servidor: el resultado de la operación es incierto. No se repetirá el envío.',
      };
      setErrorEnvio(mensajes[res.motivo] ?? 'No se pudo enviar el borrador a revisión.');

      if (res.motivo === 'conflicto' || res.motivo === 'error-red' || res.motivo === 'error-servidor') {
        setRelecturaPendiente(true);
        seleccionPreferidaRef.current = alertaDetalle.id;
        await controladorCarga.cargar('real', fixturesDemo);
      }
    } catch {
      if (solicitud !== solicitudEnvioRef.current || modoCargaRef.current !== 'real') return;
      setErrorEnvio('Error de red: el resultado de la operación es incierto. No se repetirá el envío.');
      setRelecturaPendiente(true);
      seleccionPreferidaRef.current = alertaDetalle.id;
      await controladorCarga.cargar('real', fixturesDemo);
    } finally {
      if (solicitud === solicitudEnvioRef.current) {
        envioEnCursoRef.current = false;
        setEnviandoRevision(false);
      }
    }
  };

  const mensajeFalloDecision = (motivo: string) => {
    if (motivo === 'sin-sesion') return 'La sesión expiró (401). Vuelve a autenticarte; no se repetirá la decisión.';
    if (motivo === 'prohibido') return 'El servidor rechazó la autorización o CSRF (403). Comprueba la sesión y vuelve a leer antes de decidir.';
    if (motivo === 'no-encontrada') return 'La alerta ya no está disponible para esta identidad o estado (404). Vuelve a leer la bandeja.';
    if (motivo === 'conflicto') return 'La versión, el digest o el estado cambiaron (409). Se volverá a leer la alerta; no se reintentará la decisión.';
    if (motivo === 'invalido') return 'El servidor rechazó los datos de la decisión (422). Revisa el motivo y el detalle vigente.';
    if (motivo === 'no-disponible') return 'El endpoint de decisión no está disponible.';
    if (motivo === 'error-red') return 'No se recibió una respuesta concluyente por un error de red. El resultado es incierto; vuelve a leer antes de otra acción.';
    return 'El servidor no pudo confirmar el resultado (error 5xx). Vuelve a leer el estado antes de otra acción.';
  };

  const releerRevision = () => {
    if (!esSesionReal || rolProp !== 'APPROVER' || estado.fuente !== 'real') return;
    setRequiereRelecturaDecision(true);
    if (alertaSeleccionada?.id) seleccionPreferidaRef.current = alertaSeleccionada.id;
    void controladorCarga.cargar('real', fixturesDemo);
  };

  const decidirRevision = async (decision: DecisionRevision, motivo: string) => {
    const revision = detalleRevisionActual;
    if (
      !esSesionReal ||
      rolProp !== 'APPROVER' ||
      estado.fuente !== 'real' ||
      !puedeDecidirRevision ||
      !revision ||
      !alertaDetalle ||
      decisionEnCursoRef.current
    ) {
      return;
    }
    if (
      decision === 'reject' &&
      (Array.from(motivo.trim()).length < 3 ||
        Array.from(motivo).length > 500 ||
        /[\r\n\u2028\u2029]/u.test(motivo))
    ) {
      setErrorDecision('El motivo debe tener entre 3 y 500 caracteres y no incluir saltos de línea.');
      return;
    }

    decisionEnCursoRef.current = true;
    const solicitud = ++solicitudDecisionRef.current;
    setEnviandoDecision(true);
    setErrorDecision(null);
    try {
      const resultado =
        decision === 'approve'
          ? await clienteAlertas.aprobarAlerta(
              revision.alerta.id,
              revision.alerta.version,
              revision.alerta.etag,
              revision.alerta.reviewSnapshot.payloadDigestHex,
              csrf,
            )
          : await clienteAlertas.rechazarAlerta(
              revision.alerta.id,
              revision.alerta.version,
              revision.alerta.etag,
              revision.alerta.reviewSnapshot.payloadDigestHex,
              motivo,
              csrf,
            );
      if (solicitud !== solicitudDecisionRef.current || modoCargaRef.current !== 'real') return;
      if (!resultado.ok) {
        setErrorDecision(mensajeFalloDecision(resultado.motivo));
        if (resultado.motivo === 'conflicto' || resultado.motivo === 'no-encontrada') {
          releerRevision();
        } else if (
          resultado.motivo === 'sin-sesion' ||
          resultado.motivo === 'prohibido' ||
          resultado.motivo === 'error-red' ||
          resultado.motivo === 'error-servidor'
        ) {
          setRequiereRelecturaDecision(true);
        }
        return;
      }

      setResultadoDecision({
        id: resultado.alerta.id,
        decision,
        estado: resultado.alerta.lifecycleState,
        version: resultado.version,
        digest: revision.digest,
      });
      setDetalleRevisionReal(null);
      setErrorDetalle(null);
      setRequiereRelecturaDecision(false);
      seleccionPreferidaRef.current = resultado.alerta.id;
      await controladorCarga.cargar('real', fixturesDemo);
    } catch {
      if (solicitud === solicitudDecisionRef.current) {
        setErrorDecision('No se recibió una respuesta concluyente. El resultado es incierto; vuelve a leer el estado antes de otra acción.');
        setRequiereRelecturaDecision(true);
      }
    } finally {
      if (solicitud === solicitudDecisionRef.current) {
        decisionEnCursoRef.current = false;
        setEnviandoDecision(false);
      }
    }
  };

  const reintentarDetalle = () => {
    if (esSesionReal && rolProp === 'APPROVER') {
      releerRevision();
      return;
    }
    setActualizarDetalle((actual) => actual + 1);
  };

  const volverABandeja = () => {
    dispatch({ tipo: 'vista-movil', vista: 'queue' });
  };

  // Banner informativo riguroso
  const demoBanner = (
    <div className="sig-demo-banner" role="region" aria-label="Estado de integración de datos">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="sig-demo-banner-dot" aria-hidden="true" />
        <strong>
          {estado.fuente === 'demo'
            ? 'ADAPTADOR DEMO · INTEGRACIÓN PENDIENTE DE COMPROBACIÓN'
            : 'RESPUESTA REAL DEL BACKEND (HTTP API)'}
        </strong>
        <span style={{ opacity: 0.8 }}>
          — Datos de SIMULACRO técnico. Las firmas y anclajes mostrados no constituyen transacciones productivas.
        </span>
      </div>

      {/* Conmutador de roles: solo en visualizador de demo aislado, NUNCA en sesión real */}
      {!esSesionReal && permitirSelectorRolDemo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', color: 'var(--sig-text-muted)', fontWeight: 700 }}>SIMULAR ROL UI:</span>
          {(['APPROVER', 'AUTHOR', 'ADMIN'] as Rol[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`sig-btn ${rolDemo === r ? 'sig-btn-primary' : 'sig-btn-secondary'}`}
              style={{ minHeight: '24px', padding: '0 8px', fontSize: '10px' }}
              onClick={() => setRolDemo(r)}
              aria-label={`Simular rol visual ${r}`}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const mobileTabs = (
    <nav className="sig-mobile-tabs" role="tablist" aria-label="Navegación móvil Bandeja y Detalle">
      <button
        type="button"
        className="sig-mobile-tab"
        role="tab"
        aria-selected={estado.vistaMovil === 'queue'}
        onClick={() => dispatch({ tipo: 'vista-movil', vista: 'queue' })}
      >
        📋 Bandeja ({alertasFiltradas.length})
      </button>
      <button
        type="button"
        className="sig-mobile-tab"
        role="tab"
        aria-selected={estado.vistaMovil === 'detail'}
        onClick={() => dispatch({ tipo: 'vista-movil', vista: 'detail' })}
      >
        🔍 Detalle & Trazabilidad
      </button>
    </nav>
  );

  let contenidoCola: ReactNode;

  if (estado.fuente === 'cargando') {
    contenidoCola = <EstadoCarga texto="Cargando alertas del centro operativo…" />;
  } else if (estado.fuente === 'error') {
    contenidoCola = (
      <EstadoError
        mensaje={estado.mensajeError ?? 'Error de conexión.'}
        onReintentar={() => void controladorCarga.cargar(modoCargaRef.current, fixturesDemo)}
      />
    );
  } else if (alertasFiltradas.length === 0) {
    contenidoCola = (
      <EstadoVacio
        mensaje={
          estado.busqueda
            ? `No se encontraron alertas para "${estado.busqueda}".`
            : 'No hay alertas activas en seguimiento en este momento.'
        }
      />
    );
  } else {
    contenidoCola = alertasFiltradas.map((a) => (
      <TarjetaAlerta
        key={a.id}
        alerta={a}
        seleccionada={a.id === (alertaSeleccionada?.id ?? null)}
        onClick={() => seleccionar(a.id)}
      />
    ));
  }

  const workspace = (
    <main
      className={`sig-workspace sig-view-${estado.vistaMovil}`}
      id="contenido"
      aria-label="Espacio de trabajo operativo"
    >
      <section className="sig-col-queue" aria-label="Cola operativa de alertas">
        <div className="sig-col-header">
          <div className="sig-col-title">
            <span>ALERTAS EN SEGUIMIENTO</span>
            <span className="sig-counter-badge" aria-live="polite">
              {estado.fuente === 'cargando' ? '…' : alertasFiltradas.length}
            </span>
          </div>
        </div>
        {rolEfectivo === 'AUTHOR' && (
          <div style={{ padding: '0 12px 10px' }}>
            <button
              type="button"
              className="sig-btn-crear-alerta"
              onClick={() => {
                setAlertaEnEdicion(null);
                setModoCreacion(true);
                dispatch({ tipo: 'vista-movil', vista: 'detail' });
              }}
            >
              + Redactar Borrador SIMULACRO
            </button>
          </div>
        )}
        <div className="sig-queue-list">{contenidoCola}</div>
      </section>

      <section className="sig-col-detail" aria-label="Detalle de inspección y trazabilidad criptográfica">
        {modoCreacion && rolEfectivo === 'AUTHOR' ? (
          <FormularioCrearAlerta
            csrf={csrf ?? ''}
            esSesionReal={esSesionReal}
            onCancelar={() => setModoCreacion(false)}
            onCreada={(alerta: AlertSummary) => {
              setModoCreacion(false);
              seleccionPreferidaRef.current = alerta.id;
              void controladorCarga.cargar(modoCargaRef.current, fixturesDemo);
            }}
          />
        ) : alertaEnEdicion && esSesionReal && rolEfectivo === 'AUTHOR' ? (
          <FormularioCrearAlerta
            key={`editar-${alertaEnEdicion.id}-${alertaEnEdicion.version}`}
            csrf={csrf ?? ''}
            esSesionReal={esSesionReal}
            alertaParaEditar={alertaEnEdicion}
            onCancelar={() => {
              setAlertaEnEdicion(null);
              setActualizarDetalle((actual) => actual + 1);
            }}
            onEditada={(alerta: AlertSummary) => {
              setAlertaEnEdicion(null);
              setDetalleReal(null);
              seleccionPreferidaRef.current = alerta.id;
              setActualizarDetalle((actual) => actual + 1);
              void controladorCarga.cargar(modoCargaRef.current, fixturesDemo);
            }}
          />
        ) : alertaSeleccionada ? (
          <>
            {puedeEditarBorrador && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  padding: '12px 16px 0',
                }}
              >
                <button
                  type="button"
                  className="sig-btn sig-btn-secondary"
                  onClick={() => {
                    if (!puedeEditarBorrador || !alertaDetalle) return;

                    setAlertaEnEdicion({ ...alertaDetalle });
                    dispatch({ tipo: 'vista-movil', vista: 'detail' });
                  }}
                >
                  Editar borrador
                </button>
              </div>
            )}

            <PanelDetalle
              alerta={alertaDetalle ?? alertaSeleccionada}
              rol={rolEfectivo}
              onVolver={volverABandeja}
              esSesionReal={esSesionReal}
              detalleCargando={detalleCargando}
              errorDetalle={errorDetalle}
              onReintentarDetalle={reintentarDetalle}
              puedeEnviarRevision={puedeEnviarRevision}
              enviandoRevision={enviandoRevision}
              errorEnvio={errorEnvio}
              resultadoEnvio={
                resultadoEnvio?.id === alertaSeleccionada.id
                  ? resultadoEnvio
                  : null
              }
              onEnviarRevision={enviarRevision}
              detalleRevision={
                detalleRevisionActual
                  ? {
                      authorId: detalleRevisionActual.alerta.authorId,
                      contenido: detalleRevisionActual.contenido,
                      digest: detalleRevisionActual.digest,
                      version: detalleRevisionActual.alerta.version,
                      etag: detalleRevisionActual.alerta.etag,
                    }
                  : null
              }
              puedeDecidirRevision={puedeDecidirRevision}
              enviandoDecision={enviandoDecision}
              requiereRelecturaDecision={requiereRelecturaDecision}
              errorDecision={errorDecision}
              resultadoDecision={
                resultadoDecision?.id === alertaSeleccionada.id
                  ? {
                      decision: resultadoDecision.decision,
                      estado: resultadoDecision.estado,
                      version: resultadoDecision.version,
                      digest: resultadoDecision.digest,
                    }
                  : null
              }
              onDecidirRevision={decidirRevision}
              onReintentarRevision={releerRevision}
              auditoria={auditoria}
            />
          </>
        ) : (
          <SinSeleccion />
        )}
      </section>
    </main>
  );

  // Si envoltorioCompleto es false (dentro de AppInterna), renderiza el contenido limpio sin barras duplicadas
  if (!envoltorioCompleto) {
    return (
      <div className="sig-theme sig-bandeja-integrada">
        {demoBanner}
        {mobileTabs}
        {workspace}
      </div>
    );
  }

  // Si envoltorioCompleto es true (modo demo aislado en DEV)
  return (
    <AppShell
      sidebar={
        <Sidebar
          open={estado.sidebarAbierto}
          onClose={() => dispatch({ tipo: 'cerrar-sidebar' })}
          nombreUsuario={nombreEfectivo}
          rol={rolEfectivo}
          iniciales={inicialesEfectivas}
        />
      }
      topbar={
        <Topbar
          seccionActual="BANDEJA OPERATIVA"
          busqueda={estado.busqueda}
          onBusquedaChange={(v) => dispatch({ tipo: 'busqueda', termino: v })}
          onMenuClick={() => dispatch({ tipo: 'toggle-sidebar' })}
        />
      }
      demoBanner={demoBanner}
      mobileTabs={mobileTabs}
      workspace={workspace}
      drawerOpen={estado.sidebarAbierto}
      onBackdropClick={() => dispatch({ tipo: 'cerrar-sidebar' })}
    />
  );
}
