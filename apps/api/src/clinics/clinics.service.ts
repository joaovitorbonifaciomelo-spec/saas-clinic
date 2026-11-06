import { Inject, Injectable } from '@nestjs/common'
import type {
  Clinic,
  ClinicMemberSummary,
  ClinicMembership,
  ClinicRole,
  CreateClinicInput,
} from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

interface MembershipRow {
  clinic_id: string
  role: ClinicRole
  clinics: { id: string; name: string; timezone: string } | null
}

interface ClinicRow {
  id: string
  name: string
  timezone: string
  created_at: string
}

@Injectable()
export class ClinicsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  /**
   * Equipe da clinica ativa, para a tela exibir nomes e montar o seletor de
   * transferencia.
   *
   * Fica aqui, e nao em ConversationsService, porque a equipe e da CLINICA — o
   * Atendimento e so o primeiro consumidor. Nao virou recurso de topo
   * (`/clinic-members`) porque a clinica ja e o recurso: a rota e
   * `GET /clinics/members`, e qual clinica vem do header que o guard validou.
   *
   * NAO E AUTORIZACAO. Quem pode receber uma transferencia continua sendo
   * decidido pela FK composta (clinic_id, assigned_to) -> clinic_members, dentro
   * de `conversation_transfer`. Uma lista desatualizada produz no maximo uma
   * opcao que o banco recusa; nunca uma transferencia indevida aceita.
   *
   * O read model do banco ja limita o que sai: user_id, nome e papel. Nao ha
   * e-mail nem metadados para filtrar aqui, e a policy de `profiles` continua
   * intacta — a funcao e SECURITY DEFINER e valida o membership de quem
   * pergunta antes de ler qualquer coisa.
   */
  async listMembers(clinicId: string): Promise<ClinicMemberSummary[]> {
    const { data, error } = await this.supabase.rpc('clinic_member_directory', {
      p_clinic_id: clinicId,
    })
    if (error) throw mapPostgrestError(error)

    const linhas = (data ?? []) as {
      user_id: string
      display_name: string | null
      role: ClinicRole
    }[]

    return linhas.map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      role: m.role,
    }))
  }

  /**
   * Clinicas do usuario, com o papel DELE em cada uma.
   *
   * O filtro por user_id e necessario: a policy de clinic_members deixa o membro
   * ver todos os colegas da clinica. Sem ele, cada colega virava uma "membership"
   * deste usuario, e o papel exibido era o do membro mais antigo.
   */
  async listMemberships(userId: string): Promise<ClinicMembership[]> {
    const { data, error } = await this.supabase
      .from('clinic_members')
      .select('clinic_id, role, clinics ( id, name, timezone )')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw mapPostgrestError(error)

    return (data as unknown as MembershipRow[])
      .filter((row) => row.clinics !== null)
      .map((row) => ({
        clinicId: row.clinic_id,
        clinicName: row.clinics!.name,
        clinicTimezone: row.clinics!.timezone,
        role: row.role,
      }))
  }

  /**
   * Onboarding. Passa pela RPC porque `clinics` nao tem policy de INSERT e
   * `clinic_members` nao tem policy de escrita: clinica e membership admin
   * nascem juntas, na mesma transacao, ou nao nascem.
   */
  async createClinic(input: CreateClinicInput): Promise<Clinic> {
    const { data, error } = await this.supabase
      .rpc('create_clinic_with_owner', { p_name: input.name })
      .single()

    if (error) throw mapPostgrestError(error)

    const row = data as unknown as ClinicRow
    return { id: row.id, name: row.name, timezone: row.timezone, createdAt: row.created_at }
  }
}
