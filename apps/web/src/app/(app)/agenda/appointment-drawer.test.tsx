// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppointmentWithRelations, Patient, Professional, Service } from '@clinicas/shared'

/*
 * O drawer e o React sao reais; so a Server Action e simulada. E o reset do React
 * apos a action que esta sendo testado, entao ele precisa rodar de verdade.
 */
const save = vi.hoisted(() => vi.fn())
vi.mock('./agenda-actions', () => ({
  saveAppointmentAction: save,
  changeAppointmentStatusAction: vi.fn(async () => ({ error: null })),
}))
vi.mock('../pendencias/nova-pendencia', () => ({ NovaPendencia: () => null }))

import { AppointmentDrawer } from './appointment-drawer'

const PACIENTE = '11111111-1111-4111-8111-111111111111'
const PROFISSIONAL = '22222222-2222-4222-8222-222222222222'
const SERVICO = '33333333-3333-4333-8333-333333333333'
const SERVICO_INATIVO = '44444444-4444-4444-8444-444444444444'
const AGENDAMENTO = '55555555-5555-4555-8555-555555555555'
const AVISO = 'fingerprint-do-aviso'

const patients = [{ id: PACIENTE, name: 'Paciente A' }] as Patient[]
const professionals = [{ id: PROFISSIONAL, name: 'Profissional A' }] as Professional[]
const services = [{ id: SERVICO, name: 'Consulta', durationMinutes: 30 }] as Service[]

const respostaComAviso = {
  error: 'Este horario tem avisos.',
  warnings: [{ type: 'outside_availability', weekday: 5, availability: [] }],
  fingerprint: AVISO,
}

const existente = {
  id: AGENDAMENTO,
  patientId: PACIENTE,
  professionalId: PROFISSIONAL,
  serviceId: SERVICO,
  startsAt: '2026-12-04T13:00:00.000Z',
  endsAt: '2026-12-04T13:30:00.000Z',
  notes: 'Observacao original',
  status: 'scheduled',
  patientName: 'Paciente A',
  professionalName: 'Profissional A',
  serviceName: 'Consulta',
} as unknown as AppointmentWithRelations

function abrir(appointment?: AppointmentWithRelations) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(
    <AppointmentDrawer
      timezone="America/Sao_Paulo"
      patients={patients}
      professionals={professionals}
      services={services}
      equipe={[]}
      defaultDate="2026-12-04"
      appointment={appointment}
      onClose={onClose}
      onSaved={onSaved}
      onAviso={() => {}}
    />,
  )
  return { onClose, onSaved }
}

const seletor = (nome: 'patientId' | 'professionalId' | 'serviceId'): HTMLSelectElement => {
  const rotulo = {
    patientId: 'Paciente',
    professionalId: 'Profissional',
    serviceId: 'Servico (opcional)',
  }
  return screen.getByLabelText(rotulo[nome]) as HTMLSelectElement
}
const horario = (rotulo: 'Inicio' | 'Fim') => screen.getByLabelText(rotulo) as HTMLInputElement
const observacoes = () => screen.getByLabelText('Observacoes') as HTMLInputElement
const salvar = (nome: string) => fireEvent.click(screen.getByRole('button', { name: nome }))
const mudar = (el: Element, value: string) => fireEvent.change(el, { target: { value } })

/** O que chegou na Server Action, sem depender de como o formulario monta o FormData. */
function enviado(chamada: number) {
  const form = save.mock.calls[chamada]!.at(-1) as FormData
  const campo = (k: string) => form.get(k)
  return {
    patientId: campo('patientId'),
    professionalId: campo('professionalId'),
    serviceId: campo('serviceId'),
    startsAt: campo('startsAt'),
    endsAt: campo('endsAt'),
    notes: campo('notes'),
    acknowledgedWarnings: campo('acknowledgedWarnings'),
  }
}

function preencherNovo() {
  mudar(seletor('patientId'), PACIENTE)
  mudar(seletor('professionalId'), PROFISSIONAL)
  mudar(seletor('serviceId'), SERVICO)
  mudar(horario('Inicio'), '10:00')
  mudar(observacoes(), 'Retorno')
}

async function aguardarAviso() {
  await screen.findByRole('button', { name: 'Confirmar mesmo assim' })
}

