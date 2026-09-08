import { z } from 'zod'
import type { ClinicRole } from './roles'

/* =============================================================================
   Estados
   -----------------------------------------------------------------------------
   Tres, e a lista e fechada de proposito.

   `overdue`, `today` e `upcoming` NAO estao aqui porque sao recortes de uma
   consulta, nao estados da pendencia: dependem do relogio, e um estado que muda
   sozinho com a passagem do tempo teria de ser reescrito por alguem. O recorte
   "Atrasadas" e `status = 'open' and due_at < inicio do dia local`, avaliado na
   hora da pergunta — nao confundir com `isPastDueNow`, que e outra coisa e esta
   documentado em `TaskListItem`.

   `in_progress` tambem nao: quem comecou uma ligacao que nao completou nao
   mudou o mundo, e a pendencia continua pendente. O estado so passaria a valer
   se alguem estivesse esperando por ele.
   ========================================================================== */

export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const
export const taskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Aberta',
  completed: 'Concluída',
  cancelled: 'Cancelada',
}

/**
 * Transicoes validas.
 *
 * `completed -> cancelled` e `cancelled -> completed` estao ausentes de
 * proposito: quem errou reabre primeiro. Duas transicoes explicitas deixam o
 * caminho legivel no historico, enquanto uma transicao direta entre terminais
 * apagaria a informacao de que houve engano.
 */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['completed', 'cancelled'],
  completed: ['open'],
  cancelled: ['open'],
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to)
}

/* =============================================================================
   Limites de texto
   -----------------------------------------------------------------------------
   FONTE UNICA. O CHECK do banco, o schema zod e o `maxLength` do input saem
   daqui. Tres numeros escritos em tres lugares divergem — normalmente quando
   alguem relaxa um e esquece os outros, e o sintoma aparece como erro 500 numa
   tela que validou.
   ========================================================================== */

export const TASK_TITLE_MIN = 3
export const TASK_TITLE_MAX = 200
export const TASK_DESCRIPTION_MAX = 2000

/** Metadata de evento nunca passa disto. Igual ao teto de `conversation_events`. */
export const TASK_EVENT_METADATA_MAX_BYTES = 2048

/* =============================================================================
   Tipos de evento
   ========================================================================== */

export const TASK_EVENT_TYPES = [
  'created',
  'details_changed',
  'assigned',
  'transferred',
  'released',
  'due_changed',
  'completed',
  'reopened',
  'cancelled',
] as const
export const taskEventTypeSchema = z.enum(TASK_EVENT_TYPES)
export type TaskEventType = z.infer<typeof taskEventTypeSchema>

export const TASK_EVENT_TYPE_LABELS: Record<TaskEventType, string> = {
  created: 'Criada',
  details_changed: 'Texto alterado',
  assigned: 'Assumida',
  transferred: 'Transferida',
  released: 'Devolvida à fila',
  due_changed: 'Prazo alterado',
  completed: 'Concluída',
  reopened: 'Reaberta',
  cancelled: 'Cancelada',
}

/* =============================================================================
   Metadata de evento — formato ESTRITO por tipo
   ========================================================================== */

const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Informe um instante ISO-8601 com fuso.' })

/** Campos que `details_changed` sabe descrever. */
export const TASK_EDITABLE_FIELDS = ['title', 'description'] as const
export const taskEditableFieldSchema = z.enum(TASK_EDITABLE_FIELDS)
export type TaskEditableField = z.infer<typeof taskEditableFieldSchema>

/**
 * SOMENTE OS NOMES DOS CAMPOS. Nunca o texto antigo nem o novo.
 *
 * A razao e aritmetica antes de ser estetica: `description` vai a 2000
 * caracteres e o teto de metadata sao 2048 bytes. Guardar `old` e `new`
 * estouraria a constraint numa unica edicao de descricao longa, e a operacao
 * falharia com uma mensagem que ninguem relacionaria a causa.
 *
 * Ha ainda o efeito colateral: `description` carrega instrucao operacional que
 * pode mencionar pessoas. Copia-la para os eventos a cada edicao criaria N
 * copias do mesmo texto sem que ninguem tenha pedido historico textual.
 *
 * A pergunta operacional e "alguem mexeu nisto?", nao "qual era a virgula
 * anterior". Quem precisa do texto atual le a tarefa.
 */
