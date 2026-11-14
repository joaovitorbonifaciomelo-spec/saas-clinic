// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppointmentWithRelations, Patient, Professional, Service } from '@clinicas/shared'

/*
 * O drawer e o React sao reais; so as Server Actions sao simuladas. E o reset do
 * React apos a action que esta sendo testado, entao ele precisa rodar de verdade.
 */
const save = vi.hoisted(() => vi.fn())
const quickCreate = vi.hoisted(() => vi.fn())
vi.mock('./agenda-actions', () => ({
  saveAppointmentAction: save,
  changeAppointmentStatusAction: vi.fn(async () => ({ error: null })),
}))
vi.mock('../patients/patient-actions', () => ({ quickCreatePatientAction: quickCreate }))
vi.mock('../pendencias/nova-pendencia', () => ({ NovaPendencia: () => null }))

import { AppointmentDrawer } from './appointment-drawer'
import { filtrarPacientes } from './patient-picker'

const PACIENTE = '11111111-1111-4111-8111-111111111111'
const JOSE = '66666666-6666-4666-8666-666666666666'
const NOVO = '77777777-7777-4777-8777-777777777777'
const PROFISSIONAL = '22222222-2222-4222-8222-222222222222'
const SERVICO = '33333333-3333-4333-8333-333333333333'
const SERVICO_INATIVO = '44444444-4444-4444-8444-444444444444'
const AGENDAMENTO = '55555555-5555-4555-8555-555555555555'
const AVISO = 'fingerprint-do-aviso'

const patients = [
  { id: PACIENTE, name: 'Paciente A', phone: '11911112222' },
  { id: JOSE, name: 'José Antônio Souza', phone: '11988887777' },
] as Patient[]
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

const busca = () => screen.getByRole('combobox', { name: 'Paciente' }) as HTMLInputElement
const seletor = (rotulo: 'Profissional' | 'Servico (opcional)') =>
  screen.getByLabelText(rotulo) as HTMLSelectElement
const horario = (rotulo: 'Inicio' | 'Fim') => screen.getByLabelText(rotulo) as HTMLInputElement
const observacoes = () => screen.getByLabelText('Observacoes') as HTMLInputElement
const salvar = (nome: string) => fireEvent.click(screen.getByRole('button', { name: nome }))
const mudar = (el: Element, value: string) => fireEvent.change(el, { target: { value } })
const opcoes = () =>
  within(screen.getByRole('listbox'))
    .queryAllByRole('option')
    .map((o) => o.textContent)

function escolherPaciente(digitado: string, nome: string) {
  mudar(busca(), digitado)
  fireEvent.mouseDown(screen.getByRole('option', { name: new RegExp(nome) }))
}

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

function preencherRestante() {
  mudar(seletor('Profissional'), PROFISSIONAL)
  mudar(seletor('Servico (opcional)'), SERVICO)
  mudar(horario('Inicio'), '10:00')
  mudar(observacoes(), 'Retorno')
}

function preencherNovo() {
  escolherPaciente('Paciente', 'Paciente A')
  preencherRestante()
}

async function aguardarAviso() {
  await screen.findByRole('button', { name: 'Confirmar mesmo assim' })
}

beforeEach(() => {
  save.mockReset()
  quickCreate.mockReset()
})
afterEach(cleanup)

describe('AppointmentDrawer com avisos do servidor', () => {
  it('A) criar: o rascunho sobrevive ao aviso e a confirmacao envia o mesmo rascunho', async () => {
    save.mockResolvedValueOnce(respostaComAviso).mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir()
    preencherNovo()

    salvar('Agendar')
    await aguardarAviso()

    expect(busca().value).toBe('Paciente A')
    expect(seletor('Profissional').value).toBe(PROFISSIONAL)
    expect(seletor('Servico (opcional)').value).toBe(SERVICO)
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

    expect(busca().value).toBe('Paciente A')
    mudar(horario('Inicio'), '11:00')
    expect(horario('Fim').value).toBe('11:30')

    salvar('Salvar')
    await aguardarAviso()

    expect(seletor('Servico (opcional)').value).toBe(SERVICO)
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

    mudar(seletor('Servico (opcional)'), '')
    salvar('Salvar')
    await aguardarAviso()
    expect(seletor('Servico (opcional)').value).toBe('')

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

    expect(seletor('Servico (opcional)').value).toBe(SERVICO_INATIVO)
    salvar('Salvar')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(enviado(0).serviceId).toBe(SERVICO_INATIVO)
  })
})

