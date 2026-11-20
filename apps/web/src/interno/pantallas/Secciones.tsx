// Vistas del portal por rol. Las capacidades disponibles corresponden a operaciones integradas
// con la API real; las diferidas no se presentan como acciones habilitadas.
import { useId } from 'react';
import { TITULOS } from '../../app/router.mjs';
import { Icono } from '../../componentes/Icono';
import { Titulo } from '../../componentes/Titulo';
import type { UsuarioInterno } from '../cliente-auth.mjs';
import { BandejaOperativa } from '../bandeja/BandejaOperativa';
import { BandejaAdministracion } from '../admin/BandejaAdministracion';
import { BandejaRevision } from '../revision/BandejaRevision';
import { horaLocal } from '../fechas';
import { NOMBRE_ROL } from '../roles.mjs';
import { useSesion } from '../sesion';

type EstadoCapacidad = 'disponible' | 'diferida' | 'fuera';

interface Capacidad {
  titulo: string;
  detalle: string;
  estado: EstadoCapacidad;
  /** operationId del OpenAPI que la respaldará, si existe. */
  operacion?: string;
}

const ROTULO: Record<EstadoCapacidad, string> = {
  disponible: 'Disponible en el portal',
  diferida: 'Diferida en el MVP (ENM-002)',
  fuera: 'Fuera de este portal',
};