beforeEach(() => save.mockReset())
afterEach(cleanup)

describe('AppointmentDrawer com avisos do servidor', () => {
  it('A) criar: o rascunho sobrevive ao aviso e a confirmacao envia o mesmo rascunho', async () => {
    save.mockResolvedValueOnce(respostaComAviso).mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir()
    preencherNovo()

    salvar('Agendar')
    await aguardarAviso()

    expect(seletor('patientId').value).toBe(PACIENTE)
    expect(seletor('professionalId').value).toBe(PROFISSIONAL)
    expect(seletor('serviceId').value).toBe(SERVICO)
    expect(horario('Inicio').value).toBe('10:00')
    expect(horario('Fim').value).toBe('10:30')
    expect(observacoes().value).toBe('Retorno')

    salvar('Confirmar mesmo assim')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

    expect(save).toHaveBeenCalledTimes(2)
    const { acknowledgedWarnings: ack1, ...primeiro } = enviado(0)
    const { acknowledgedWarnings: ack2, ...segundo } = enviado(1)
    expect(ack1).toBeNull()
    expect(ack2).toBe(AVISO)
    expect(segundo).toEqual(primeiro)
    expect(segundo).toMatchObject({
      patientId: PACIENTE,
      professionalId: PROFISSIONAL,
      serviceId: SERVICO,
      startsAt: '2026-12-04T13:00:00.000Z',
      endsAt: '2026-12-04T13:30:00.000Z',
      notes: 'Retorno',
    })
  })

  it('B) editar: um aviso nunca transforma o servico em vazio', async () => {
    save.mockResolvedValueOnce(respostaComAviso).mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir(existente)

    mudar(horario('Inicio'), '11:00')
    expect(horario('Fim').value).toBe('11:30')

    salvar('Salvar')
    await aguardarAviso()

    expect(seletor('serviceId').value).toBe(SERVICO)
    expect(horario('Fim').value).toBe('11:30')
    expect(observacoes().value).toBe('Observacao original')

    salvar('Confirmar mesmo assim')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

    expect(enviado(1)).toMatchObject({
      patientId: PACIENTE,
      professionalId: PROFISSIONAL,
      serviceId: SERVICO,
      startsAt: '2026-12-04T14:00:00.000Z',
      endsAt: '2026-12-04T14:30:00.000Z',
      notes: 'Observacao original',
      acknowledgedWarnings: AVISO,
    })
    expect(save.mock.calls[1]![0]).toBe(AGENDAMENTO)
  })

  it('C) cancelar o aviso nao envia nada alem da tentativa que o gerou', async () => {
    save.mockResolvedValueOnce(respostaComAviso)
    const { onClose, onSaved } = abrir()
    preencherNovo()

    salvar('Agendar')
    await aguardarAviso()
    salvar('Fechar')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    expect(enviado(0).acknowledgedWarnings).toBeNull()
  })

  it('D) "Sem servico" escolhido de verdade continua valendo, com aviso', async () => {
    save.mockResolvedValueOnce(respostaComAviso).mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir(existente)

    mudar(seletor('serviceId'), '')
    salvar('Salvar')
    await aguardarAviso()
    expect(seletor('serviceId').value).toBe('')

    salvar('Confirmar mesmo assim')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(enviado(1).serviceId).toBeFalsy()
    expect(enviado(1).acknowledgedWarnings).toBe(AVISO)
  })

  it('E) sem aviso, salva direto na primeira tentativa', async () => {
    save.mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir()
    preencherNovo()

    salvar('Agendar')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

    expect(save).toHaveBeenCalledTimes(1)
    expect(enviado(0)).toMatchObject({ serviceId: SERVICO, acknowledgedWarnings: null })
  })

  it('F) campos obrigatorios vazios continuam barrados', () => {
    abrir()
    salvar('Agendar')
    expect(save).not.toHaveBeenCalled()
  })

  it('G) servico que saiu da lista de ativos nao se perde ao editar', async () => {
    save.mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir({ ...existente, serviceId: SERVICO_INATIVO, serviceName: 'Antigo' })

    expect(seletor('serviceId').value).toBe(SERVICO_INATIVO)
    salvar('Salvar')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(enviado(0).serviceId).toBe(SERVICO_INATIVO)
  })
})