describe('Busca de paciente no agendamento', () => {
  it('H) acha por parte do nome sem acento e por telefone', () => {
    abrir()

    mudar(busca(), 'jose souza')
    expect(opcoes()[0]).toContain('José Antônio Souza')
    expect(opcoes()).not.toContainEqual(expect.stringContaining('Paciente A'))

    mudar(busca(), '98888')
    expect(opcoes()[0]).toContain('José Antônio Souza')

    mudar(busca(), 'ninguem com esse nome')
    expect(screen.getByText('Nenhum paciente encontrado')).toBeTruthy()
    expect(opcoes()).toEqual(['+ Cadastrar "ninguem com esse nome"'])
  })

  it('I) teclado: seta e Enter escolhem, sem enviar o agendamento', async () => {
    save.mockResolvedValueOnce({ error: null, ok: true })
    abrir()

    mudar(busca(), 'antonio')
    fireEvent.keyDown(busca(), { key: 'Enter' })
    expect(busca().value).toBe('José Antônio Souza')
    expect(save).not.toHaveBeenCalled()

    preencherRestante()
    salvar('Agendar')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(enviado(0).patientId).toBe(JOSE)
  })

  it('J) sem paciente escolhido, avisa e nao envia', () => {
    abrir()
    preencherRestante()
    mudar(busca(), 'Paciente')
    salvar('Agendar')

    expect(screen.getByRole('alert').textContent).toMatch(/Escolha um paciente/)
    expect(save).not.toHaveBeenCalled()
  })

  it('K) cadastra o paciente sem sair do agendamento e ja seleciona', async () => {
    quickCreate.mockResolvedValueOnce({
      ok: true,
      patient: { id: NOVO, name: 'Maria Nova', phone: '11977776666' },
    })
    save.mockResolvedValueOnce({ error: null, ok: true })
    const { onSaved } = abrir()
    preencherRestante()

    mudar(busca(), 'Maria Nova')
    fireEvent.mouseDown(screen.getByRole('option', { name: '+ Cadastrar "Maria Nova"' }))

    const bloco = screen.getByRole('group', { name: 'Novo paciente' })
    expect((within(bloco).getByLabelText('Nome') as HTMLInputElement).value).toBe('Maria Nova')
    mudar(within(bloco).getByLabelText('Telefone'), '(11) 97777-6666')
    fireEvent.click(within(bloco).getByRole('button', { name: 'Cadastrar e selecionar' }))

    await waitFor(() => expect(busca().value).toBe('Maria Nova'))
    expect(quickCreate).toHaveBeenCalledWith({ name: 'Maria Nova', phone: '(11) 97777-6666' })
    expect(screen.queryByRole('group', { name: 'Novo paciente' })).toBeNull()

    // O resto do agendamento continua como estava.
    expect(seletor('Profissional').value).toBe(PROFISSIONAL)
    expect(seletor('Servico (opcional)').value).toBe(SERVICO)
    expect(horario('Inicio').value).toBe('10:00')
    expect(observacoes().value).toBe('Retorno')

    salvar('Agendar')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(enviado(0)).toMatchObject({ patientId: NOVO, serviceId: SERVICO, notes: 'Retorno' })
  })

  it('L) telefone digitado na busca vai para o campo de telefone', () => {
    abrir()
    mudar(busca(), '(11) 95555-4444')
    fireEvent.mouseDown(screen.getByRole('option', { name: /Cadastrar/ }))

    const bloco = screen.getByRole('group', { name: 'Novo paciente' })
    expect((within(bloco).getByLabelText('Nome') as HTMLInputElement).value).toBe('')
    expect((within(bloco).getByLabelText('Telefone') as HTMLInputElement).value).toBe(
      '(11) 95555-4444',
    )
  })

  it('M) erro no cadastro mostra a mensagem e nao perde nada', async () => {
    quickCreate.mockResolvedValueOnce({ ok: false, error: 'Telefone invalido.' })
    abrir()
    preencherRestante()

    mudar(busca(), 'Maria Nova')
    fireEvent.mouseDown(screen.getByRole('option', { name: /Cadastrar/ }))
    const bloco = screen.getByRole('group', { name: 'Novo paciente' })
    mudar(within(bloco).getByLabelText('Telefone'), '11900000000')
    fireEvent.click(within(bloco).getByRole('button', { name: 'Cadastrar e selecionar' }))

    expect((await within(bloco).findByRole('alert')).textContent).toBe('Telefone invalido.')
    expect((within(bloco).getByLabelText('Nome') as HTMLInputElement).value).toBe('Maria Nova')
    expect(seletor('Servico (opcional)').value).toBe(SERVICO)
    expect(observacoes().value).toBe('Retorno')
    expect(save).not.toHaveBeenCalled()
  })

  it('N) validacao local: sem nome ou sem DDD nem chama o servidor', () => {
    abrir()
    mudar(busca(), 'X')
    fireEvent.mouseDown(screen.getByRole('option', { name: /Cadastrar/ }))
    const bloco = screen.getByRole('group', { name: 'Novo paciente' })

    fireEvent.click(within(bloco).getByRole('button', { name: 'Cadastrar e selecionar' }))
    expect(within(bloco).getByRole('alert').textContent).toBe('Informe o nome do paciente.')

    mudar(within(bloco).getByLabelText('Nome'), 'Maria Nova')
    mudar(within(bloco).getByLabelText('Telefone'), '9999')
    fireEvent.click(within(bloco).getByRole('button', { name: 'Cadastrar e selecionar' }))
    expect(within(bloco).getByRole('alert').textContent).toBe('Informe o telefone com DDD.')
    expect(quickCreate).not.toHaveBeenCalled()
  })

  it('O) cancelar o cadastro volta para a busca sem criar nada', () => {
    abrir()
    mudar(busca(), 'Maria Nova')
    fireEvent.mouseDown(screen.getByRole('option', { name: /Cadastrar/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(screen.queryByRole('group', { name: 'Novo paciente' })).toBeNull()
    expect(busca().disabled).toBe(false)
    expect(quickCreate).not.toHaveBeenCalled()
  })

  it('P) digitar depois de escolher desfaz a escolha', () => {
    abrir()
    escolherPaciente('Paciente', 'Paciente A')
    mudar(busca(), 'Paciente B')
    preencherRestante()
    salvar('Agendar')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('filtrarPacientes', () => {
  const lista = [
    { id: '1', name: 'Ana Maria', phone: '11911110000' },
    { id: '2', name: 'Mariana Lopes', phone: '11922220000' },
    { id: '3', name: 'João Mário', phone: '21933330000' },
  ]

  it('quem comeca com o termo vem primeiro', () => {
    expect(filtrarPacientes(lista, 'mari').map((p) => p.id)).toEqual(['2', '1', '3'])
  })

  it('telefone so filtra a partir de 3 digitos', () => {
    expect(filtrarPacientes(lista, '21').map((p) => p.id)).toEqual([])
    expect(filtrarPacientes(lista, '219').map((p) => p.id)).toEqual(['3'])
  })

  it('busca vazia mostra os primeiros, limitada', () => {
    expect(filtrarPacientes(lista, '', 2).map((p) => p.id)).toEqual(['1', '2'])
  })
})
