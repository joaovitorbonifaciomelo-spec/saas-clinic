'use client'

import { useActionState } from 'react'
import { createClinicAction, type ActionState } from '../auth-actions'

const initialState: ActionState = { error: null }

export default function OnboardingPage() {
  const [state, formAction, pending] = useActionState(createClinicAction, initialState)

  return (
    <main className="container narrow">
      <h1>Criar sua clinica</h1>
      <p className="muted">Voce sera o administrador dela.</p>
      <form action={formAction} className="card form-card">
        <label>
          Nome da clinica
          <input name="name" type="text" required minLength={2} maxLength={120} />
        </label>
        {state.error ? <p className="error">{state.error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Criando...' : 'Criar clinica'}
        </button>
      </form>
    </main>
  )
}