export const taskDetailsChangedMetadataSchema = z
  .object({
    fields: z
      .array(taskEditableFieldSchema)
      .min(1, 'details_changed sem campo alterado nao e um evento, e um no-op.')
      .refine((f) => new Set(f).size === f.length, 'Campo repetido em fields.'),
  })
  .strict()

/**
 * Snapshot minimo de um responsavel.
 *
 * Existe para o historico continuar legivel depois que a pessoa sai da clinica
 * ou muda de nome: `clinic_member_directory` responde quem e a responsavel
 * AGORA, e nao tem como responder quem era na epoca.
 *
 * Sem `role`. O papel do ator ja e capturado na coluna `actor_role_snapshot` do
 * evento, e o papel de QUEM RECEBEU a tarefa nao responde nenhuma pergunta
 * historica — duplica-lo aqui seria habito, nao necessidade.
 */
export const taskAssigneeSnapshotSchema = z
  .object({
    userId: z.uuid(),
    displayName: z.string().trim().min(1).max(120).nullable(),
  })
  .strict()
export type TaskAssigneeSnapshot = z.infer<typeof taskAssigneeSnapshotSchema>

export const taskAssignedMetadataSchema = z
  .object({ to: taskAssigneeSnapshotSchema })
  .strict()

export const taskTransferredMetadataSchema = z
  .object({
    /* Nulo quando a tarefa estava na fila geral: transferir de ninguem para
       alguem e uma transferencia legitima, e mentir um `from` seria pior. */
    from: taskAssigneeSnapshotSchema.nullable(),
    to: taskAssigneeSnapshotSchema,
  })
  .strict()

export const taskReleasedMetadataSchema = z
  .object({ from: taskAssigneeSnapshotSchema })
  .strict()

/** Os dois lados podem ser nulos: definir prazo, mudar prazo e remover prazo. */
export const taskDueChangedMetadataSchema = z
  .object({
    from: instantSchema.nullable(),
    to: instantSchema.nullable(),
  })
  .strict()
  .refine((m) => m.from !== m.to, 'due_changed sem mudanca de prazo e um no-op.')

/**
 * Vazio, e vazio por decisao.
 *
 * `completed`, `cancelled` e `reopened` ja tem tudo o que importa nas COLUNAS
 * do evento — ator, snapshot do nome, papel e instante. O que sobraria para a
 * metadata seria copia de coisa que ja esta na linha da tarefa.
 *
 * `reopened` nao carrega `from_status`: o evento terminal imediatamente anterior
 * no log ja diz de onde veio, e repetir criaria uma segunda fonte de verdade
 * capaz de discordar da primeira.
 *
 * `created` NAO usa este schema — ver `taskCreatedMetadataSchema` abaixo. Ele
 * fica quase sempre vazio, mas nao SEMPRE, e por isso tem tipo proprio.
 */
export const taskEmptyMetadataSchema = z.object({}).strict()

