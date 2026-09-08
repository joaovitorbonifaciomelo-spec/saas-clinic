import { describe, expect, it } from 'vitest'
import {
  TASK_DESCRIPTION_MAX,
  TASK_EVENT_METADATA_MAX_BYTES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  TASK_TITLE_MIN,
  TASK_VIEWS,
  TASK_VIEWS_PARTITIONING_OPEN,
  assignTaskSchema,
  canTransitionTask,
  cancelTaskSchema,
  changeTaskDueSchema,
  completeTaskSchema,
  createTaskSchema,
  parseTaskEventMetadata,
  reopenTaskSchema,
  transferTaskSchema,
  updateTaskDetailsSchema,
} from './task'

const UUID = '11111111-2222-4333-8444-555555555555'
const OUTRO = '99999999-8888-4777-8666-555555555555'
const INSTANTE = '2026-09-01T14:00:00.000Z'

describe('estados', () => {
  it('tem exatamente tres', () => {
    expect(TASK_STATUSES).toEqual(['open', 'completed', 'cancelled'])
  })

  it('permite as quatro transicoes aprovadas', () => {
    expect(canTransitionTask('open', 'completed')).toBe(true)
    expect(canTransitionTask('open', 'cancelled')).toBe(true)
    expect(canTransitionTask('completed', 'open')).toBe(true)
    expect(canTransitionTask('cancelled', 'open')).toBe(true)
  })

  it('recusa atalho entre terminais: quem errou reabre primeiro', () => {
    expect(canTransitionTask('completed', 'cancelled')).toBe(false)
    expect(canTransitionTask('cancelled', 'completed')).toBe(false)
  })

  it('recusa transicao para o mesmo estado', () => {
    for (const s of TASK_STATUSES) expect(canTransitionTask(s, s)).toBe(false)
  })
})

describe('visoes', () => {
  it('as quatro de prazo particionam as pendencias abertas', () => {
    // Nao e detalhe de UI: e a garantia de que nenhuma pendencia aberta some.
    expect(TASK_VIEWS_PARTITIONING_OPEN).toEqual(['overdue', 'today', 'upcoming', 'undated'])
    for (const v of TASK_VIEWS_PARTITIONING_OPEN) expect(TASK_VIEWS).toContain(v)
  })

  it('nao existe visao "todas": as sete sao recortes nomeados', () => {
    expect(TASK_VIEWS).not.toContain('all')
  })
})

describe('criacao', () => {
  it('aceita pendencia geral, sem contexto nenhum', () => {
    const r = createTaskSchema.safeParse({ title: 'Revisar encaixes de amanha' })
    expect(r.success).toBe(true)
  })

  it('aceita os tres contextos juntos', () => {
    const r = createTaskSchema.safeParse({
      title: 'Solicitar exame',
      patientId: UUID,
      conversationId: OUTRO,
      appointmentId: UUID,
    })
    expect(r.success).toBe(true)
  })

  it('recusa titulo curto demais e longo demais', () => {
    expect(createTaskSchema.safeParse({ title: 'ab' }).success).toBe(false)
    expect(createTaskSchema.safeParse({ title: 'a'.repeat(TASK_TITLE_MAX + 1) }).success).toBe(
      false,
    )
    expect(createTaskSchema.safeParse({ title: 'a'.repeat(TASK_TITLE_MIN) }).success).toBe(true)
  })

  it('recusa descricao acima do teto', () => {
    const r = createTaskSchema.safeParse({
      title: 'Titulo valido',
      description: 'x'.repeat(TASK_DESCRIPTION_MAX + 1),
    })
    expect(r.success).toBe(false)
  })

  it('normaliza descricao vazia para null', () => {
    const r = createTaskSchema.parse({ title: 'Titulo valido', description: '   ' })
    expect(r.description).toBeNull()
  })

  it('nao aceita expectedVersion: criacao nao tem versao anterior', () => {
    const r = createTaskSchema.safeParse({ title: 'Titulo valido', expectedVersion: 1 })
    expect(r.success).toBe(false)
  })

  /*
   * O ponto do `.strict()`. Sem ele estes campos seriam DESCARTADOS em silencio,
   * e quem escreveu o cliente ficaria achando que a afirmacao valeu.
   */
  it.each([
    ['clinicId', { clinicId: UUID }],
    ['createdBy', { createdBy: UUID }],
    ['completedBy', { completedBy: UUID }],
    ['cancelledBy', { cancelledBy: UUID }],
    ['completedAt', { completedAt: INSTANTE }],
    ['version', { version: 1 }],
    ['status', { status: 'completed' }],
    ['createdAt', { createdAt: INSTANTE }],
    ['metadata', { metadata: { qualquer: 'coisa' } }],
  ])('recusa %s vindo do cliente', (_nome, extra) => {
    const r = createTaskSchema.safeParse({ title: 'Titulo valido', ...extra })
    expect(r.success).toBe(false)
  })

  it('recusa prazo que nao seja instante com fuso', () => {
    expect(createTaskSchema.safeParse({ title: 'Titulo valido', dueAt: '2026-09-01' }).success).toBe(
      false,
    )
    expect(createTaskSchema.safeParse({ title: 'Titulo valido', dueAt: INSTANTE }).success).toBe(
      true,
    )
  })
})

