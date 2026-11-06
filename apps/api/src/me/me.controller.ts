import { Controller, Get, Inject, NotFoundException, UseGuards } from '@nestjs/common'
import type { MeResponse } from '@clinicas/shared'
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { ClinicsService } from '../clinics/clinics.service'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly clinics: ClinicsService,
    @Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient,
  ) {}

  /** Quem sou eu e de quais clinicas participo. E o que decide onboarding vs dashboard. */
  @Get()
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('id, full_name')
      .eq('id', user.id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)

    // Ausencia tratada aqui, explicitamente. Significa trigger handle_new_user
    // nao executado — estado inconsistente real, nao "recurso de outro tenant".
    if (!data) {
      throw new NotFoundException('Perfil nao encontrado.')
    }

    const memberships = await this.clinics.listMemberships(user.id)

    return {
      profile: { id: data.id, fullName: data.full_name, email: user.email },
      memberships,
    }
  }
}
