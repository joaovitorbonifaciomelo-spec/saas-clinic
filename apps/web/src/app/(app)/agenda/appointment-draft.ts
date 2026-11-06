import { instantFromLocal } from './agenda-time'

/**
 * O agendamento como a pessoa esta montando. E a unica fonte do que vai para o
 * servidor: "Confirmar mesmo assim" reenvia este mesmo rascunho.
 */
export interface AppointmentDraft {
  patientId: string
  professionalId: string
  /** Vazio significa que a pessoa escolheu "Sem servico". */
  serviceId: string
  date: string
  startTime: string
  endTime: string
  notes: string
}

export function draftToFormData(
  draft: AppointmentDraft,
  timezone: string,
  acknowledgedWarnings: string | undefined,
): FormData {
  const form = new FormData()
  form.set('patientId', draft.patientId)
  form.set('professionalId', draft.professionalId)
  form.set('serviceId', draft.serviceId)
  form.set('startsAt', instantFromLocal(draft.date, draft.startTime, timezone).toISOString())
  form.set('endsAt', instantFromLocal(draft.date, draft.endTime, timezone).toISOString())
  form.set('notes', draft.notes)
  if (acknowledgedWarnings) form.set('acknowledgedWarnings', acknowledgedWarnings)
  return form
}