describe('operacoes de controle', () => {
  it('exigem expectedVersion, sem default', () => {
    for (const schema of [completeTaskSchema, cancelTaskSchema, reopenTaskSchema]) {
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ expectedVersion: 1 }).success).toBe(true)
    }
    // Assumir tambem exige, e ainda leva o destinatario explicito.
    expect(assignTaskSchema.safeParse({ assigneeId: UUID }).success).toBe(false)
    expect(assignTaskSchema.safeParse({ expectedVersion: 1, assigneeId: UUID }).success).toBe(true)
  })

  it('recusam versao zero, negativa ou fracionaria', () => {
    for (const v of [0, -1, 1.5]) {
      expect(assignTaskSchema.safeParse({ expectedVersion: v, assigneeId: UUID }).success).toBe(false)
    }
  })

  it('assumir exige destinatario explicito', () => {
    // A tela sempre sabe para quem esta atribuindo, inclusive quando e para a
    // propria pessoa. Um endpoint que so serve para 'eu' precisaria de um
    // segundo endpoint no dia em que servir para 'ela'.
    expect(assignTaskSchema.safeParse({ expectedVersion: 1 }).success).toBe(false)
    expect(assignTaskSchema.safeParse({ expectedVersion: 1, assigneeId: 'nao-uuid' }).success).toBe(
      false,
    )
  })

  it('transferir exige destinatario', () => {
    expect(transferTaskSchema.safeParse({ expectedVersion: 1 }).success).toBe(false)
    expect(
      transferTaskSchema.safeParse({ expectedVersion: 1, assigneeId: UUID }).success,
    ).toBe(true)
  })

  it('prazo aceita null explicito para remover', () => {
    expect(changeTaskDueSchema.safeParse({ expectedVersion: 2, dueAt: null }).success).toBe(true)
  })

  it('prazo nao pode ser omitido: omitir e ambiguo entre "nao mexer" e "remover"', () => {
    expect(changeTaskDueSchema.safeParse({ expectedVersion: 2 }).success).toBe(false)
  })

  it('editar texto exige ao menos um campo', () => {
    expect(updateTaskDetailsSchema.safeParse({ expectedVersion: 3 }).success).toBe(false)
    expect(
      updateTaskDetailsSchema.safeParse({ expectedVersion: 3, title: 'Novo titulo' }).success,
    ).toBe(true)
    expect(
      updateTaskDetailsSchema.safeParse({ expectedVersion: 3, description: 'so a descricao' })
        .success,
    ).toBe(true)
  })

  it('nenhuma operacao de controle aceita contexto: contexto e imutavel', () => {
    for (const extra of [{ patientId: UUID }, { conversationId: UUID }, { appointmentId: UUID }]) {
      expect(updateTaskDetailsSchema.safeParse({ expectedVersion: 1, title: 'ok valido', ...extra }).success).toBe(
        false,
      )
    }
  })
})

