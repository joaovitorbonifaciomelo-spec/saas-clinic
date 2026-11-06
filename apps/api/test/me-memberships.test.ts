import { describe, expect, it } from 'vitest'
import { ClinicsService } from '../src/clinics/clinics.service'
import { MeController } from '../src/me/me.controller'
import type { AuthenticatedUser } from '../src/auth/auth.guard'
import type { UserScopedClient } from '../src/supabase/supabase.types'

const CLINICA = { id: 'clinica-1', name: 'Clinica', timezone: 'America/Sao_Paulo' }
const OUTRA = { id: 'clinica-2', name: 'Outra', timezone: 'America/Sao_Paulo' }
const ADMIN = 'user-admin'
const ATENDENTE = 'user-atendente'

/**
 * Devolve o que a policy real devolve: TODOS os membros das clinicas do usuario,
 * o admin primeiro. Quem quer so a propria linha precisa filtrar.
 */
const MEMBROS = [
  { user_id: ADMIN, clinic_id: CLINICA.id, role: 'admin', clinics: CLINICA },
  { user_id: ATENDENTE, clinic_id: CLINICA.id, role: 'attendant', clinics: CLINICA },
  { user_id: ATENDENTE, clinic_id: OUTRA.id, role: 'professional', clinics: OUTRA },
]

function fakeSupabase(): UserScopedClient {
  return {
    from(table: string) {
      const filtros: Array<[string, string]> = []
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: string) => {
          filtros.push([coluna, valor])
          return builder
        },
        order: () => builder,
        maybeSingle: async () => ({ data: { id: 'x', full_name: 'Nome' }, error: null }),
        then: (resolve: (r: unknown) => unknown) => {
          const linhas = table === 'clinic_members' ? MEMBROS : []
          const data = linhas.filter((l) =>
            filtros.every(([c, v]) => (l as Record<string, unknown>)[c] === v),
          )
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return builder
    },
  } as unknown as UserScopedClient
}

function me(userId: string) {
  const supabase = fakeSupabase()
  const controller = new MeController(new ClinicsService(supabase), supabase)
  return controller.me({ id: userId, email: 'a@b.c' } as AuthenticatedUser)
}

describe('/api/me com colegas na mesma clinica', () => {
  it('attendant recebe o proprio papel, nunca o do admin', async () => {
    const { memberships } = await me(ATENDENTE)
    const naClinica = memberships.filter((m) => m.clinicId === CLINICA.id)

    expect(naClinica).toHaveLength(1)
    expect(naClinica[0]!.role).toBe('attendant')
    expect(memberships.map((m) => m.role)).not.toContain('admin')
  })

  it('admin continua recebendo admin', async () => {
    const { memberships } = await me(ADMIN)

    expect(memberships).toHaveLength(1)
    expect(memberships[0]).toMatchObject({ clinicId: CLINICA.id, role: 'admin' })
  })

  it('usuario em duas clinicas recebe o proprio papel em cada uma', async () => {
    const { memberships } = await me(ATENDENTE)

    expect(memberships.map((m) => [m.clinicId, m.role])).toEqual([
      [CLINICA.id, 'attendant'],
      [OUTRA.id, 'professional'],
    ])
  })

  it('quem nao e membro nao recebe nenhuma linha', async () => {
    const { memberships } = await me('user-de-fora')

    expect(memberships).toEqual([])
  })
})