function ListaCapacidades({ titulo, capacidades }: { titulo: string; capacidades: readonly Capacidad[] }) {
  const id = useId();
  return (
    <section className="capacidades" aria-labelledby={id}>
      <h2 id={id}>{titulo}</h2>
      <ul>
        {capacidades.map((c) => (
          <li key={c.titulo} className={`capacidad capacidad-${c.estado}`}>
            <div className="capacidad-cabeza">
              <h3>{c.titulo}</h3>
              <p className="capacidad-estado">
                <Icono nombre={c.estado === 'disponible' ? 'check' : 'dash'} />
                <span>{ROTULO[c.estado]}</span>
              </p>
            </div>
            <p>{c.detalle}</p>
            {c.operacion ? (
              <p className="capacidad-op">
                Contrato: <code>{c.operacion}</code>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const AUTOR: readonly Capacidad[] = [
  {
    titulo: 'Crear y editar borradores',
    detalle: 'Redactar una alerta Alert de SIMULACRO y corregirla mientras sea borrador.',
    estado: 'disponible',
    operacion: 'createAlert · updateDraftAlert',
  },
  {
    titulo: 'Enviar a revisión',
    detalle: 'Congelar la versión y pedir la aprobación de otra persona con rol de aprobación.',
    estado: 'disponible',
    operacion: 'submitAlert',
  },
  {
    titulo: 'Solicitar la emisión',
    detalle: 'Tras la aprobación, pedir la firma y el anclaje. «En proceso» no es «publicada».',
    estado: 'diferida',
  },
  {
    titulo: 'Actualizaciones y cancelaciones',
    detalle: 'Emitir Update o Cancel sobre una alerta anterior.',
    estado: 'diferida',
  },
];

const APROBADOR: readonly Capacidad[] = [
  {
    titulo: 'Revisar alertas críticas pendientes',
    detalle: 'Leer los bytes exactos congelados de una alerta Severe o Extreme de otra persona, como texto no confiable.',
    estado: 'disponible',
    operacion: 'readInternalAlert',
  },
  {
    titulo: 'Aprobar sobre un digest y una versión',
    detalle: 'La decisión se ata al SHA-256 de la instantánea y a su versión; un conflicto obliga a releer.',
    estado: 'disponible',
    operacion: 'approveAlert',
  },
  {
    titulo: 'Rechazar con motivo',
    detalle: 'Motivo de 3 a 500 caracteres; la corrección crea otra versión en borrador.',
    estado: 'disponible',
    operacion: 'rejectAlert',
  },
];

const ADMINISTRADOR: readonly Capacidad[] = [
  {
    titulo: 'Alta de cuentas de la demostración',
    detalle:
      'Se hace con la herramienta local de aprovisionamiento, en presencia de la persona y con su propio TOTP. No hay alta ni invitación desde esta web.',
    estado: 'fuera',
  },
  {
    titulo: 'Gestión de usuarios',
    detalle: 'Alta, desactivación y reinvitación por HTTP.',
    estado: 'diferida',
    operacion: 'createUser · setUserStatus · prepareUserReinvitation',
  },
  {
    titulo: 'Consultar alertas y auditoría',
    detalle: 'Ver los estados resumidos de las alertas SIMULACRO y sus eventos de auditoría confirmados por la API.',
    estado: 'disponible',
  },
  {
    titulo: 'Crear, aprobar o firmar alertas',
    detalle: 'No corresponde a la administración: los roles son excluyentes.',
    estado: 'fuera',
  },
];

export function SeccionInicio({ usuario, confirmada }: { usuario: UsuarioInterno; confirmada: number }) {
  const id = useId();
  const capacidades = usuario.rol === 'AUTHOR' ? AUTOR : usuario.rol === 'APPROVER' ? APROBADOR : ADMINISTRADOR;
  return (
    <>
      <Titulo>{TITULOS.portal}</Titulo>
      <section className="ficha-sesion" aria-labelledby={id}>
        <h2 id={id}>Tu sesión</h2>
        <dl>
          <dt>Nombre</dt>
          <dd>{usuario.nombre}</dd>
          <dt>Correo</dt>
          <dd>{usuario.correo}</dd>
          <dt>Rol</dt>
          <dd>{NOMBRE_ROL[usuario.rol]}</dd>
        </dl>
        <p className="nota">
          Confirmada por el servidor a las {horaLocal(confirmada)}. El rol lo asigna el servidor; los permisos se
          comprueban en cada operación, no en esta pantalla.
        </p>
      </section>
      <ListaCapacidades titulo="Lo que podrás hacer con este rol" capacidades={capacidades} />
    </>
  );
}

// SeccionAlertas (F3): muestra la Bandeja Operativa SIGNATURE real.
// Usa useSesion() para obtener usuario, rol y csrf sin prop-drilling desde AppInterna.
// Si por algún motivo la sesión no está activa aquí (no debería ocurrir, pues AppInterna
// ya lo controla), muestra un aviso de espera.
export function SeccionAlertas() {
  const sesion = useSesion();

  if (sesion.fase !== 'activa') {
    return (
      <>
        <Titulo>{TITULOS['portal-alertas']}</Titulo>
        <p className="estado-seccion">
          <Icono nombre="clock" clase="ico ico-grande" />
          <span>Verificando sesión…</span>
        </p>
      </>
    );
  }

  const { usuario, csrf } = sesion;
  // Iniciales para el avatar (máximo 2 caracteres)
  const iniciales = usuario.nombre
    .split(' ')
    .slice(0, 2)
    .map((p: string) => p[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <BandejaOperativa
      nombreUsuario={usuario.nombre}
      rol={usuario.rol}
      iniciales={iniciales}
      csrf={csrf}
    />
  );
}

export function SeccionRevision() {
  const sesion = useSesion();

  if (sesion.fase !== 'activa') {
    return (
      <>
        <Titulo>{TITULOS['portal-revision']}</Titulo>
        <p className="estado-seccion" role="status">
          <Icono nombre="clock" clase="ico ico-grande" />
          <span>Verificando sesión…</span>
        </p>
      </>
    );
  }

  if (sesion.usuario.rol !== 'APPROVER') {
    return (
      <>
        <Titulo>{TITULOS['portal-revision']}</Titulo>
        <p className="estado-seccion" role="alert">
          <Icono nombre="dash" clase="ico ico-grande" />
          <span>Esta sección requiere una sesión real con rol APPROVER. El rol visual no concede permisos.</span>
        </p>
      </>
    );
  }

  return (
    <>
      <Titulo>{TITULOS['portal-revision']}</Titulo>
      <BandejaRevision
        rol={sesion.usuario.rol}
        usuarioId={sesion.usuario.id}
        csrf={sesion.csrf}
        esSesionReal={true}
      />
      <p className="nota">
        La decisión vincula la identidad APPROVER con los bytes congelados, su digest y versión. No constituye firma institucional ES256 ni evidencia blockchain.
      </p>
    </>
  );
}

export function SeccionAdministracion() {
  const sesion = useSesion();

  if (sesion.fase !== 'activa' || sesion.usuario.rol !== 'ADMIN') {
    return (
      <>
        <Titulo>{TITULOS['portal-administracion']}</Titulo>
        <p className="estado-seccion" role="alert">
          <Icono nombre="dash" clase="ico ico-grande" />
          <span>Esta sección requiere una sesión real con rol ADMIN.</span>
        </p>
      </>
    );
  }

  return (
    <>
      <Titulo>{TITULOS['portal-administracion']}</Titulo>
      <BandejaAdministracion />
      <ListaCapacidades titulo="Administración en el MVP" capacidades={ADMINISTRADOR} />
    </>
  );
}