describe('metadata de evento', () => {
  it('details_changed aceita so nomes de campo', () => {
    const r = parseTaskEventMetadata('details_changed', { fields: ['title', 'description'] })
    expect(r.ok).toBe(true)
  })

  it('details_changed recusa old/new textual', () => {
    const r = parseTaskEventMetadata('details_changed', {
      fields: ['title'],
      old: { title: 'antigo' },
      new: { title: 'novo' },
    })
    expect(r.ok).toBe(false)
  })

  it('details_changed recusa lista vazia e campo repetido', () => {
    expect(parseTaskEventMetadata('details_changed', { fields: [] }).ok).toBe(false)
    expect(parseTaskEventMetadata('details_changed', { fields: ['title', 'title'] }).ok).toBe(false)
  })

  it('details_changed recusa campo desconhecido', () => {
    expect(parseTaskEventMetadata('details_changed', { fields: ['dueAt'] }).ok).toBe(false)
  })

  it('due_changed aceita os dois lados nulos, menos ambos iguais', () => {
    expect(parseTaskEventMetadata('due_changed', { from: null, to: INSTANTE }).ok).toBe(true)
    expect(parseTaskEventMetadata('due_changed', { from: INSTANTE, to: null }).ok).toBe(true)
    expect(parseTaskEventMetadata('due_changed', { from: null, to: null }).ok).toBe(false)
  })

  it('assigned carrega snapshot do responsavel', () => {
    const r = parseTaskEventMetadata('assigned', { to: { userId: UUID, displayName: 'Ana' } })
    expect(r.ok).toBe(true)
  })

  it('snapshot aceita nome nulo: conta sem perfil ainda e rastreavel pelo id', () => {
    expect(
      parseTaskEventMetadata('assigned', { to: { userId: UUID, displayName: null } }).ok,
    ).toBe(true)
  })

  it('snapshot nao carrega role: seria duplicar por habito', () => {
    const r = parseTaskEventMetadata('assigned', {
      to: { userId: UUID, displayName: 'Ana', role: 'admin' },
    })
    expect(r.ok).toBe(false)
  })

  it('transferred aceita from nulo (saiu da fila geral) e exige to', () => {
    expect(
      parseTaskEventMetadata('transferred', {
        from: null,
        to: { userId: UUID, displayName: 'Ana' },
      }).ok,
    ).toBe(true)
    expect(parseTaskEventMetadata('transferred', { from: null }).ok).toBe(false)
  })

  it('released exige o responsavel anterior', () => {
    expect(
      parseTaskEventMetadata('released', { from: { userId: UUID, displayName: 'Ana' } }).ok,
    ).toBe(true)
    expect(parseTaskEventMetadata('released', {}).ok).toBe(false)
  })

  it.each(['completed', 'cancelled', 'reopened'] as const)('%s tem metadata vazia', (tipo) => {
    expect(parseTaskEventMetadata(tipo, {}).ok).toBe(true)
    expect(parseTaskEventMetadata(tipo, { qualquer: 'coisa' }).ok).toBe(false)
  })

  it('created fica vazia quando nasce sem responsavel', () => {
    expect(parseTaskEventMetadata('created', {}).ok).toBe(true)
    expect(parseTaskEventMetadata('created', { qualquer: 'coisa' }).ok).toBe(false)
  })

  it('created carrega o snapshot do responsavel quando nasce ja atribuida', () => {
    const r = parseTaskEventMetadata('created', {
      assignedTo: { userId: UUID, displayName: 'Ana' },
    })
    expect(r.ok).toBe(true)
    expect(r.ok && r.metadata).toEqual({ assignedTo: { userId: UUID, displayName: 'Ana' } })
  })

  it('created aceita nome nulo no snapshot do responsavel', () => {
    expect(
      parseTaskEventMetadata('created', { assignedTo: { userId: UUID, displayName: null } }).ok,
    ).toBe(true)
  })

  it('created rejeita snapshot sem userId ou com campo a mais', () => {
    expect(parseTaskEventMetadata('created', { assignedTo: {} }).ok).toBe(false)
    expect(
      parseTaskEventMetadata('created', {
        assignedTo: { userId: UUID, displayName: 'Ana', role: 'admin' },
      }).ok,
    ).toBe(false)
  })

  it('created aceita source=appointment_confirmation (identidade tecnica de Confirmacoes)', () => {
    const r = parseTaskEventMetadata('created', { source: 'appointment_confirmation' })
    expect(r.ok).toBe(true)
    expect(r.ok && r.metadata).toEqual({ source: 'appointment_confirmation' })
  })

  it('created aceita source junto com assignedTo — os dois nao sao mutuamente exclusivos', () => {
    const r = parseTaskEventMetadata('created', {
      source: 'appointment_confirmation',
      assignedTo: { userId: UUID, displayName: 'Ana' },
    })
    expect(r.ok).toBe(true)
  })

  it('created rejeita qualquer valor de source alem do unico literal aceito', () => {
    expect(parseTaskEventMetadata('created', { source: 'outra_coisa' }).ok).toBe(false)
    expect(parseTaskEventMetadata('created', { source: '' }).ok).toBe(false)
  })

  it('reopened nao carrega from_status: o evento anterior no log ja diz', () => {
    expect(parseTaskEventMetadata('reopened', { from_status: 'completed' }).ok).toBe(false)
  })

  it('recusa metadata acima do teto de bytes', () => {
    const enorme = { fields: ['title'], extra: 'x'.repeat(TASK_EVENT_METADATA_MAX_BYTES) }
    expect(parseTaskEventMetadata('details_changed', enorme).ok).toBe(false)
  })

  it('conta BYTES e nao caracteres', () => {
    // Um acento ocupa dois bytes; o CHECK do banco usa octet_length.
    const nome = 'ã'.repeat(115)
    const r = parseTaskEventMetadata('assigned', { to: { userId: UUID, displayName: nome } })
    expect(r.ok).toBe(true) // cabe, mas so porque contamos certo
  })
})
