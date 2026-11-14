'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createPatientSchema, updatePatientSchema, type Patient } from '@clinicas/shared'
import { apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'

export interface PatientFormState {
  error: string | null
}

function readForm(formData: FormData) {
  return {
    name: formData.get('name'),
    phone: formData.get('phone'),
    birthDate: (formData.get('birthDate') as string) || null,
    insuranceProvider: (formData.get('insuranceProvider') as string) || null,
  }
}

export async function createPatientAction(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const parsed = createPatientSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  // clinicId vem SEMPRE da sessao validada no servidor, nunca do formulario.
  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<Patient>('/api/patients', {
      method: 'POST',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Falha ao salvar.' }
  }

  revalidatePath('/patients')
  redirect('/patients')
}

export type QuickCreatePatientResult =
  { ok: true; patient: Pick<Patient, 'id' | 'name' | 'phone'> } | { ok: false; error: string }

/**
 * Cadastro rapido de dentro do agendamento. Mesma validacao e mesma API do
 * cadastro completo, mas devolve o paciente em vez de navegar: quem chama
 * continua na agenda, com o agendamento que estava montando.
 */
export async function quickCreatePatientAction(input: {
  name: string
  phone: string
}): Promise<QuickCreatePatientResult> {
  const parsed = createPatientSchema.safeParse({
    name: input.name,
    phone: input.phone,
    birthDate: null,
    insuranceProvider: null,
  })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  const { activeClinic } = await requireActiveSession()

  try {
    const patient = await apiFetch<Patient>('/api/patients', {
      method: 'POST',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
    revalidatePath('/patients')
    return { ok: true, patient: { id: patient.id, name: patient.name, phone: patient.phone } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Falha ao cadastrar.' }
  }
}

export async function updatePatientAction(
  patientId: string,
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const parsed = updatePatientSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<Patient>(`/api/patients/${patientId}`, {
      method: 'PATCH',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Falha ao salvar.' }
  }

  revalidatePath('/patients')
  redirect(`/patients/${patientId}`)
}