/**
 * `created` carrega, no maximo, uma chave: o responsavel inicial.
 *
 * Os ids de contexto nao entram: sao IMUTAVEIS e vivem na propria tarefa,
 * entao a copia so teria efeito no unico caso em que a linha perde a
 * referencia: exclusao do paciente. E, nesse caso, guardar o uuid de um
 * paciente apagado nao devolve nome nenhum — mantem apenas um vestigio de uma
 * associacao que o administrador pediu para apagar.
 *
 * `assignedTo`, ao contrario, existe para tapar um buraco real de auditoria:
 * uma tarefa pode nascer ja atribuida, e se essa pessoa for removida da
 * clinica antes de qualquer transferencia ou devolucao, o `ON DELETE SET
 * NULL` zera `assigned_to` SEM gerar evento — sem esta chave, quem era o
 * responsavel inicial desapareceria por completo. Mesmo formato de
 * `taskAssigneeSnapshotSchema` usado por `assigned`/`transferred`/`released`,
 * porque vem da mesma funcao SQL (`task_member_snapshot`).
 *
 * `source`, opcional, e identidade TECNICA — Confirmacoes v0.1 marca com ela
 * a Task que a propria automacao cria, para poder reconhecer e fechar
 * exatamente essa Task (e nenhuma outra do mesmo agendamento) quando o
 * agendamento sai de `awaiting_confirmation`. NUNCA vira UI: nenhuma tela
 * le esta chave para mostrar rotulo, badge ou filtro — quem cria a Task
 * automatica ja aparece como "Sistema" em `actorNameSnapshot`, o que basta
 * para a tela. Valor FECHADO (um unico literal aceito), nao texto livre —
 * cresce por uma nova opcao no union se um dia existir uma segunda origem
 * automatica. Espelha o CHECK `task_events_created_metadata` do banco.
 */
export const taskCreatedMetadataSchema = z
  .object({
    assignedTo: taskAssigneeSnapshotSchema.optional(),
    source: z.literal('appointment_confirmation').optional(),
  })
  .strict()

/**
 * Comprimento em BYTES de uma string UTF-8, sem depender do ambiente.
 *
 * Este pacote e compilado com `lib: ["ES2023"]` e `types: []` de proposito — ele
 * roda no servidor e no navegador, e nao pode presumir `Buffer` (Node) nem
 * `TextEncoder` (DOM/Node, mas ausente da lib declarada).
 *
 * `for...of` itera por CODE POINT e nao por unidade UTF-16, entao um emoji conta
 * como um caractere de 4 bytes em vez de dois de 3 — que e como o Postgres conta.
 */
function utf8ByteLength(texto: string): number {
  let bytes = 0
  for (const ch of texto) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Valida a metadata conforme o tipo do evento. Fecha o formato por tipo. */
export function parseTaskEventMetadata(
  eventType: TaskEventType,
  metadata: unknown,
):
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; error: string } {
  const schemas: Record<TaskEventType, z.ZodType> = {
    created: taskCreatedMetadataSchema,
    completed: taskEmptyMetadataSchema,
    cancelled: taskEmptyMetadataSchema,
    reopened: taskEmptyMetadataSchema,
    details_changed: taskDetailsChangedMetadataSchema,
    assigned: taskAssignedMetadataSchema,
    transferred: taskTransferredMetadataSchema,
    released: taskReleasedMetadataSchema,
    due_changed: taskDueChangedMetadataSchema,
  }

  const parsed = schemas[eventType].safeParse(metadata)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'metadata invalida.' }
  }

  /*
   * O teto vale para o objeto inteiro, nao por campo. Conferido aqui alem do
   * CHECK do banco para que o erro apareca na borda, com nome de campo, em vez
   * de virar violacao de constraint no meio de uma transacao.
   */
  // O teto vale para o objeto inteiro. Conferido aqui ALEM do CHECK do banco
  // para que o erro apareca na borda, com nome de campo, em vez de virar
  // violacao de constraint no meio de uma transacao. O banco continua sendo a
  // autoridade: ele conta a serializacao dele, que pode diferir em bytes.
  const bytes = utf8ByteLength(JSON.stringify(parsed.data))
  if (bytes > TASK_EVENT_METADATA_MAX_BYTES) {
    return { ok: false, error: `metadata excede ${TASK_EVENT_METADATA_MAX_BYTES} bytes.` }
  }

  return { ok: true, metadata: parsed.data as Record<string, unknown> }
}

