import { getActiveSession } from '../../../session'
import { createPatientAction } from '../patient-actions'
import { PatientForm } from '../patient-form'

export const dynamic = 'force-dynamic'

export default async function NewPatientPage() {
  await getActiveSession()

  return (
    <div className="content">
      <div className="page-head">
        <h1>Novo paciente</h1>
      </div>
      <PatientForm action={createPatientAction} submitLabel="Salvar" />
    </div>
  )
}
