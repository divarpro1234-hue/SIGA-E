// SIGA-E SIGNATURE — Formulario de Creación de Alertas M2 (F4-A).
// Permite a un operador con rol AUTHOR redactar un borrador de alerta SIMULACRO
// y enviarlo al endpoint canónico POST /api/v1/alerts.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  clienteAlertas,
  type AlertInput,
  type AlertSummary,
  type CertezaCAP,
  type EscenarioCAP,
  type SeveridadCAP,
  type UrgenciaCAP,
} from '../adaptador-alertas.mjs';
import {
  validarFormularioAlerta,
  type ErroresFormularioAlerta,
  type FormularioAlertaValores,
} from './validacion-alerta.mjs';

import type { AlertaInterna } from '../bandeja/tipos';

interface Props {
  csrf: string;
  esSesionReal?: boolean;
  alertaParaEditar?: AlertaInterna;
  onCreada?: (alerta: AlertSummary) => void;
  onEditada?: (alerta: AlertSummary) => void;
  onCancelar?: () => void;
}
/**
 * Convierte una fecha ISO UTC al formato requerido
 * por un input datetime-local, respetando la zona
 * horaria local del navegador.
 */
function fechaIsoAInputLocal(fechaIso: string): string {
  const fecha = new Date(fechaIso);

  if (Number.isNaN(fecha.getTime())) {
    return '';
  }

  const desplazamientoMs = fecha.getTimezoneOffset() * 60_000;

  return new Date(
    fecha.getTime() - desplazamientoMs
  ).toISOString().slice(0, 16);
}

/**
 * Fecha local futura utilizada al crear borradores.
 */
function fechaLocalEnHoras(horas = 4): string {
  const futura = new Date(Date.now() + horas * 60 * 60 * 1000);
  return fechaIsoAInputLocal(futura.toISOString());
}


function prepararValoresEdicion(
  alerta: AlertaInterna
): FormularioAlertaValores | null {
  const info = alerta.info;

  if (
    alerta.msgType !== 'Alert' ||
    (alerta.lifecycleState !== 'DRAFT' &&
      alerta.lifecycleState !== 'REJECTED') ||
    typeof alerta.version !== 'number' ||
    !Number.isSafeInteger(alerta.version) ||
    alerta.version < 1 ||
    alerta.etag !== `"v${alerta.version}"` ||
    !info
  ) {
    return null;
  }

  if (
    !info.scenario ||
    !info.event ||
    !info.severity ||
    !info.urgency ||
    !info.certainty ||
    !info.headline ||
    !info.description ||
    !info.expires ||
    !info.areaDesc
  ) {
    return null;
  }

  const fechaLocal = fechaIsoAInputLocal(info.expires);

  if (!fechaLocal) {
    return null;
  }

  return {
    scenario: info.scenario,
    event: info.event,
    severity: info.severity,
    urgency: info.urgency,
    certainty: info.certainty,
    headline: info.headline,
    description: info.description,
    expires: fechaLocal,
    areaDesc: info.areaDesc,
  };
}