/* =============================================================================
   Visoes da fila — consultas, nao colunas
   -----------------------------------------------------------------------------
   `overdue`, `today`, `upcoming` e `undated` formam uma PARTICAO COMPLETA de
   `status = 'open'`: toda tarefa aberta tem `due_at` nulo (undated) ou nao nulo,
   e nesse caso cai em exatamente uma das outras tres.

   Isso nao e detalhe de UI. E a garantia de que nenhuma pendencia aberta pode
   ficar invisivel — que e literalmente o que o modulo promete.
   ========================================================================== */

export const TASK_VIEWS = [
  'overdue',
  'today',
  'upcoming',
  'undated',
  'mine',
  'unassigned',
  'completed',
] as const
export const taskViewSchema = z.enum(TASK_VIEWS)
export type TaskView = z.infer<typeof taskViewSchema>

export const TASK_VIEW_LABELS: Record<TaskView, string> = {
  overdue: 'Atrasadas',
  today: 'Hoje',
  upcoming: 'Próximas',
  undated: 'Sem prazo',
  mine: 'Minhas',
  unassigned: 'Sem responsável',
  completed: 'Concluídas',
}

/** As quatro que cobrem, juntas, todas as pendências abertas. */
export const TASK_VIEWS_PARTITIONING_OPEN = [
  'overdue',
  'today',
  'upcoming',
  'undated',
] as const satisfies readonly TaskView[]

/* =============================================================================
   Entradas
   -----------------------------------------------------------------------------
   Todas `.strict()`. O que NAO aparece em nenhum schema, por construcao:

     clinicId      vem do header validado pelo guard, nunca do corpo
     createdBy     de auth.uid()
     completedBy   idem, e carimbado pela operacao
     cancelledBy   idem
     version       do servidor; o cliente manda expectedVersion, que e outra coisa
     timestamps    do servidor
     actor         do JWT
     metadata      montada pela RPC a partir do que ela mesma fez

   `.strict()` importa aqui mais do que de costume: sem ele, mandar `createdBy`
   nao daria erro — o campo seria descartado em silencio, e quem escreveu o
   cliente ficaria achando que a afirmacao valeu.
   ========================================================================== */

const titleSchema = z.string().trim().min(TASK_TITLE_MIN).max(TASK_TITLE_MAX)

const descriptionSchema = z
  .string()
  .trim()
  .max(TASK_DESCRIPTION_MAX)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional()

/**
 * Criacao. Unica operacao sem `expectedVersion` — nao ha versao anterior.
 *
 * Os tres contextos sao OPCIONAIS e podem vir todos nulos: uma pendencia sem
 * contexto e "pendencia geral da clinica", e e legitima. Forcar contexto
 * empurraria essas tarefas de volta para o papel ou faria alguem inventar um
 * paciente ficticio, que e pior.
 *
 * Os tres tambem sao IMUTAVEIS depois da criacao: nao existe operacao para
 * troca-los. Contexto responde "sobre o que esta acao nasceu", e reescreve-lo
 * depois mudaria o significado historico da tarefa. Contexto errado se resolve
 * cancelando e criando outra.
 */
export const createTaskSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    dueAt: instantSchema.nullable().optional(),
    assignedTo: z.uuid().nullable().optional(),
    patientId: z.uuid().nullable().optional(),
    conversationId: z.uuid().nullable().optional(),
    appointmentId: z.uuid().nullable().optional(),
  })
  .strict()

/**
 * Toda mutacao de CONTROLE carrega a versao que a tela viu.
 *
 * Obrigatoria e sem default. Um default silencioso (ou o campo opcional)
 * transformaria toda operacao numa corrida: quem esqueceu de mandar
 * sobrescreveria a decisao de quem chegou antes, e ninguem saberia.
 */
const versioned = z.object({
  expectedVersion: z.number().int().positive(),
})

/** Pelo menos um campo, senao a operacao e um no-op que gastaria uma versao. */
export const updateTaskDetailsSchema = versioned
  .extend({
    title: titleSchema.optional(),
    description: descriptionSchema,
  })
  .strict()
  .refine(
    (v) => v.title !== undefined || v.description !== undefined,
    'Informe título ou descrição.',
  )

