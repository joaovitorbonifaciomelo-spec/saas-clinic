'use client'

import { startTransition, useActionState, useEffect, useState, type FormEvent } from 'react'
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_TRANSITIONS,
  WEEKDAY_LABELS,
  type AppointmentWithRelations,
  type ClinicMemberSummary,
  type Patient,
  type Professional,
  type Service,
} from '@clinicas/shared'
import {
  changeAppointmentStatusAction,
  saveAppointmentAction,
  type AgendaActionState,
} from './agenda-actions'
import { draftToFormData, type AppointmentDraft } from './appointment-draft'
import { localDateKey, localTimeLabel } from './agenda-time'
import { NovaPendencia } from '../pendencias/nova-pendencia'
import { IconPlus } from '../../ui/icons'

const initialState: AgendaActionState = { error: null }

interface AppointmentDrawerProps {
  timezone: string
  patients: Patient[]
  professionals: Professional[]
  services: Service[]
  equipe: ClinicMemberSummary[]
  defaultDate?: string
  defaultTime?: string
  defaultProfessionalId?: string
  defaultPatientId?: string
  appointment?: AppointmentWithRelations
  onClose: () => void
  onSaved: () => void
  onAviso: (texto: string) => void
}

function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = hour! * 60 + minute! + minutes
  const wrapped = Math.min(total, 23 * 60 + 59)
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

export function AppointmentDrawer(props: AppointmentDrawerProps) {
  const editing = props.appointment
  const action = saveAppointmentAction.bind(null, editing?.id ?? null)
  const [state, formAction, pending] = useActionState(action, initialState)

  const [draft, setDraft] = useState<AppointmentDraft>(() => ({
    patientId: editing?.patientId ?? props.defaultPatientId ?? '',
    professionalId: editing?.professionalId ?? props.defaultProfessionalId ?? '',
    serviceId: editing?.serviceId ?? '',
    date: editing
      ? localDateKey(new Date(editing.startsAt), props.timezone)
      : (props.defaultDate ?? ''),
    startTime: editing
      ? localTimeLabel(editing.startsAt, props.timezone)
      : (props.defaultTime ?? '09:00'),
    endTime: editing
      ? localTimeLabel(editing.endsAt, props.timezone)
      : addMinutes(props.defaultTime ?? '09:00', 30),
    notes: editing?.notes ?? '',
  }))
  const patch = (changes: Partial<AppointmentDraft>) =>
    setDraft((current) => ({ ...current, ...changes }))

  useEffect(() => {
    if (state.ok) props.onSaved()
    // Observar apenas state.ok e proposital: reagir a mudanca do callback
    // reabriria o efeito a cada render do pai.
  }, [state.ok])

  /** Escolher servico calcula o fim pela duracao; sem servico, o fim e manual. */
  function applyService(nextServiceId: string): void {
    const service = props.services.find((s) => s.id === nextServiceId)
    patch({
      serviceId: nextServiceId,
      ...(service ? { endTime: addMinutes(draft.startTime, service.durationMinutes) } : {}),
    })
  }

  function applyStart(nextStart: string): void {
    const service = props.services.find((s) => s.id === draft.serviceId)
    patch({
      startTime: nextStart,
      ...(service ? { endTime: addMinutes(nextStart, service.durationMinutes) } : {}),
    })
  }

  /*
   * `<form action={fn}>` faz o React resetar o formulario quando a action termina,
   * e o reset volta os <select> ao padrao mesmo com `value` controlado: o estado
   * continua certo, mas a tela e o envio passavam a dizer "vazio". O aviso do
   * servidor e uma action que termina sem salvar, entao um reset ali apagava o
   * rascunho. Por isso o envio sai daqui, e sempre a partir do rascunho.
   *
   * O fingerprint e o dos avisos exibidos. Se a situacao mudar, o servidor recusa e
   * devolve os avisos novos.
   */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const form = draftToFormData(draft, props.timezone, state.fingerprint)
    startTransition(() => formAction(form))
  }

  // Um servico desativado nao vem na lista, mas continua sendo o deste agendamento.
  const servicoForaDaLista =
    editing?.serviceId && !props.services.some((s) => s.id === editing.serviceId)
      ? { id: editing.serviceId, name: editing.serviceName ?? 'Servico atual' }
      : null

  const nextStatuses = editing ? APPOINTMENT_STATUS_TRANSITIONS[editing.status] : []

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Agendamento">
      <div className="drawer">
        <div className="row">
          <h2>{editing ? 'Editar agendamento' : 'Novo agendamento'}</h2>
          <button type="button" className="secondary" onClick={props.onClose}>
            Fechar
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Paciente
            <select
              required
              value={draft.patientId}
              onChange={(event) => patch({ patientId: event.target.value })}
            >
              <option value="">Selecione…</option>
              {props.patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Profissional
            <select
              required
              value={draft.professionalId}
              onChange={(event) => patch({ professionalId: event.target.value })}
            >
              <option value="">Selecione…</option>
              {props.professionals.map((professional) => (
                <option key={professional.id} value={professional.id}>
                  {professional.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Servico (opcional)
            <select value={draft.serviceId} onChange={(event) => applyService(event.target.value)}>
              <option value="">Sem servico — duracao manual</option>
              {servicoForaDaLista ? (
                <option value={servicoForaDaLista.id}>{servicoForaDaLista.name}</option>
              ) : null}
              {props.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} ({service.durationMinutes} min)
                </option>
              ))}
            </select>
          </label>

          <div className="field-row">
            <label>
              Data
              <input
                type="date"
                required
                value={draft.date}
                onChange={(event) => patch({ date: event.target.value })}
              />
            </label>
            <label>
              Inicio
              <input
                type="time"
                required
                value={draft.startTime}
                onChange={(event) => applyStart(event.target.value)}
              />
            </label>
            <label>
              Fim
              <input
                type="time"
                required
                value={draft.endTime}
                onChange={(event) => patch({ endTime: event.target.value })}
              />
            </label>
          </div>

          <label>
            Observacoes
            <input
              type="text"
              value={draft.notes}
              onChange={(event) => patch({ notes: event.target.value })}
              maxLength={2000}
            />
          </label>

          {state.warnings && state.warnings.length > 0 ? (
            <div className="warnings">
              <strong>Avisos neste horario</strong>
              <ul>
                {state.warnings.map((warning, index) =>
                  warning.type === 'overlap' ? (
                    <li key={index}>
                      Conflito com{' '}
                      {warning.appointments
                        .map(
                          (a) =>
                            `${a.patientName} (${localTimeLabel(a.startsAt, props.timezone)}–${localTimeLabel(
                              a.endsAt,
                              props.timezone,
                            )}, ${APPOINTMENT_STATUS_LABELS[a.status]})`,
                        )
                        .join('; ')}
                    </li>
                  ) : (
                    <li key={index}>
                      Fora da disponibilidade de {WEEKDAY_LABELS[warning.weekday]}
                      {warning.availability.length === 0
                        ? ' — o profissional nao atende neste dia.'
                        : `: atende ${warning.availability
                            .map((w) => `${w.startTime.slice(0, 5)}–${w.endTime.slice(0, 5)}`)
                            .join(', ')}.`}
                    </li>
                  ),
                )}
              </ul>
              <p className="muted">
                Encaixe e permitido. Reenviar confirma exatamente estes avisos.
              </p>
            </div>
          ) : null}

          {state.error && !state.warnings ? <p className="error">{state.error}</p> : null}

          <button type="submit" disabled={pending}>
            {pending
              ? 'Salvando…'
              : state.fingerprint
                ? 'Confirmar mesmo assim'
                : editing
                  ? 'Salvar'
                  : 'Agendar'}
          </button>
        </form>

        {editing ? (
          <StatusPanel
            appointment={editing}
            nextStatuses={nextStatuses}
            onDone={props.onSaved}
            equipe={props.equipe}
            timezone={props.timezone}
            onAviso={props.onAviso}
          />
        ) : null}
      </div>
    </div>
  )
}