export function FormularioCrearAlerta({
  csrf,
  esSesionReal = false,
  alertaParaEditar,
  onCreada,
  onEditada,
  onCancelar,
}: Props) {
  const esSesionRealRef = useRef(esSesionReal);
  const solicitudRef = useRef(0);
  const modoAnteriorRef = useRef(esSesionReal);
  useLayoutEffect(() => {
    if (modoAnteriorRef.current !== esSesionReal) {
      solicitudRef.current += 1;
      setEnviando(false);
      setAlertaCreada(null);
      setDemoPayloadValidado(null);
      setErrorServidor(null);
    }
    modoAnteriorRef.current = esSesionReal;
    esSesionRealRef.current = esSesionReal;
  }, [esSesionReal]);
  useEffect(
    () => () => {
      solicitudRef.current += 1;
    },
    [],
  );

  const [valores, setValores] = useState<FormularioAlertaValores>(() =>
  (alertaParaEditar
    ? prepararValoresEdicion(alertaParaEditar)
    : null) ?? {
    scenario: 'INUNDACION',
    event: 'Crecida de caudal con desborde',
    severity: 'Severe',
    urgency: 'Expected',
    certainty: 'Likely',
    headline: 'SIMULACRO: Crecida del río Ficticio en sector bajo',
    description: 'Ejercicio de simulacro operativo. Se simula una crecida extraordinaria de caudal con anegamiento preventivo.',
    expires: fechaLocalEnHoras(4),
    areaDesc: 'Cuenca baja del río Ficticio (sector simulado)',
    }
);

  const [errores, setErrores] = useState<ErroresFormularioAlerta>({});
  const [enviando, setEnviando] = useState(false);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [alertaCreada, setAlertaCreada] = useState<AlertSummary | null>(null);
  const [demoPayloadValidado, setDemoPayloadValidado] = useState<AlertInput | null>(null);

  const actualizarCampo = <K extends keyof FormularioAlertaValores>(campo: K, valor: FormularioAlertaValores[K]) => {
    setValores((prev) => ({ ...prev, [campo]: valor }));
    if (errores[campo]) {
      setErrores((prev) => ({ ...prev, [campo]: undefined }));
    }
    setErrorServidor(null);
  };

  const enviarFormulario = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;

    setErrorServidor(null);
    const validacion = validarFormularioAlerta(valores);

    if (!validacion.ok || !validacion.payload) {
      setErrores(validacion.errores);
      return;
    }

    // AISLAMIENTO ESTRICTO DE SEGURIDAD (F4-A.1):
    // Si no es sesión real (modo DEMO / evaluación visual), se prohíbe cualquier mutación HTTP.
    if (!esSesionReal) {
      setDemoPayloadValidado(validacion.payload);
      return;
    }

    const contextoEdicion =
      alertaParaEditar &&
      prepararValoresEdicion(alertaParaEditar) &&
      typeof alertaParaEditar.version === 'number' &&
      typeof alertaParaEditar.etag === 'string'
        ? {
            id: alertaParaEditar.id,
            version: alertaParaEditar.version,
            etag: alertaParaEditar.etag,
          }
        : null;

    if (alertaParaEditar && !contextoEdicion) {
      setErrorServidor(
        'EDICIÓN BLOQUEADA · El detalle o la versión de esta alerta no son válidos. Vuelve a cargarla antes de editar.'
      );
      return;
    }

    setEnviando(true);
    const solicitud = ++solicitudRef.current;

    let res:
      | Awaited<ReturnType<typeof clienteAlertas.crearBorrador>>
      | Awaited<ReturnType<typeof clienteAlertas.editarBorrador>>;

    try {
      if (contextoEdicion) {
        res = await clienteAlertas.editarBorrador(
          contextoEdicion.id,
          validacion.payload,
          contextoEdicion.version,
          contextoEdicion.etag,
          csrf
        );
      } else {
        res = await clienteAlertas.crearBorrador(
          validacion.payload,
          csrf
        );
      }
    } catch {

      if (solicitud !== solicitudRef.current || !esSesionRealRef.current) return;
      setEnviando(false);
      setErrorServidor('ERROR DE RED · No fue posible comunicarse con la API. El borrador no se confirmó como persistido.');
      return;
    }
    if (solicitud !== solicitudRef.current || !esSesionRealRef.current) return;
    setEnviando(false);

    if (res.ok) {
      setAlertaCreada(res.alerta);

      if (contextoEdicion) {
        onEditada?.(res.alerta);
      } else {
        onCreada?.(res.alerta);
      }
    } else {

      if (res.motivo === 'no-disponible') {
        setErrorServidor(
          'API NO DISPONIBLE · El endpoint de alertas no respondió como disponible. La alerta no se confirmó como persistida.'
        );
      } else if (res.motivo === 'sin-sesion') {
        setErrorServidor('SESIÓN NO VÁLIDA (401) · Tu sesión de operador ha caducado. Vuelve a iniciar sesión.');
      } else if (res.motivo === 'prohibido') {
        setErrorServidor('ACCESO DENEGADO (403) · Solo el rol AUTHOR con token CSRF válido puede crear alertas.');
      } else if (res.motivo === 'invalido') {
        setErrorServidor('DATOS RECHAZADOS (422) · El servidor rechazó el payload del formulario por no cumplir el contrato.');
      } else if (res.motivo === 'conflicto') {
        setErrorServidor(
          alertaParaEditar
            ? 'CONFLICTO (409) · La versión de esta alerta cambió. Cancela la edición y vuelve a cargar el detalle actualizado.'
            : 'CONFLICTO (409) · Ya existe una alerta con este identificador o estado.'
        );
      } else if (res.motivo === 'error-red') {
        setErrorServidor('ERROR DE RED · No fue posible comunicarse con la API.');
      } else {
        setErrorServidor('ERROR DEL SERVIDOR (500) · No se pudo procesar la solicitud.');
      }
    }
  };

  // Vista de previsualización DEMO (sin mutación de red ni persistencia)
  if (!esSesionReal && demoPayloadValidado) {
    return (
      <article className="sig-detail-panel" aria-label="Validación local en modo DEMO">
        <div className="sig-detail-hero" style={{ borderColor: 'var(--sig-violet)' }}>
          <div className="sig-detail-label">
            <span style={{ color: 'var(--sig-violet)', fontWeight: 700 }}>
              VALIDACIÓN LOCAL EN MEMORIA (MODO DEMO)
            </span>
            <span style={{ marginLeft: 'auto' }} className="sig-badge-ciclo sig-badge-draft">
              SINTAXIS CAP VÁLIDA
            </span>
          </div>

          <h2 className="sig-detail-headline">{demoPayloadValidado.info.headline}</h2>

          <div
            style={{
              padding: '16px',
              background: 'rgba(152, 132, 246, 0.08)',
              border: '1px solid rgba(152, 132, 246, 0.25)',
              borderRadius: '6px',
              fontSize: '0.875rem',
              color: '#f0f4fc',
              lineHeight: 1.5,
              margin: '16px 0',
            }}
          >
            <p>
              <strong>Aislamiento verificado (F4-A.1):</strong> En modo DEMO de desarrollo, ninguna mutación HTTP ni token CSRF fue enviado a la API. No se persistieron datos en PostgreSQL ni se contactó a Neon.
            </p>
            <p style={{ marginTop: '8px', fontSize: '0.8125rem', color: 'var(--sig-text-secondary)' }}>
              El payload se validó únicamente en memoria. No es un borrador persistido ni concede permisos de emisión.
            </p>
            <pre
              style={{
                marginTop: '12px',
                padding: '12px',
                background: '#040711',
                borderRadius: '6px',
                border: '1px solid #1a2234',
                fontSize: '0.75rem',
                overflowX: 'auto',
                color: 'var(--sig-cyan)',
              }}
            >
              {JSON.stringify(demoPayloadValidado, null, 2)}
            </pre>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {onCancelar && (
              <button type="button" className="sig-btn sig-btn-secondary" onClick={onCancelar}>
                ← Volver a la Bandeja
              </button>
            )}
            <button
              type="button"
              className="sig-btn sig-btn-primary"
              onClick={() => setDemoPayloadValidado(null)}
            >
              ← Continuar editando formulario
            </button>
          </div>
        </div>
      </article>
    );
  }

  // Vista de confirmación de borrador creado en servidor real
  if (alertaCreada) {
    return (
      <article className="sig-detail-panel" aria-label="Confirmación de borrador creado">
        <div className="sig-detail-hero" style={{ borderColor: 'var(--sig-emerald)' }}>
          <div className="sig-detail-label">

            <span style={{ color: 'var(--sig-emerald)', fontWeight: 700 }}>
              {alertaParaEditar
                ? '✓ BORRADOR ACTUALIZADO EN SERVIDOR'
                : '✓ BORRADOR CREADO EN SERVIDOR'}
            </span>

            <span className="sig-detail-id">{alertaCreada.identifier}</span>
            <span style={{ marginLeft: 'auto' }} className="sig-badge-ciclo sig-badge-draft">
              {alertaCreada.lifecycleState}
            </span>
          </div>


          <h2 className="sig-detail-headline">
            {alertaParaEditar
              ? 'Cambios confirmados por el backend'
              : 'Borrador confirmado por el backend'}
          </h2>

          <div
            style={{
              padding: '16px',
              background: 'rgba(0, 229, 153, 0.08)',
              border: '1px solid rgba(0, 229, 153, 0.25)',
              borderRadius: '6px',
              fontSize: '0.875rem',
              color: '#f0f4fc',
              lineHeight: 1.5,
              margin: '16px 0',
            }}
          >
            <p>
              <strong>Respuesta confirmada por el backend:</strong>
                  {alertaParaEditar
                    ? 'Se actualizó el borrador con identificador '
                    : 'Se creó el borrador con identificador '}

              <code>{alertaCreada.identifier}</code> y estado <code>{alertaCreada.lifecycleState}</code>.
            </p>
            <p style={{ marginTop: '8px', fontSize: '0.8125rem', color: 'var(--sig-text-secondary)' }}>
              El contenido completo y la versión se consultan desde el endpoint de detalle. El envío a revisión requiere una confirmación aparte.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {onCancelar && (
              <button type="button" className="sig-btn sig-btn-secondary" onClick={onCancelar}>
                ← Volver a la Bandeja
              </button>
            )}
            <button
              type="button"
              className="sig-btn sig-btn-primary"
              onClick={() => {
                setAlertaCreada(null);
                setValores((prev) => ({
                  ...prev,
                  headline: 'SIMULACRO: ',
                  expires: fechaLocalEnHoras(4),
                }));
              }}
            >
              + Redactar otro borrador
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="sig-detail-panel" aria-label="Formulario de creación de alerta">
      <div className="sig-detail-hero">
        <div className="sig-detail-label">
          <span className="simulacro">SIMULACRO</span>

          <span style={{ color: 'var(--sig-cyan)', fontWeight: 700 }}>
            {alertaParaEditar ? 'EDITAR BORRADOR M2' : 'NUEVO BORRADOR M2'}
          </span>

          <span style={{ marginLeft: 'auto' }} className="sig-badge-ciclo sig-badge-draft">
            ROL: AUTHOR
          </span>
        </div>


        <h2 className="sig-detail-headline">
          {alertaParaEditar
            ? 'Editar Mensaje de Alerta'
            : 'Redactar Mensaje de Alerta'}
        </h2>

        <p className="sig-action-note" style={{ margin: '4px 0 16px' }}>
          Formulario de autoría según contrato OpenAPI v1.2 (<code>createAlert</code>). Todas las alertas emitidas
          deben identificar inequívocamente su naturaleza de SIMULACRO.
        </p>

        {!esSesionReal && (
          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(152, 132, 246, 0.1)',
              border: '1px solid rgba(152, 132, 246, 0.3)',
              borderRadius: '6px',
              fontSize: '0.8125rem',
              color: '#d6d3f8',
              lineHeight: 1.5,
              marginBottom: '16px',
            }}
          >
            <strong style={{ color: '#9884f6' }}>MODO DEMO AISLADO · Peticiones de red deshabilitadas</strong>
            <div style={{ marginTop: '4px', color: 'var(--sig-text-secondary)', fontSize: '0.75rem' }}>
              Este formulario se ejecuta en modo de inspección visual. No emitirá peticiones POST contra la API real ni alterará registros de base de datos.
            </div>
          </div>
        )}

        <form onSubmit={enviarFormulario} noValidate style={{ display: 'grid', gap: '16px' }}>
          {/* Fila 1: Escenario y Evento */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
            <div className="campo-grupo">
              <span className="campo-etiqueta-destacada">
                Escenario de simulacro *
              </span>
              <div className="sig-choice-group" role="radiogroup" aria-label="Escenario de simulacro">
                {[
                  { id: 'INUNDACION', label: 'Inundación' },
                  { id: 'DESLIZAMIENTO', label: 'Deslizamiento' },
                  { id: 'SISMO', label: 'Sismo' },
                ].map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={valores.scenario === s.id}
                    className={`sig-choice-pill ${valores.scenario === s.id ? 'sig-active' : ''}`}
                    onClick={() => actualizarCampo('scenario', s.id as EscenarioCAP)}
                    disabled={enviando}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {errores.scenario && <p className="aviso-error-campo">{errores.scenario}</p>}
            </div>

            <div className="campo-grupo">
              <label htmlFor="alerta-event" className="campo-etiqueta-destacada">
                Tipo de evento (1–120 caracteres) *
              </label>
              <input
                id="alerta-event"
                type="text"
                className="campo"
                value={valores.event}
                onChange={(e) => actualizarCampo('event', e.target.value)}
                placeholder="Ej: Crecida extraordinaria de caudal"
                disabled={enviando}
                aria-invalid={!!errores.event}
              />
              {errores.event && <p className="aviso-error-campo">{errores.event}</p>}
            </div>
          </div>

          {/* Fila 2: Severidad CAP */}
          <div className="campo-grupo">
            <span className="campo-etiqueta-destacada">
              Severidad CAP (Extreme y Severe requieren aprobación de otra persona) *
            </span>
            <div className="sig-choice-group" role="radiogroup" aria-label="Severidad CAP">
              {[
                { id: 'Extreme', label: 'Extreme (Crítica · 2 identidades)', clase: 'sig-choice-pill-extreme' },
                { id: 'Severe', label: 'Severe (Crítica · 2 identidades)', clase: 'sig-choice-pill-severe' },
                { id: 'Moderate', label: 'Moderate (Moderada)', clase: '' },
                { id: 'Minor', label: 'Minor (Menor)', clase: '' },
                { id: 'Unknown', label: 'Unknown (Sin clasificar)', clase: '' },
              ].map((sev) => (
                <button
                  key={sev.id}
                  type="button"
                  role="radio"
                  aria-checked={valores.severity === sev.id}
                  className={`sig-choice-pill ${sev.clase} ${valores.severity === sev.id ? 'sig-active' : ''}`}
                  onClick={() => actualizarCampo('severity', sev.id as SeveridadCAP)}
                  disabled={enviando}
                >
                  {sev.label}
                </button>
              ))}
            </div>
            {errores.severity && <p className="aviso-error-campo">{errores.severity}</p>}
          </div>

          {/* Fila 3: Urgencia y Certeza */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
            <div className="campo-grupo">
              <span className="campo-etiqueta-destacada">
                Urgencia CAP *
              </span>
              <div className="sig-choice-group" role="radiogroup" aria-label="Urgencia CAP">
                {[
                  { id: 'Immediate', label: 'Inmediata' },
                  { id: 'Expected', label: 'Esperada' },
                  { id: 'Future', label: 'Futura' },
                  { id: 'Past', label: 'Pasada' },
                  { id: 'Unknown', label: 'Desconocida' },
                ].map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    role="radio"
                    aria-checked={valores.urgency === u.id}
                    className={`sig-choice-pill ${valores.urgency === u.id ? 'sig-active' : ''}`}
                    onClick={() => actualizarCampo('urgency', u.id as UrgenciaCAP)}
                    disabled={enviando}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
              {errores.urgency && <p className="aviso-error-campo">{errores.urgency}</p>}
            </div>

            <div className="campo-grupo">
              <span className="campo-etiqueta-destacada">
                Certeza CAP *
              </span>
              <div className="sig-choice-group" role="radiogroup" aria-label="Certeza CAP">
                {[
                  { id: 'Observed', label: 'Observada' },
                  { id: 'Likely', label: 'Probable' },
                  { id: 'Possible', label: 'Posible' },
                  { id: 'Unlikely', label: 'Poco probable' },
                  { id: 'Unknown', label: 'Desconocida' },
                ].map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={valores.certainty === c.id}
                    className={`sig-choice-pill ${valores.certainty === c.id ? 'sig-active' : ''}`}
                    onClick={() => actualizarCampo('certainty', c.id as CertezaCAP)}
                    disabled={enviando}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {errores.certainty && <p className="aviso-error-campo">{errores.certainty}</p>}
            </div>
          </div>

          {/* Fila 3: Titular */}
          <div className="campo-grupo">
            <label htmlFor="alerta-headline" className="campo-etiqueta-destacada">
              Titular del boletín (10–200 caracteres, debe contener "SIMULACRO") *
            </label>
            <input
              id="alerta-headline"
              type="text"
              className="campo"
              value={valores.headline}
              onChange={(e) => actualizarCampo('headline', e.target.value)}
              placeholder="SIMULACRO: Crecida en río..."
              disabled={enviando}
              aria-invalid={!!errores.headline}
            />
            {errores.headline && <p className="aviso-error-campo">{errores.headline}</p>}
          </div>

          {/* Fila 4: Área afectada y Expiración */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
            <div className="campo-grupo">
              <label htmlFor="alerta-area" className="campo-etiqueta-destacada">
                Área geográfica afectada (3–200 caracteres) *
              </label>
              <input
                id="alerta-area"
                type="text"
                className="campo"
                value={valores.areaDesc}
                onChange={(e) => actualizarCampo('areaDesc', e.target.value)}
                placeholder="Ej: Sector Las Cañas, provincia de Ejemplo"
                disabled={enviando}
                aria-invalid={!!errores.areaDesc}
              />
              {errores.areaDesc && <p className="aviso-error-campo">{errores.areaDesc}</p>}
            </div>

            <div className="campo-grupo">
              <label htmlFor="alerta-expires" className="campo-etiqueta-destacada">
                Fecha y hora de expiración (UTC/Local) *
              </label>
              <input
                id="alerta-expires"
                type="datetime-local"
                className="campo"
                value={valores.expires}
                onChange={(e) => actualizarCampo('expires', e.target.value)}
                disabled={enviando}
                aria-invalid={!!errores.expires}
              />
              {errores.expires && <p className="aviso-error-campo">{errores.expires}</p>}
            </div>
          </div>

          {/* Fila 5: Descripción */}
          <div className="campo-grupo">
            <label htmlFor="alerta-description" className="campo-etiqueta-destacada">
              Descripción completa del evento (10–4000 caracteres) *
            </label>
            <textarea
              id="alerta-description"
              className="campo"
              rows={4}
              value={valores.description}
              onChange={(e) => actualizarCampo('description', e.target.value)}
              placeholder="Detalla las instrucciones y condiciones simuladas para la población..."
              disabled={enviando}
              aria-invalid={!!errores.description}
            />
            {errores.description && <p className="aviso-error-campo">{errores.description}</p>}
          </div>

          {/* Aviso de error del servidor */}
          {errorServidor && (
            <div
              role="alert"
              style={{
                padding: '12px 16px',
                background: 'rgba(255, 59, 92, 0.1)',
                border: '1px solid rgba(255, 59, 92, 0.35)',
                borderRadius: '6px',
                color: 'var(--sig-crimson)',
                fontSize: '0.8125rem',
                lineHeight: 1.5,
              }}
            >
              {errorServidor}
            </div>
          )}

          {/* Botones de acción */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '12px' }}>
            {onCancelar && (
              <button
                type="button"
                className="sig-btn sig-btn-secondary"
                onClick={onCancelar}
                disabled={enviando}
              >
                Cancelar
              </button>
            )}
            <button
              type="submit"
              className="sig-btn sig-btn-primary"
              disabled={enviando}
              style={{ minWidth: '180px' }}
            >
            {esSesionReal
              ? enviando
                ? 'Guardando en servidor…'
                : alertaParaEditar
                  ? 'Guardar cambios →'
                  : 'Crear Borrador DRAFT →'
              : 'Validar Formulario Localmente (Modo DEMO)'}
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}