/**
 * Atribuir uma pendencia que esta na fila geral a um membro EXPLICITO.
 *
 * `assigneeId` e obrigatorio inclusive quando a pessoa esta pegando a tarefa
 * para si. Um endpoint que so servisse para "eu" precisaria de um segundo
 * endpoint no dia em que servisse para "ela" — e dar a pendencia a uma colega
 * viraria assumir-e-transferir, duas versoes e dois eventos para uma decisao
 * so, com o historico contando uma sequencia que nao aconteceu.
 *
 * Quem EXECUTA sai do JWT; `assigneeId` e quem RECEBE.
 */
export const assignTaskSchema = versioned.extend({ assigneeId: z.uuid() }).strict()

export const releaseTaskSchema = versioned.strict()

export const transferTaskSchema = versioned.extend({ assigneeId: z.uuid() }).strict()

/** `null` remove o prazo. A tarefa volta para "Sem prazo", que e visao real. */
export const changeTaskDueSchema = versioned
  .extend({ dueAt: instantSchema.nullable() })
  .strict()

export const completeTaskSchema = versioned.strict()
export const cancelTaskSchema = versioned.strict()
export const reopenTaskSchema = versioned.strict()

export type CreateTaskInput = z.infer<typeof createTaskSchema>
export type UpdateTaskDetailsInput = z.infer<typeof updateTaskDetailsSchema>
export type AssignTaskInput = z.infer<typeof assignTaskSchema>
export type TransferTaskInput = z.infer<typeof transferTaskSchema>
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>
export type ChangeTaskDueInput = z.infer<typeof changeTaskDueSchema>
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>
export type CancelTaskInput = z.infer<typeof cancelTaskSchema>
export type ReopenTaskInput = z.infer<typeof reopenTaskSchema>
export type TaskControlInput = z.infer<typeof versioned>

/* =============================================================================
   Formas de leitura
   ========================================================================== */