function StatusPanel({
  appointment,
  nextStatuses,
  onDone,
  equipe,
  timezone,
  onAviso,
}: {
  appointment: AppointmentWithRelations
  nextStatuses: readonly string[]
  onDone: () => void
  equipe: ClinicMemberSummary[]
  timezone: string
  onAviso: (texto: string) => void
}) {
  const action = changeAppointmentStatusAction.bind(null, appointment.id)
  const [state, formAction, pending] = useActionState(action, initialState)
  const [criandoPendencia, setCriandoPendencia] = useState(false)

  useEffect(() => {
    if (state.ok) onDone()
    // Observar apenas state.ok e proposital.
  }, [state.ok])

  return (
    <div className="status-panel">
      <h3>Status</h3>
      <p className="muted">Atual: {APPOINTMENT_STATUS_LABELS[appointment.status]}</p>

      {nextStatuses.length === 0 ? (
        <p className="muted">Este status e final — nao ha proxima transicao.</p>
      ) : (
        <form action={formAction} className="status-actions">
          {nextStatuses.map((status) => (
            <button
              key={status}
              type="submit"
              name="status"
              value={status}
              disabled={pending}
              className="secondary"
            >
              {APPOINTMENT_STATUS_LABELS[status as keyof typeof APPOINTMENT_STATUS_LABELS]}
            </button>
          ))}
        </form>
      )}

      {state.error ? <p className="error">{state.error}</p> : null}

      <button type="button" className="secondary" onClick={() => setCriandoPendencia(true)}>
        <IconPlus size={14} /> Criar pendência
      </button>

      {criandoPendencia ? (
        <NovaPendencia
          equipe={equipe}
          timezone={timezone}
          contexto={{
            appointmentId: appointment.id,
            patientId: appointment.patientId,
            patientName: appointment.patientName,
          }}
          onFechar={() => setCriandoPendencia(false)}
          onCriada={() => {
            // Fecha, avisa e fica no agendamento — nunca navega para
            // /pendencias sozinho.
            setCriandoPendencia(false)
            onAviso('Pendência criada.')
          }}
        />
      ) : null}
    </div>
  )
}
