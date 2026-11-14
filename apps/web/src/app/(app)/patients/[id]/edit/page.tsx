import { notFound } from 'next/navigation'
import type { Patient } from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getActiveSession } from '../../../../session'
import { updatePatientAction } from '../../patient-actions'
import { PatientForm } from '../../patient-form'

export const dynamic = 'force-dynamic'

export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { activeClinic } = await getActiveSession()

  let patient: Patient
  try {
    patient = await apiFetch<Patient>(`/api/patients/${id}`, { clinicId: activeClinic.clinicId })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  const action = updatePatientAction.bind(null, patient.id)

  return (
    <div className="content">
      <div className="page-head">
        <h1>Editar paciente</h1>
      </div>
      <PatientForm
        action={action}
        patient={patient}
        submitLabel="Salvar alteracoes"
        cancelHref={`/patients?p=${patient.id}`}
      />
    </div>
  )
}