export interface Task {
  id: string
  clinicId: string
  title: string
  description: string | null
  status: TaskStatus
  assignedTo: string | null
  dueAt: string | null
  patientId: string | null
  conversationId: string | null
  appointmentId: string | null
  createdBy: string | null
  completedBy: string | null
  completedAt: string | null
  cancelledBy: string | null
  cancelledAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface TaskEvent {
  id: string
  taskId: string
  eventType: TaskEventType
  actorUserId: string | null
  actorNameSnapshot: string | null
  actorRoleSnapshot: ClinicRole | null
  metadata: Record<string, unknown>
  createdAt: string
}

/** Contadores das sete abas, produzidos por UMA consulta agregada. */
export type TaskCounts = Record<TaskView, number>

/**
 * Resultado das operacoes controladas.
 *
 * Quatro respostas de recusa porque exigem quatro reacoes diferentes na tela:
 *
 *   not_found        a pendencia nao e sua, ou nao existe. Saia dela.
 *   conflict         voce viu um estado velho. Recarregue e decida de novo.
 *   invalid_state    voce viu o estado certo; a acao e que nao cabe nele.
 *   patient_mismatch a conversa ja aponta para outro paciente.
 *
 * Colapsar `invalid_state` em `conflict` faria a tela mandar recarregar quando
 * recarregar nao resolve — a pessoa recarregaria, veria o mesmo, e tentaria de
 * novo. Colapsar em `not_found` mandaria sair de uma pendencia que existe.
 */
export const TASK_OUTCOMES = [
  'ok',
  'conflict',
  'not_found',
  'invalid_state',
  'patient_mismatch',
] as const
export type TaskOutcome = (typeof TASK_OUTCOMES)[number]

/**
 * Por que a acao nao cabe no estado atual.
 *
 * Existe para a tela dizer a frase certa sem deduzir a partir de um codigo
 * generico — "esta pendencia esta concluída; reabra para editar" e uma
 * instrucao, "operacao invalida" e um beco sem saida.
 */
export const TASK_INVALID_REASONS = [
  /** Concluida ou cancelada: so `reopen` e aceito. */
  'terminal',
  /** Assumir exige fila geral; para tirar de outro, transfira. */
  'already_assigned',
  /** Transferir exige responsavel atual; nao vira assumir implicito. */
  'not_assigned',
  /** Entre terminais nao ha atalho: reabra primeiro. */
  'invalid_transition',
] as const
export type TaskInvalidReason = (typeof TASK_INVALID_REASONS)[number]

export const TASK_INVALID_REASON_LABELS: Record<TaskInvalidReason, string> = {
  terminal: 'Esta pendência já foi encerrada. Reabra para poder alterá-la.',
  already_assigned: 'Esta pendência já tem responsável. Use transferir.',
  not_assigned: 'Esta pendência está na fila geral. Use assumir.',
  invalid_transition: 'Reabra a pendência antes de mudar para este estado.',
}

/* =============================================================================
   Consulta da lista
   ========================================================================== */

/**
 * Recorte temporal. NAO e status persistido — e uma pergunta feita ao relogio
 * da clinica no momento da consulta.
 */
export const TASK_DUE_FILTERS = ['any', 'overdue', 'today', 'upcoming', 'none'] as const
export const taskDueFilterSchema = z.enum(TASK_DUE_FILTERS)
export type TaskDueFilter = z.infer<typeof taskDueFilterSchema>

export const TASK_ASSIGNMENT_FILTERS = ['any', 'mine', 'unassigned'] as const
export const taskAssignmentFilterSchema = z.enum(TASK_ASSIGNMENT_FILTERS)
export type TaskAssignmentFilter = z.infer<typeof taskAssignmentFilterSchema>

export const TASK_PAGE_LIMIT_DEFAULT = 50
export const TASK_PAGE_LIMIT_MAX = 100

/**
 * Filtros da lista, com as combinacoes sem sentido recusadas na borda.
 *
 * Aceitar uma combinacao incoerente e devolver 200 e pior do que recusar: a
 * tela pareceria funcionar, e quem escreveu a chamada so descobriria o
 * engano quando alguem reclamasse de uma lista vazia sem motivo.
 */
export const listTasksQuerySchema = z
  .object({
    status: taskStatusSchema.default('open'),
    due: taskDueFilterSchema.default('any'),
    assignment: taskAssignmentFilterSchema.default('any'),
    /** Filtro explicito por responsavel. Precisa ser membro da clinica ativa. */
    assigneeId: z.uuid().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TASK_PAGE_LIMIT_MAX)
      .default(TASK_PAGE_LIMIT_DEFAULT),
    cursor: z.string().optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    /*
     * Os recortes de prazo descrevem trabalho A FAZER. "Concluidas de hoje" nao
     * e a mesma pergunta que "concluidas cujo prazo era hoje", e a segunda nao
     * interessa a ninguem — responder qualquer uma das duas em silencio faria a
     * aba mentir sobre o que esta contando.
     */
    if (q.due !== 'any' && q.status !== 'open') {
      ctx.addIssue({
        code: 'custom',
        path: ['due'],
        message: 'O recorte de prazo so se aplica a pendencias abertas (status=open).',
      })
    }
    if (q.assigneeId !== undefined && q.assignment !== 'any') {
      ctx.addIssue({
        code: 'custom',
        path: ['assigneeId'],
        message: 'assigneeId nao pode ser combinado com assignment=mine ou unassigned.',
      })
    }
  })

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>

/* =============================================================================
   Read models
   ========================================================================== */

/** Nome ATUAL, do diretorio seguro. Historico vive em `task_events`. */
export interface TaskAssigneeSummary {
  userId: string
  displayName: string | null
}

export interface TaskPatientSummary {
  id: string
  name: string
  phone: string
}

/** O suficiente para orientar quem abre a pendencia. Sem mensagens. */
export interface TaskConversationSummary {
  id: string
  status: string
  contactName: string | null
  contactPhoneE164: string | null
}

