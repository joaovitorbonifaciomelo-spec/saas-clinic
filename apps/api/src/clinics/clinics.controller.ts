import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
import {
  createClinicSchema,
  type Clinic,
  type ClinicMemberSummary,
  type ClinicMembership,
} from '@clinicas/shared'
import type { CreateClinicInput } from '@clinicas/shared'
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { ActiveClinicId } from './active-clinic.decorator'
import { ClinicMembershipGuard } from './clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ClinicsService } from './clinics.service'

@Controller('clinics')
@UseGuards(AuthGuard)
export class ClinicsController {
  constructor(private readonly clinics: ClinicsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ClinicMembership[]> {
    return this.clinics.listMemberships(user.id)
  }

  /**
   * Equipe da clinica ATIVA — a do header X-Clinic-Id.
   *
   * O ClinicMembershipGuard entra so nesta rota: as outras duas do controller
   * respondem sobre o proprio usuario e nao dependem de clinica ativa.
   */
  @Get('members')
  @UseGuards(ClinicMembershipGuard)
  members(@ActiveClinicId() clinicId: string): Promise<ClinicMemberSummary[]> {
    return this.clinics.listMembers(clinicId)
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createClinicSchema)) body: CreateClinicInput,
  ): Promise<Clinic> {
    return this.clinics.createClinic(body)
  }
}