/** O suficiente para situar no tempo. Sem carregar a agenda. */
export interface TaskAppointmentSummary {
  id: string
  startsAt: string
  status: string
  professionalName: string | null
}

/**
 * Item da lista.
 *
 * `description` fica de fora de proposito: a lista serve para RECONHECER e
 * operar a pendencia, e o detalhe ja devolve o texto. Trazer 2000 caracteres
 * por linha, cinquenta vezes, pagaria banda por algo que ninguem le na lista.
 */
export interface TaskListItem {
  id: string
  title: string
  status: TaskStatus
  dueAt: string | null
  /**
   * `due_at < agora`. NAO e a aba "Atrasadas".
   *
   * A aba usa `due_at < inicio de hoje` para que Atrasadas, Hoje, Proximas e
   * Sem prazo formem uma particao. Este campo e outra coisa: serve para marcar
   * visualmente uma pendencia de hoje cujo horario ja passou — ela continua na
   * aba Hoje, e e a tela que decide se destaca.
   */
  isPastDueNow: boolean
  assignedTo: string | null
  assignee: TaskAssigneeSummary | null
  isMine: boolean
  patientId: string | null
  patient: TaskPatientSummary | null
  /** Presenca do contexto, sem carregar o resumo: a lista nao precisa dele. */
  conversationId: string | null
  appointmentId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

/** Detalhe: os campos operacionais completos, mais o contexto resolvido. */
export interface TaskDetail extends Task {
  isPastDueNow: boolean
  assignee: TaskAssigneeSummary | null
  isMine: boolean
  patient: TaskPatientSummary | null
  conversation: TaskConversationSummary | null
  appointment: TaskAppointmentSummary | null
}

/* =============================================================================
   Contrato de erro das operacoes de controle

   Tres codigos, e a separacao e o ponto: cada um pede uma acao diferente da
   pessoa que esta na tela.

     task_conflict        "voce viu um estado velho"    -> recarregar
     task_invalid_state   "a acao nao cabe nesse estado" -> outra acao
     task_patient_mismatch "a conversa aponta para outro paciente" -> corrigir

   Colapsar os tres num 409 generico obrigaria a tela a oferecer "recarregue" —
   a saida certa para o primeiro e inutil para os outros dois.
   ========================================================================== */

export const TASK_CONFLICT_ERROR = 'task_conflict' as const
export const TASK_INVALID_STATE_ERROR = 'task_invalid_state' as const
export const TASK_PATIENT_MISMATCH_ERROR = 'task_patient_mismatch' as const

/**
 * Estado atual devolvido junto do erro, para a tela se reconciliar sem uma
 * segunda ida ao servidor.
 *
 * So acompanha a resposta quando o banco confirmou que quem perguntou AINDA e
 * membro da clinica. Perdida a membership, a resposta vira 404 — um corpo de
 * 409 nao pode virar canal de leitura para quem acabou de perder o acesso.
 */
export interface TaskConflictResponse {
  statusCode: 409
  error: typeof TASK_CONFLICT_ERROR
  message: string
  current: Task
}

export interface TaskInvalidStateResponse {
  statusCode: 409
  error: typeof TASK_INVALID_STATE_ERROR
  /** Sempre presente: e o que permite a tela dizer a frase certa. */
  reason: TaskInvalidReason
  message: string
  current: Task
}

/**
 * A conversa informada ja aponta para OUTRO paciente.
 *
 * Sem `current`: a pendencia nem chegou a existir — o erro acontece na
 * validacao da criacao, antes de qualquer INSERT.
 */
export interface TaskPatientMismatchResponse {
  statusCode: 409
  error: typeof TASK_PATIENT_MISMATCH_ERROR
  message: string
}

/** Evento como a API o devolve: metadata ja validada pelo tipo. */
export interface TaskEventView {
  id: string
  eventType: TaskEventType
  actorUserId: string | null
  actorNameSnapshot: string | null
  actorRoleSnapshot: ClinicRole | null
  metadata: Record<string, unknown>
  createdAt: string
}
