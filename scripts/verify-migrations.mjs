/**
 * Executa a cadeia INTEIRA de migrations num Postgres efemero (PGlite, em
 * memoria) e afirma as garantias que so aparecem rodando SQL de verdade.
 *
 * POR QUE ISSO EXISTE
 *
 * Um `as $` no lugar de `as $$` passa por lint, por typecheck e por revisao de
 * diff — e so falha quando o Postgres tenta parsear. Aconteceu neste projeto,
 * causado por `String.replace` interpretando `$$` na string de substituicao
 * como um `$` literal. Nenhuma ferramenta de JavaScript enxerga esse tipo de
 * erro; um Postgres de verdade enxerga na primeira linha.
 *
 * O QUE ISSO NAO E
 *
 * Nao substitui os testes contra o Supabase. PGlite nao tem PostgREST, nem o
 * servidor de auth, nem a reconciliacao de privilegios da plataforma. O que ele
 * garante: a cadeia parseia, executa na ordem, e as constraints, triggers e
 * funcoes se comportam como escrito.
 *
 *   pnpm verify:migrations
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
// pgcrypto nao vem por padrao no PGlite; a fundacao o exige na 0001.
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(raiz, 'supabase', 'migrations')

let falhas = 0
let checagens = 0

function ok(nome, extra = '') {
  checagens += 1
  console.log(`  [32mOK[0m   ${nome}${extra ? ` — ${extra}` : ''}`)
}
function falhou(nome, detalhe) {
  falhas += 1
  checagens += 1
  console.log(`  [31mFALHA[0m ${nome}\n        ${detalhe}`)
}

async function afirma(nome, fn) {
  try {
    const r = await fn()
    if (r === false) falhou(nome, 'condicao falsa')
    else ok(nome, typeof r === 'string' ? r : '')
  } catch (e) {
    falhou(nome, e.message.split('\n')[0])
  }
}

/** Espera que a operacao FALHE, e opcionalmente com uma marca no erro. */
async function afirmaRecusa(nome, fn, marca) {
  try {
    await fn()
    falhou(nome, 'deveria ter sido recusado, mas passou')
  } catch (e) {
    const msg = `${e.message} ${e.code ?? ''}`
    if (marca && !msg.includes(marca)) {
      falhou(nome, `recusado por outro motivo: ${msg.split('\n')[0]}`)
    } else {
      ok(nome)
    }
  }
}

const db = new PGlite({ extensions: { pgcrypto } })

/** Roda como um usuario autenticado especifico, como o PostgREST faria. */
async function comoUsuario(userId, fn) {
  await db.exec('begin')
  // SET nao aceita parametro; set_config com is_local=true e o equivalente.
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId }),
  ])
  await db.exec('set local role authenticated')
  try {
    const r = await fn()
    await db.exec('commit')
    return r
  } catch (e) {
    await db.exec('rollback')
    throw e
  }
}

try {
  console.log('\n  === 1. Cadeia de migrations ===\n')

  await db.exec(readFileSync(join(raiz, 'supabase', 'local', 'shim.sql'), 'utf8'))
  ok('shim do Supabase aplicado')

  const arquivos = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const arquivo of arquivos) {
    const sql = readFileSync(join(migrationsDir, arquivo), 'utf8')
    try {
      await db.exec(sql)
      ok(arquivo)
    } catch (e) {
      falhou(arquivo, `${e.message.split('\n')[0]}`)
      // Sem esta migration, nada abaixo faz sentido.
      throw new Error(`migration ${arquivo} falhou; interrompendo`, { cause: e })
    }
  }

  // ---------------------------------------------------------------- cenario
  console.log('\n  === 2. Cenario de duas clinicas ===\n')

  const mk = async (rot) => {
    const { rows } = await db.query(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1, $2) returning id`,
      [`${rot}@example.test`, JSON.stringify({ full_name: `Usuario ${rot}` })],
    )
    return rows[0].id
  }
  const userA = await mk('a')
  const userA2 = await mk('a2')
  const userB = await mk('b')

  const criarClinica = async (userId, nome) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(`select id from public.create_clinic_with_owner($1)`, [nome])
      return rows[0].id
    })

  const clinicA = await criarClinica(userA, 'Clinica A')
  const clinicB = await criarClinica(userB, 'Clinica B')
  await db.query(`insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')`, [clinicA, userA2])
  ok('duas clinicas com membros')

  const inserirPaciente = (userId, clinicId, nome) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.patients (clinic_id, name, phone) values ($1,$2,'11987650000')
         returning id`,
        [clinicId, nome],
      )
      return rows[0].id
    })
  const pacienteA = await inserirPaciente(userA, clinicA, 'Paciente A')
  const pacienteB = await inserirPaciente(userB, clinicB, 'Paciente B')

  /** Cria pela funcao controlada — o unico caminho que authenticated tem. */
  const novaConversa = (userId, clinicId, extra = {}) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, $2, $3, $4) as r`,
        [
          clinicId,
          extra.contact_phone_e164 ?? null,
          extra.contact_name_snapshot ?? null,
          extra.patient_id ?? null,
        ],
      )
      const r = rows[0].r
      if (r.outcome !== 'ok') {
        const e = new Error(`create_manual devolveu ${r.outcome}`)
        e.code = r.outcome === 'exists' ? '23505' : r.outcome
        throw e
      }
      return { id: r.conversation.id, version: r.conversation.version }
    })

  /** Insere mensagem manual pela funcao controlada. */
  const novaMensagem = (userId, conversationId, direction, body, occurredAt = null) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `select public.conversation_add_manual_message($1, $2, $3, $4) as r`,
        [conversationId, direction, body, occurredAt],
      )
      return rows[0].r
    })

  const convA = await novaConversa(userA, clinicA)
  const convB = await novaConversa(userB, clinicB)
  ok('conversas criadas')

  // ------------------------------------------------- 3. evento automatico
  console.log('\n  === 3. Log de auditoria ===\n')

  await afirma('conversation_created e emitido automaticamente', async () => {
    const { rows } = await db.query(
      `select event_type, metadata from public.conversation_events where conversation_id = $1`,
      [convA.id],
    )
    if (rows.length !== 1) return false
    return rows[0].event_type === 'conversation_created' && rows[0].metadata.channel === 'manual'
  })

  await afirmaRecusa(
    'membro NAO consegue inserir evento a mao',
    () =>
      comoUsuario(userA, () =>
        db.query(
          `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
           values ($1, $2, 'transferred', '{}'::jsonb)`,
          [clinicA, convA.id],
        ),
      ),
    'permission denied',
  )

  await afirmaRecusa(
    'membro NAO consegue apagar evento',
    () =>
      comoUsuario(userA, () =>
        db.query(`delete from public.conversation_events where clinic_id = $1`, [clinicA]),
      ),
    'permission denied',
  )

  // ------------------------------------------------- 4. controle por RPC
  console.log('\n  === 4. Operacoes de controle ===\n')

  await afirmaRecusa(
    'UPDATE direto em conversations e negado',
    () =>
      comoUsuario(userA, () =>
        db.query(`update public.conversations set status = 'resolved' where id = $1`, [convA.id]),
      ),
    'permission denied',
  )

  const chamar = (userId, fn, args) =>
    comoUsuario(userId, async () => {
      const ph = args.map((_, i) => `$${i + 1}`).join(', ')
      const { rows } = await db.query(`select public.${fn}(${ph}) as r`, args)
      return rows[0].r
    })

  await afirma('assign com versao correta funciona', async () => {
    const r = await chamar(userA, 'conversation_assign', [convA.id, convA.version])
    return r.outcome === 'ok' && r.conversation.assignedTo === userA
  })

  await afirma('assign gera evento na mesma transacao', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from public.conversation_events
        where conversation_id = $1 and event_type = 'assigned'`,
      [convA.id],
    )
    return rows[0].n === 1
  })

  await afirma('assign com versao stale devolve conflito com o estado atual', async () => {
    const r = await chamar(userA2, 'conversation_assign', [convA.id, convA.version])
    return (
      r.outcome === 'conflict' &&
      r.conversation.assignedTo === userA &&
      r.conversation.version === convA.version + 1
    )
  })

  await afirma('conversa de outro tenant devolve not_found, nunca conflito', async () => {
    const r = await chamar(userA, 'conversation_assign', [convB.id, 1])
    return r.outcome === 'not_found' && r.conversation === undefined
  })

  await afirma('conversa inexistente devolve a MESMA resposta de outro tenant', async () => {
    const r = await chamar(userA, 'conversation_assign', [
      '00000000-0000-4000-8000-000000000000',
      1,
    ])
    return JSON.stringify(r) === JSON.stringify({ outcome: 'not_found' })
  })

  await afirma('dois assign concorrentes: so um vence', async () => {
    const c = await novaConversa(userA, clinicA)
    const r1 = await chamar(userA, 'conversation_assign', [c.id, c.version])
    const r2 = await chamar(userA2, 'conversation_assign', [c.id, c.version])
    const vencedores = [r1, r2].filter((r) => r.outcome === 'ok')
    return vencedores.length === 1
  })

  await afirma('transferir exige dono anterior', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_transfer', [c.id, c.version, userA2])
    return r.outcome === 'conflict'
  })

  await afirma('status muda por RPC e registra from/to', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    if (r.outcome !== 'ok' || r.conversation.status !== 'resolved') return false
    const { rows } = await db.query(
      `select metadata from public.conversation_events
        where conversation_id = $1 and event_type = 'status_changed'`,
      [c.id],
    )
    return rows.length === 1 && rows[0].metadata.from === 'open' && rows[0].metadata.to === 'resolved'
  })

  await afirma('transicao invalida aborta tudo, sem evento orfao', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    let recusado = false
    try {
      await chamar(userA, 'conversation_set_status', [c.id, c.version + 1, 'waiting_patient'])
    } catch (e) {
      recusado = e.message.includes('INVALID_STATUS_TRANSITION')
    }
    const { rows } = await db.query(
      `select count(*)::int as n from public.conversation_events
        where conversation_id = $1 and event_type = 'status_changed'`,
      [c.id],
    )
    // O evento da transicao recusada NAO pode existir; so o resolved anterior.
    return recusado && rows[0].n === 1
  })

  await afirma('vincular paciente da propria clinica funciona e registra', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    return r.outcome === 'ok' && r.conversation.patientId === pacienteA
  })

  await afirmaRecusa(
    'vincular paciente de OUTRA clinica e recusado pela FK composta',
    async () => {
      const c = await novaConversa(userA, clinicA)
      await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteB])
    },
    '23503',
  )

  // ------------------------------------------ 5. superficie de escrita fechada
  console.log('\n  === 5. Superficie de escrita ===\n')

  await afirmaRecusa(
    'INSERT direto em conversations e negado',
    () =>
      comoUsuario(userA, () =>
        db.query(`insert into public.conversations (clinic_id, channel) values ($1,'manual')`, [
          clinicA,
        ]),
      ),
    'permission denied',
  )

  await afirmaRecusa(
    'INSERT direto em messages e negado',
    () =>
      comoUsuario(userA, () =>
        db.query(
          `insert into public.messages (clinic_id, conversation_id, direction, body)
           values ($1,$2,'inbound','oi')`,
          [clinicA, convA.id],
        ),
      ),
    'permission denied',
  )

  await afirma('create_manual nasce open, sem dono e com version 1', async () => {
    const r = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, null, null, null) as r`,
        [clinicA],
      )
      return rows[0].r
    })
    const c = r.conversation
    return (
      r.outcome === 'ok' &&
      c.status === 'open' &&
      c.assignedTo === null &&
      c.version === 1 &&
      c.channel === 'manual' &&
      c.provider === null &&
      c.providerContactId === null
    )
  })

  await afirma('create_manual nao aceita canal, status, versao nem timestamps', async () => {
    // A funcao tem quatro parametros e nenhum deles e de controle. Tentar
    // passar um quinto e erro de assinatura, nao um campo ignorado em silencio.
    try {
      await comoUsuario(userA, () =>
        db.query(`select public.conversation_create_manual($1, null, null, null, 'whatsapp')`, [
          clinicA,
        ]),
      )
      return false
    } catch (e) {
      return /does not exist|function/i.test(e.message)
    }
  })

  await afirma('create_manual de clinica sem vinculo devolve not_found', async () => {
    const r = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, null, null, null) as r`,
        [clinicB],
      )
      return rows[0].r
    })
    return r.outcome === 'not_found'
  })

  await afirma('create_manual com paciente de OUTRA clinica falha', async () => {
    try {
      await comoUsuario(userA, () =>
        db.query(`select public.conversation_create_manual($1, null, null, $2)`, [
          clinicA,
          pacienteB,
        ]),
      )
      return false
    } catch (e) {
      return (e.code ?? '') === '23503' || e.message.includes('23503')
    }
  })

  await afirma('create_manual com paciente registra o vinculo na criacao', async () => {
    const r = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, null, null, $2) as r`,
        [clinicA, pacienteA],
      )
      return rows[0].r
    })
    const { rows } = await db.query(
      `select event_type, metadata from public.conversation_events where conversation_id = $1`,
      [r.conversation.id],
    )
    // Um evento so: nasceu vinculada, ninguem executou uma acao de vincular.
    return (
      rows.length === 1 &&
      rows[0].event_type === 'conversation_created' &&
      rows[0].metadata.patient_id === pacienteA
    )
  })

  await afirma('telefone ja usado devolve a conversa existente, nao erro cru', async () => {
    const tel = '+5511900000010'
    const primeira = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, $2, null, null) as r`,
        [clinicA, tel],
      )
      return rows[0].r
    })
    const segunda = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select public.conversation_create_manual($1, $2, null, null) as r`,
        [clinicA, tel],
      )
      return rows[0].r
    })
    return (
      primeira.outcome === 'ok' &&
      segunda.outcome === 'exists' &&
      segunda.conversation.id === primeira.conversation.id
    )
  })

  // ------------------------------------------------- 6. mensagens manuais
  console.log('\n  === 6. Mensagens manuais ===\n')

  await afirma('inbound: sem autor, mas com quem registrou', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await novaMensagem(userA, c.id, 'inbound', 'Pode ser quinta?')
    const m = r.message
    // Quem falou foi o paciente; quem registrou foi a atendente.
    return (
      r.outcome === 'ok' &&
      m.authorUserId === null &&
      m.authorName === null &&
      m.recordedByUserId === userA &&
      m.recordedByName !== null
    )
  })

  await afirma('outbound: autor e quem registrou sao a mesma pessoa', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await novaMensagem(userA, c.id, 'outbound', 'Tenho quinta as 10.')
    const m = r.message
    return m.authorUserId === userA && m.recordedByUserId === userA && m.authorName !== null
  })

  await afirma('mensagem manual nunca finge entrega', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await novaMensagem(userA, c.id, 'outbound', 'ok')
    return r.message.deliveryStatus === null && r.message.channel === 'manual'
  })

  await afirmaRecusa(
    'nem o dono da tabela marca entrega em mensagem manual',
    async () => {
      const c = await novaConversa(userA, clinicA)
      await db.query(
        `insert into public.messages (clinic_id, conversation_id, channel, direction, body,
                                      delivery_status)
         values ($1,$2,'manual','outbound','x','delivered')`,
        [clinicA, c.id],
      )
    },
    '23514',
  )

  await afirma('add_manual_message recusa conversa que nao e manual', async () => {
    const { rows } = await db.query(
      `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
       values ($1,'whatsapp','evolution','wa-nao-manual') returning id`,
      [clinicA],
    )
    const r = await novaMensagem(userA, rows[0].id, 'inbound', 'oi')
    return r.outcome === 'not_manual'
  })

  await afirma('add_manual_message em conversa de outro tenant devolve not_found', async () => {
    const r = await novaMensagem(userA, convB.id, 'inbound', 'oi')
    return r.outcome === 'not_found'
  })

  await afirma('corpo vazio e recusado', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await novaMensagem(userA, c.id, 'inbound', '   ')
    return r.outcome === 'invalid_body'
  })

  await afirma('occurred_at omitido usa o relogio do servidor', async () => {
    const c = await novaConversa(userA, clinicA)
    const antes = Date.now()
    const r = await novaMensagem(userA, c.id, 'inbound', 'oi')
    const t = new Date(r.message.occurredAt).getTime()
    return t >= antes - 5000 && t <= Date.now() + 5000
  })

  await afirma('inbound reabre conversa resolvida, com evento do sistema', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    await novaMensagem(userA, c.id, 'inbound', 'voltei')

    const { rows } = await db.query(`select status from public.conversations where id = $1`, [c.id])
    const ev = await db.query(
      `select actor_user_id from public.conversation_events
        where conversation_id = $1 and metadata->>'reason' = 'inbound_message'`,
      [c.id],
    )
    return rows[0].status === 'open' && ev.rows.length === 1 && ev.rows[0].actor_user_id === null
  })

  await afirma('mensagem NAO incrementa a versao da conversa', async () => {
    const c = await novaConversa(userA, clinicA)
    await novaMensagem(userA, c.id, 'inbound', 'oi')
    const { rows } = await db.query(`select version from public.conversations where id = $1`, [c.id])
    return rows[0].version === c.version
  })

  await afirma('mensagens manuais identicas podem repetir', async () => {
    const c = await novaConversa(userA, clinicA)
    await novaMensagem(userA, c.id, 'outbound', 'Confirmou por telefone.')
    await novaMensagem(userA, c.id, 'outbound', 'Confirmou por telefone.')
    const { rows } = await db.query(
      `select count(*)::int as n from public.messages where conversation_id = $1`,
      [c.id],
    )
    return rows[0].n === 2
  })

  await afirma('mensagem atrasada nao faz a atividade andar para tras', async () => {
    const c = await novaConversa(userA, clinicA)
    const agora = new Date().toISOString()
    const antes = new Date(Date.now() - 3_600_000).toISOString()
    await novaMensagem(userA, c.id, 'inbound', 'recente', agora)
    await novaMensagem(userA, c.id, 'inbound', 'atrasada', antes)
    const { rows } = await db.query(`select last_message_at from public.conversations where id = $1`, [
      c.id,
    ])
    return new Date(rows[0].last_message_at).getTime() === new Date(agora).getTime()
  })

  // ------------------------------- 6.5 occurred_at nao pode estar no futuro
  console.log('')
  console.log('  === 6.5 occurred_at ===')
  console.log('')

  await afirma('timestamp historico e aceito', async () => {
    const c = await novaConversa(userA, clinicA)
    const ontem = new Date(Date.now() - 24 * 3600_000).toISOString()
    const r = await novaMensagem(userA, c.id, 'inbound', 'ligou ontem', ontem)
    return r.outcome === 'ok'
  })

  await afirma('now() + 4 minutos e aceito (relogio do cliente adiantado)', async () => {
    const c = await novaConversa(userA, clinicA)
    const t = new Date(Date.now() + 4 * 60_000).toISOString()
    const r = await novaMensagem(userA, c.id, 'inbound', 'quatro minutos', t)
    return r.outcome === 'ok'
  })

  await afirma('now() + 6 minutos e recusado', async () => {
    const c = await novaConversa(userA, clinicA)
    const t = new Date(Date.now() + 6 * 60_000).toISOString()
    const r = await novaMensagem(userA, c.id, 'inbound', 'seis minutos', t)
    return r.outcome === 'invalid_occurred_at'
  })

  await afirma('ano 2999 e recusado pela RPC', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await novaMensagem(userA, c.id, 'inbound', 'do futuro', '2999-01-01T00:00:00Z')
    return r.outcome === 'invalid_occurred_at'
  })

  await afirma('a recusa nao deixa rastro: sem mensagem, sem evento, sem atividade', async () => {
    const c = await novaConversa(userA, clinicA)
    const antes = await db.query(
      `select last_message_at, last_inbound_at, version from public.conversations where id = $1`,
      [c.id],
    )
    const eventosAntes = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )

    await novaMensagem(userA, c.id, 'inbound', 'do futuro', '2999-01-01T00:00:00Z')

    const depois = await db.query(
      `select last_message_at, last_inbound_at, version from public.conversations where id = $1`,
      [c.id],
    )
    const mensagens = await db.query(
      `select count(*)::int as n from public.messages where conversation_id = $1`,
      [c.id],
    )
    const eventosDepois = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )

    return (
      mensagens.rows[0].n === 0 &&
      eventosDepois.rows[0].n === eventosAntes.rows[0].n &&
      depois.rows[0].last_message_at === antes.rows[0].last_message_at &&
      depois.rows[0].last_inbound_at === antes.rows[0].last_inbound_at &&
      depois.rows[0].version === antes.rows[0].version
    )
  })

  await afirmaRecusa(
    'nem o DONO DA TABELA insere mensagem no futuro',
    async () => {
      const c = await novaConversa(userA, clinicA)
      await db.query(
        `insert into public.messages (clinic_id, conversation_id, direction, body, occurred_at)
         values ($1,$2,'inbound','contornando','2999-01-01T00:00:00Z')`,
        [clinicA, c.id],
      )
    },
    // O trigger e a autoridade: vale para qualquer caminho de insercao, nao so
    // para a RPC. Este e o teste que prova isso.
    'MESSAGE_OCCURRED_AT_IN_FUTURE',
  )

  // ------------------------- 6.55 vinculo de paciente nao substitui em silencio
  console.log('')
  console.log('  === 6.55 Vinculo de paciente ===')
  console.log('')

  /** Cria um paciente extra na clinica A, para haver dois candidatos. */
  const novoPaciente = async (nome) => {
    const { rows } = await db.query(
      `insert into public.patients (clinic_id, name, phone) values ($1,$2,'11900000000')
       returning id`,
      [clinicA, nome],
    )
    return rows[0].id
  }

  await afirma('CASO A: conversa sem paciente vincula normalmente', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    return r.outcome === 'ok' && r.conversation.patientId === pacienteA
  })

  await afirma('CASO B: mesmo paciente de novo e no-op bem sucedido', async () => {
    const c = await novaConversa(userA, clinicA)
    const ligada = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    const v = ligada.conversation.version

    const repetida = await chamar(userA, 'conversation_link_patient', [c.id, v, pacienteA])
    return repetida.outcome === 'ok' && repetida.conversation.patientId === pacienteA
  })

  await afirma('CASO B: no-op NAO incrementa versao e NAO cria evento', async () => {
    const c = await novaConversa(userA, clinicA)
    const ligada = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    const v = ligada.conversation.version

    const antes = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )
    const repetida = await chamar(userA, 'conversation_link_patient', [c.id, v, pacienteA])
    const depois = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )
    const { rows } = await db.query(`select version from public.conversations where id = $1`, [
      c.id,
    ])

    return (
      repetida.conversation.version === v &&
      rows[0].version === v &&
      depois.rows[0].n === antes.rows[0].n
    )
  })

  await afirma('CASO C: paciente diferente e RECUSADO, sem substituir', async () => {
    const c = await novaConversa(userA, clinicA)
    const outro = await novoPaciente('Outro Paciente')
    const ligada = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    const v = ligada.conversation.version

    const tentativa = await chamar(userA, 'conversation_link_patient', [c.id, v, outro])

    const { rows } = await db.query(
      `select patient_id, version from public.conversations where id = $1`,
      [c.id],
    )
    // O paciente antigo continua la, e a versao nao andou.
    return (
      tentativa.outcome === 'already_linked' &&
      rows[0].patient_id === pacienteA &&
      rows[0].version === v
    )
  })

  await afirma('CASO C: a tentativa recusada NAO cria evento', async () => {
    const c = await novaConversa(userA, clinicA)
    const outro = await novoPaciente('Terceiro Paciente')
    const ligada = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    const v = ligada.conversation.version

    const antes = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )
    await chamar(userA, 'conversation_link_patient', [c.id, v, outro])
    const depois = await db.query(
      `select count(*)::int as n from public.conversation_events where conversation_id = $1`,
      [c.id],
    )
    return depois.rows[0].n === antes.rows[0].n
  })

  await afirma('trocar exige desvincular antes, e o historico conta isso', async () => {
    const c = await novaConversa(userA, clinicA)
    const outro = await novoPaciente('Paciente Novo')

    const ligada = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    const solta = await chamar(userA, 'conversation_unlink_patient', [
      c.id,
      ligada.conversation.version,
    ])
    const religada = await chamar(userA, 'conversation_link_patient', [
      c.id,
      solta.conversation.version,
      outro,
    ])

    const { rows } = await db.query(
      `select event_type from public.conversation_events
        where conversation_id = $1 order by created_at`,
      [c.id],
    )
    const tipos = rows.map((r) => r.event_type)

    // Duas acoes explicitas, dois eventos. Nada escondido.
    return (
      religada.outcome === 'ok' &&
      religada.conversation.patientId === outro &&
      JSON.stringify(tipos) ===
        JSON.stringify(['conversation_created', 'patient_linked', 'patient_unlinked', 'patient_linked'])
    )
  })

  await afirma('versao stale tem PRECEDENCIA sobre a regra de vinculo', async () => {
    const c = await novaConversa(userA, clinicA)
    const outro = await novoPaciente('Paciente da corrida')

    // Dois leem a versao 1. O primeiro vincula e a conversa vai para a 2.
    const versaoLida = c.version
    await chamar(userA, 'conversation_link_patient', [c.id, versaoLida, pacienteA])

    // O segundo tenta com a versao velha. Precisa receber CONFLITO, e nao
    // "ja vinculado": ele esta raciocinando sobre um estado que ja mudou.
    const segundo = await chamar(userA, 'conversation_link_patient', [c.id, versaoLida, outro])
    return segundo.outcome === 'conflict'
  })

  await afirma('paciente de OUTRA clinica continua sem disclosure', async () => {
    const c = await novaConversa(userA, clinicA)
    try {
      await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteB])
      return false
    } catch (e) {
      // A FK composta barra estruturalmente; a regra nova nao criou atalho.
      return (e.code ?? '') === '23503' || e.message.includes('23503')
    }
  })

  // ------------------------------------- 6.6 diretorio da equipe da clinica
  console.log('')
  console.log('  === 6.6 Diretorio da equipe ===')
  console.log('')

  await afirma('membro enxerga a equipe da propria clinica', async () => {
    const { rows } = await comoUsuario(userA, () =>
      db.query(`select * from public.clinic_member_directory($1)`, [clinicA]),
    )
    return rows.length >= 1 && rows.every((r) => r.user_id !== null)
  })

  await afirma('o nome vem de profiles, nao do cliente', async () => {
    await db.query(`update public.profiles set full_name = 'Nome Confiavel' where id = $1`, [
      userA,
    ])
    const { rows } = await comoUsuario(userA, () =>
      db.query(`select display_name from public.clinic_member_directory($1) where user_id = $2`, [
        clinicA,
        userA,
      ]),
    )
    return rows[0].display_name === 'Nome Confiavel'
  })

  await afirma('membro SEM perfil aparece com display_name nulo, e nao some', async () => {
    const { rows: u } = await db.query(
      `insert into auth.users (email) values ('sem-perfil@example.test') returning id`,
    )
    const semNome = u[0].id
    // profiles.full_name e NOT NULL, entao "sem nome" so existe como "sem
    // LINHA de perfil" — perfil apagado a mao ou membership criada antes dele.
    await db.query(`delete from public.profiles where id = $1`, [semNome])
    await db.query(
      `insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')`,
      [clinicA, semNome],
    )

    const { rows } = await comoUsuario(userA, () =>
      db.query(`select display_name from public.clinic_member_directory($1) where user_id = $2`, [
        clinicA,
        semNome,
      ]),
    )
    // Some-lo seria pior: sumiria do seletor de transferencia e a conversa
    // dele apareceria sem responsavel.
    return rows.length === 1 && rows[0].display_name === null
  })

  await afirma('clinica alheia devolve CONJUNTO VAZIO, nao erro', async () => {
    const { rows } = await comoUsuario(userA, () =>
      db.query(`select * from public.clinic_member_directory($1)`, [clinicB]),
    )
    return rows.length === 0
  })

  await afirma('clinica inexistente e indistinguivel de clinica alheia', async () => {
    const inexistente = await comoUsuario(userA, () =>
      db.query(`select * from public.clinic_member_directory('00000000-0000-4000-8000-000000000000')`),
    )
    const alheia = await comoUsuario(userA, () =>
      db.query(`select * from public.clinic_member_directory($1)`, [clinicB]),
    )
    // Mesma forma de resposta: nao da para descobrir que clinicB existe.
    return inexistente.rows.length === 0 && alheia.rows.length === 0
  })

  await afirma('o diretorio nunca mistura membros de outra clinica', async () => {
    const { rows } = await comoUsuario(userA, () =>
      db.query(`select user_id from public.clinic_member_directory($1)`, [clinicA]),
    )
    const { rows: deB } = await db.query(
      `select user_id from public.clinic_members where clinic_id = $1`,
      [clinicB],
    )
    const idsB = new Set(deB.map((r) => r.user_id))
    return rows.every((r) => !idsB.has(r.user_id))
  })

  await afirma('o diretorio devolve EXATAMENTE tres colunas', async () => {
    // Le a assinatura declarada. Se alguem acrescentar email ou created_at ao
    // RETURNS TABLE, esta afirmacao quebra antes de a coluna chegar ao cliente.
    const { rows } = await db.query(
      `select pg_get_function_result(p.oid) as assinatura
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'clinic_member_directory'`,
    )
    const assinatura = rows[0].assinatura.toLowerCase()
    const proibidos = ['email', 'created_at', 'updated_at', 'phone', 'metadata']
    return (
      assinatura.includes('user_id') &&
      assinatura.includes('display_name') &&
      assinatura.includes('role') &&
      proibidos.every((campo) => !assinatura.includes(campo))
    )
  })

  // ------------------------------------------------- 6. identidade
  console.log('\n  === 7. Identidade da thread ===\n')

  await afirma('duas conversas manuais sem telefone coexistem', async () => {
    await novaConversa(userA, clinicA)
    await novaConversa(userA, clinicA)
    return true
  })

  await afirmaRecusa(
    'mesmo telefone na mesma clinica colide',
    async () => {
      await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000001' })
      await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000001' })
    },
    '23505',
  )

  await afirma('mesmo telefone em clinicas diferentes convive', async () => {
    await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000002' })
    await novaConversa(userB, clinicB, { contact_phone_e164: '+5511900000002' })
    return true
  })

  await afirma('sem telefone, o provedor faz parte da identidade', async () => {
    // Mesmo provider_contact_id, provedores diferentes: threads diferentes.
    await db.query(
      `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
       values ($1,'whatsapp','evolution','wa-1'), ($1,'whatsapp','meta_cloud','wa-1')`,
      [clinicA],
    )
    return true
  })

  await afirmaRecusa(
    'mesmo provedor + mesmo contato colide',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-1')`,
        [clinicA],
      ),
    '23505',
  )

  await afirmaRecusa(
    'canal manual nao aceita provedor',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, provider)
         values ($1,'manual','evolution')`,
        [clinicA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'telefone fora de E.164 e recusado',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, contact_phone_e164)
         values ($1,'manual','11987654321')`,
        [clinicA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'canal de uma conversa NAO pode mudar',
    () =>
      db.query(`update public.conversations set channel = 'whatsapp' where id = $1`, [convA.id]),
    'IDENTITY_IMMUTABLE',
  )

  await afirmaRecusa(
    'provider_contact_id definido NAO pode ser trocado',
    async () => {
      const { rows } = await db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-troca') returning id`,
        [clinicA],
      )
      await db.query(`update public.conversations set provider_contact_id = 'outro' where id = $1`, [
        rows[0].id,
      ])
    },
    'IDENTITY_IMMUTABLE',
  )

  await afirmaRecusa(
    'sem telefone, o provedor NAO pode ser trocado silenciosamente',
    async () => {
      const { rows } = await db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-prov') returning id`,
        [clinicA],
      )
      await db.query(`update public.conversations set provider = 'meta_cloud' where id = $1`, [
        rows[0].id,
      ])
    },
    'IDENTITY_IMMUTABLE',
  )

  await afirma('COM telefone, o provedor pode mudar (Evolution -> Meta)', async () => {
    const { rows } = await db.query(
      `insert into public.conversations
         (clinic_id, channel, provider, provider_contact_id, contact_phone_e164)
       values ($1,'whatsapp','evolution','wa-mig','+5511900000003') returning id`,
      [clinicA],
    )
    await db.query(`update public.conversations set provider = 'meta_cloud' where id = $1`, [
      rows[0].id,
    ])
    return true
  })

  await afirma('provider_contact_id nulo PODE ser preenchido depois', async () => {
    const { rows } = await db.query(
      `insert into public.conversations (clinic_id, channel, provider, contact_phone_e164)
       values ($1,'whatsapp','evolution','+5511900000004') returning id`,
      [clinicA],
    )
    await db.query(`update public.conversations set provider_contact_id = 'wa-novo' where id = $1`, [
      rows[0].id,
    ])
    return true
  })

  // ------------------------------------------------- 7. appointment_created
  console.log('\n  === 8. Proveniencia de agendamento ===\n')

  const criarAgendamento = async (userId, clinicId, pacienteId) => {
    const prof = await comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.professionals (clinic_id, name) values ($1,'Prof') returning id`,
        [clinicId],
      )
      return rows[0].id
    })
    return comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.appointments (clinic_id, patient_id, professional_id, starts_at, ends_at)
         values ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 30 minutes')
         returning id`,
        [clinicId, pacienteId, prof],
      )
      return rows[0].id
    })
  }

  const apptA = await criarAgendamento(userA, clinicA, pacienteA)
  const apptB = await criarAgendamento(userB, clinicB, pacienteB)

  await afirmaRecusa(
    'conversation_log_appointment NAO e executavel por authenticated',
    () => chamar(userA, 'conversation_log_appointment', [convA.id, apptA]),
    'permission denied',
  )

  await afirma('a funcao existe e funciona como dono — so nao esta exposta', async () => {
    // Fica pronta para quando a API criar o agendamento e registrar a
    // proveniencia no mesmo caminho. Hoje, ninguem afirma proveniencia depois
    // do fato.
    // Sem trocar de papel (o dono nao passa pelo grant), mas COM a claim do
    // usuario: a funcao exige vinculo, e vinculo depende de auth.uid().
    await db.exec('begin')
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userA }),
    ])
    const { rows } = await db.query(`select public.conversation_log_appointment($1, $2) as r`, [
      convA.id,
      apptA,
    ])
    await db.exec('commit')
    return rows[0].r.outcome === 'ok'
  })

  await afirmaRecusa(
    'nem como DONO DA TABELA da para plantar agendamento de outra clinica',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'appointment_created', jsonb_build_object('appointment_id', $3::text))`,
        [clinicA, convA.id, apptB],
      ),
    'APPOINTMENT_NOT_IN_CLINIC',
  )

  await afirmaRecusa(
    'metadata com chave extra e recusado',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'appointment_created',
                 jsonb_build_object('appointment_id', $3::text, 'extra', 'x'))`,
        [clinicA, convA.id, apptA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'metadata volumoso e recusado',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'status_changed', jsonb_build_object('p', repeat('x', 4000)))`,
        [clinicA, convA.id],
      ),
    '23514',
  )

  // ------------------------------------------------- 8. isolamento e FK
  console.log('\n  === 9. Isolamento ===\n')

  await afirma('A so enxerga as conversas de A', async () => {
    const n = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select count(*)::int as n from public.conversations where clinic_id = $1`,
        [clinicB],
      )
      return rows[0].n
    })
    return n === 0
  })

  await afirmaRecusa(
    'nem o dono da tabela atribui conversa a membro de outra clinica',
    () => db.query(`update public.conversations set assigned_to = $1 where id = $2`, [userB, convA.id]),
    '23503',
  )

  await afirma('conflito nao devolve estado apos o vinculo ser removido', async () => {
    const { rows: u } = await db.query(
      `insert into auth.users (email) values ('efemero@example.test') returning id`,
    )
    const efemero = u[0].id
    await db.query(
      `insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')`,
      [clinicA, efemero],
    )

    const c = await novaConversa(userA, clinicA)
    // Alguem assume, para que a proxima tentativa caia em conflito.
    await chamar(userA, 'conversation_assign', [c.id, c.version])

    await db.query(`delete from public.clinic_members where clinic_id = $1 and user_id = $2`, [
      clinicA,
      efemero,
    ])

    // Ex-membro tentando assumir com versao stale: seria conflito se ainda
    // tivesse vinculo. Sem vinculo, tem que ser not_found — o estado da
    // conversa nao pode vazar para quem acabou de perder o acesso.
    const r = await chamar(efemero, 'conversation_assign', [c.id, c.version])
    return r.outcome === 'not_found' && r.conversation === undefined
  })

  await afirma('remover membership devolve a conversa a fila sem bloquear', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA2, 'conversation_assign', [c.id, c.version])
    await db.query(`delete from public.clinic_members where clinic_id = $1 and user_id = $2`, [
      clinicA,
      userA2,
    ])
    const { rows } = await db.query(`select assigned_to from public.conversations where id = $1`, [
      c.id,
    ])
    const ev = await db.query(
      `select actor_name_snapshot from public.conversation_events
        where conversation_id = $1 and event_type = 'assigned'`,
      [c.id],
    )
    // Conversa livre, e a autoria historica preservada pelo snapshot.
    return rows[0].assigned_to === null && ev.rows[0].actor_name_snapshot !== null
  })

  // ===========================================================================
  console.log('\n  === 10. Pendencias: schema e invariantes ===\n')

  /*
   * A secao 9 removeu userA2 da clinica A de proposito, para provar que
   * remover membership devolve a conversa a fila. Sem repor o vinculo aqui,
   * TODOS os testes de concorrencia abaixo receberiam `not_found` em vez de
   * `conflict` — e passariam a medir a coisa errada sem parecer quebrados.
   */
  await db.query(
    `insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')
     on conflict (clinic_id, user_id) do nothing`,
    [clinicA, userA2],
  )

  const novaTask = (userId, clinicId, args = {}) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        'select public.task_create($1,$2,$3,$4,$5,$6,$7,$8) as r',
        [
          clinicId,
          args.title ?? 'Ligar para confirmar',
          args.description ?? null,
          args.dueAt ?? null,
          args.assignee ?? null,
          args.patientId ?? null,
          args.conversationId ?? null,
          args.appointmentId ?? null,
        ],
      )
      return rows[0].r
    })

  await afirma('appointments ganhou a chave composta (pre-requisito da FK)', async () => {
    const { rows } = await db.query(
      "select 1 from pg_constraint where conname = 'appointments_clinic_id_id_key'",
    )
    return rows.length === 1
  })

  await afirma('pendencia GERAL, sem contexto nenhum, e aceita', async () => {
    const r = await novaTask(userA, clinicA, { title: 'Revisar encaixes de amanha' })
    return (
      r.outcome === 'ok' &&
      r.task.patientId === null &&
      r.task.conversationId === null &&
      r.task.appointmentId === null &&
      r.task.status === 'open' &&
      r.task.version === 1
    )
  })

  await afirma('criar em clinica alheia devolve not_found, sem vazar', async () => {
    const r = await novaTask(userA, clinicB, { title: 'Tarefa intrusa' })
    return r.outcome === 'not_found' && r.task === undefined
  })

  await afirmaRecusa(
    'FK composta recusa paciente de outra clinica MESMO como dono da tabela',
    () =>
      db.query(
        'insert into public.tasks (clinic_id, title, patient_id) values ($1, $2, $3)',
        [clinicA, 'Cross tenant', pacienteB],
      ),
    '23503',
  )

  await afirmaRecusa(
    'authenticated nao tem INSERT direto em tasks',
    () =>
      comoUsuario(userA, () =>
        db.query('insert into public.tasks (clinic_id, title) values ($1, $2)', [
          clinicA,
          'Insercao direta',
        ]),
      ),
    '42501',
  )

  await afirmaRecusa(
    'authenticated nao tem UPDATE direto em tasks',
    () =>
      comoUsuario(userA, () =>
        db.query("update public.tasks set title = 'mexido' where clinic_id = $1", [clinicA]),
      ),
    '42501',
  )

  await afirmaRecusa(
    'authenticated nao tem DELETE em tasks: cancelar, nunca apagar',
    () => comoUsuario(userA, () => db.query('delete from public.tasks where clinic_id = $1', [clinicA])),
    '42501',
  )

  await afirmaRecusa(
    'authenticated nao insere evento: historico forjado e impossivel',
    () =>
      comoUsuario(userA, async () => {
        const { rows } = await db.query('select id from public.tasks where clinic_id = $1 limit 1', [
          clinicA,
        ])
        return db.query(
          "insert into public.task_events (clinic_id, task_id, event_type) values ($1,$2,'completed')",
          [clinicA, rows[0].id],
        )
      }),
    '42501',
  )

  await afirmaRecusa(
    'estado hibrido recusado: aberta com completed_at',
    () =>
      db.query(
        "insert into public.tasks (clinic_id, title, status, completed_at) values ($1,'x','open',now())",
        [clinicA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'estado hibrido recusado: concluida sem completed_at',
    () =>
      db.query(
        "insert into public.tasks (clinic_id, title, status) values ($1,'x','completed')",
        [clinicA],
      ),
    '23514',
  )

  // ---------------------------------------------------------------- ciclo
  console.log('\n  === 11. Pendencias: ciclo de vida e concorrencia ===\n')

  const chamarT = (userId, fn, args) =>
    comoUsuario(userId, async () => {
      const ph = args.map((_, i) => '$' + (i + 1)).join(', ')
      const { rows } = await db.query('select public.' + fn + '(' + ph + ') as r', args)
      return rows[0].r
    })

  await afirma('assumir com versao correta funciona e gera evento', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Assumir esta' })).task
    const r = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const { rows } = await db.query(
      "select metadata from public.task_events where task_id = $1 and event_type = 'assigned'",
      [t.id],
    )
    return (
      r.outcome === 'ok' &&
      r.task.assignedTo === userA &&
      r.task.version === 2 &&
      rows[0].metadata.to.userId === userA
    )
  })

  await afirma('dois assumires simultaneos: um ok, um conflito', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Disputada' })).task
    const primeiro = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const segundo = await chamarT(userA2, 'task_assign', [t.id, t.version, userA2])
    return primeiro.outcome === 'ok' && segundo.outcome === 'conflict'
  })

  await afirma('versao stale sempre conflita, e devolve o estado atual', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Stale' })).task
    await chamarT(userA, 'task_set_due', [t.id, t.version, '2026-12-01T12:00:00Z'])
    const r = await chamarT(userA, 'task_complete', [t.id, t.version])
    return r.outcome === 'conflict' && r.task.version === 2
  })

  await afirma('concluir carimba instante e autor, e gera evento vazio', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Concluir' })).task
    const r = await chamarT(userA, 'task_complete', [t.id, t.version])
    const { rows } = await db.query(
      "select metadata from public.task_events where task_id = $1 and event_type = 'completed'",
      [t.id],
    )
    return (
      r.outcome === 'ok' &&
      r.task.status === 'completed' &&
      r.task.completedAt !== null &&
      r.task.completedBy === userA &&
      Object.keys(rows[0].metadata).length === 0
    )
  })

  await afirma('reabrir limpa os carimbos e PRESERVA o historico', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Reabrir' })).task
    const c = await chamarT(userA, 'task_complete', [t.id, t.version])
    const r = await chamarT(userA, 'task_reopen', [t.id, c.task.version])
    const { rows } = await db.query(
      "select event_type from public.task_events where task_id = $1 order by created_at, id",
      [t.id],
    )
    const tipos = rows.map((x) => x.event_type)
    return (
      r.outcome === 'ok' &&
      r.task.status === 'open' &&
      r.task.completedAt === null &&
      r.task.completedBy === null &&
      // o fato de ter sido concluida NAO se perde: e o motivo de task_events existir
      tipos.includes('completed') &&
      tipos.includes('reopened')
    )
  })

  await afirmaRecusa(
    'atalho concluida -> cancelada e recusado: reabra primeiro',
    async () => {
      const t = (await novaTask(userA, clinicA, { title: 'Atalho' })).task
      const c = await chamarT(userA, 'task_complete', [t.id, t.version])
      await db.query(
        "update public.tasks set status='cancelled', completed_at=null, completed_by=null, cancelled_at=now() where id=$1",
        [t.id],
      )
      return c
    },
    'INVALID_TRANSITION',
  )

  await afirma('no-op nao gasta versao nem cria evento', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Sem prazo' })).task
    const r = await chamarT(userA, 'task_set_due', [t.id, t.version, null])
    const { rows } = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'due_changed'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === 1 && rows[0].n === 0
  })

  await afirma('editar texto registra so os NOMES dos campos', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Titulo velho' })).task
    const r = await chamarT(userA, 'task_update_details', [
      t.id,
      t.version,
      'Titulo novo',
      null,
      false,
    ])
    const { rows } = await db.query(
      "select metadata from public.task_events where task_id = $1 and event_type = 'details_changed'",
      [t.id],
    )
    return (
      r.outcome === 'ok' &&
      r.task.title === 'Titulo novo' &&
      JSON.stringify(rows[0].metadata) === JSON.stringify({ fields: ['title'] })
    )
  })

  await afirmaRecusa(
    'metadata de details_changed com texto antigo/novo e recusada',
    () =>
      db.query(
        "insert into public.task_events (clinic_id, task_id, event_type, metadata) " +
          "select $1, id, 'details_changed', '{\"fields\":[\"title\"],\"old\":\"x\"}'::jsonb " +
          'from public.tasks where clinic_id = $1 limit 1',
        [clinicA],
      ),
    '23514',
  )

  // ------------------------------------------------------- contexto imutavel
  console.log('\n  === 12. Pendencias: contexto e autoria ===\n')

  await afirma('coerencia recusa paciente diferente do da conversa', async () => {
    const conv = await novaConversa(userA, clinicA)
    await chamarT(userA, 'conversation_link_patient', [conv.id, conv.version, pacienteA])
    const outro = await inserirPaciente(userA, clinicA, 'Outro Paciente')
    const r = await novaTask(userA, clinicA, {
      title: 'Incoerente',
      conversationId: conv.id,
      patientId: outro,
    })
    return r.outcome === 'patient_mismatch' && r.task === undefined
  })

  await afirma('conversa SEM paciente aceita qualquer paciente na tarefa', async () => {
    const conv = await novaConversa(userA, clinicA)
    const r = await novaTask(userA, clinicA, {
      title: 'Coerente',
      conversationId: conv.id,
      patientId: pacienteA,
    })
    return r.outcome === 'ok'
  })

  const alvoImutavel = await novaTask(userA, clinicA, {
    title: 'Contexto fixo',
    patientId: pacienteA,
  })
  const outroPaciente = await inserirPaciente(userA, clinicA, 'Paciente Trocado')

  await afirmaRecusa(
    'trocar o paciente depois e recusado: reescreveria a historia',
    () =>
      db.query('update public.tasks set patient_id = $1 where id = $2', [
        outroPaciente,
        alvoImutavel.task.id,
      ]),
    'CONTEXT_IMMUTABLE',
  )

  await afirmaRecusa(
    'acrescentar contexto depois tambem e recusado',
    async () => {
      const t = (await novaTask(userA, clinicA, { title: 'Nasceu geral' })).task
      return db.query('update public.tasks set patient_id = $1 where id = $2', [pacienteA, t.id])
    },
    'CONTEXT_IMMUTABLE',
  )

  await afirma('apagar paciente NAO bloqueia e NAO apaga a tarefa', async () => {
    const p = await inserirPaciente(userA, clinicA, 'Paciente Efemero')
    const t = (await novaTask(userA, clinicA, { title: 'Do efemero', patientId: p })).task
    // Se a imutabilidade de contexto fosse cega, este delete falharia.
    await db.query('delete from public.patients where id = $1', [p])
    const { rows } = await db.query(
      'select patient_id, status, version from public.tasks where id = $1',
      [t.id],
    )
    // SET NULL seletivo: some o vinculo, sobrevive a tarefa. E NAO bumpa versao —
    // ninguem editou a tarefa, e um 409 aqui puniria quem nao fez nada.
    return rows.length === 1 && rows[0].patient_id === null && rows[0].version === 1
  })

  await afirma('remover membership devolve a tarefa a fila sem bloquear', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Do a2' })).task
    await chamarT(userA2, 'task_assign', [t.id, t.version, userA2])
    await db.query('delete from public.clinic_members where clinic_id = $1 and user_id = $2', [
      clinicA,
      userA2,
    ])
    const { rows } = await db.query('select assigned_to from public.tasks where id = $1', [t.id])
    const ev = await db.query(
      "select actor_name_snapshot from public.task_events where task_id = $1 and event_type = 'assigned'",
      [t.id],
    )
    await db.query(
      "insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')",
      [clinicA, userA2],
    )
    return rows[0].assigned_to === null && ev.rows[0].actor_name_snapshot !== null
  })

  await afirma('APAGAR A CONTA de quem concluiu nao viola CHECK nem bloqueia', async () => {
    const { rows: u } = await db.query(
      "insert into auth.users (email, raw_user_meta_data) values ('conclui@example.test', '{\"full_name\":\"Quem Concluiu\"}') returning id",
    )
    const efemero = u[0].id
    await db.query(
      "insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')",
      [clinicA, efemero],
    )
    const t = (await novaTask(userA, clinicA, { title: 'Concluida por quem sai' })).task
    await chamarT(efemero, 'task_complete', [t.id, t.version])

    // O TESTE: se o CHECK exigisse completed_by NOT NULL, este delete falharia
    // com violacao de constraint, e autoria historica passaria a bloquear a
    // remocao de uma pessoa.
    await db.query('delete from auth.users where id = $1', [efemero])

    const { rows } = await db.query(
      'select status, completed_at, completed_by from public.tasks where id = $1',
      [t.id],
    )
    const ev = await db.query(
      "select actor_name_snapshot from public.task_events where task_id = $1 and event_type = 'completed'",
      [t.id],
    )
    return (
      rows[0].status === 'completed' &&
      rows[0].completed_at !== null &&
      rows[0].completed_by === null &&
      // o nome sobrevive no snapshot, que e onde ele deve estar
      ev.rows[0].actor_name_snapshot === 'Quem Concluiu'
    )
  })

  await afirma('conflito nao devolve estado para quem perdeu a membership', async () => {
    const { rows: u } = await db.query(
      "insert into auth.users (email) values ('exmembro@example.test') returning id",
    )
    const ex = u[0].id
    await db.query(
      "insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')",
      [clinicA, ex],
    )
    const t = (await novaTask(userA, clinicA, { title: 'Vazamento?' })).task
    await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    await db.query('delete from public.clinic_members where clinic_id = $1 and user_id = $2', [
      clinicA,
      ex,
    ])
    const r = await chamarT(ex, 'task_assign', [t.id, t.version, ex])
    return r.outcome === 'not_found' && r.task === undefined
  })

  await afirma('A nao enxerga as pendencias de B', async () => {
    await novaTask(userB, clinicB, { title: 'Coisa da B' })
    const n = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from public.tasks where clinic_id = $1',
        [clinicB],
      )
      return rows[0].n
    })
    return n === 0
  })

  await afirma('transferir para nao-membro devolve not_found', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Transferir' })).task
    const minha = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const r = await chamarT(userA, 'task_transfer', [minha.task.id, minha.task.version, userB])
    return r.outcome === 'not_found'
  })

  await afirma('sem responsavel, transferir responde not_assigned antes do destino', async () => {
    // A ordem importa para a MENSAGEM: quem tenta transferir uma pendencia da
    // fila geral precisa saber que a operacao certa e atribuir — e nao que o
    // destinatario esta errado, que e verdade mas nao ajuda.
    const t = (await novaTask(userA, clinicA, { title: 'Sem dono, destino ruim' })).task
    const r = await chamarT(userA, 'task_transfer', [t.id, t.version, userB])
    return r.outcome === 'invalid_state' && r.reason === 'not_assigned'
  })

  await afirma('atribuir a OUTRO membro funciona numa unica mutacao', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Para o colega' })).task
    const r = await chamarT(userA, 'task_assign', [t.id, t.version, userA2])
    const eventos = await db.query(
      "select event_type, actor_user_id, metadata from public.task_events where task_id = $1 and event_type = 'assigned'",
      [t.id],
    )
    const ev = eventos.rows[0]
    return (
      r.outcome === 'ok' &&
      r.task.assignedTo === userA2 &&
      // Uma intencao, uma versao: nada de assumir-e-transferir.
      r.task.version === 2 &&
      eventos.rows.length === 1 &&
      // ATOR e quem executou; DESTINATARIO e quem recebeu. Sao pessoas
      // diferentes, e o evento registra as duas separadamente.
      ev.actor_user_id === userA &&
      ev.metadata.to.userId === userA2
    )
  })

  await afirma('atribuir a nao-membro devolve not_found, sem revelar existencia', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Destino de fora' })).task
    const alheio = await chamarT(userA, 'task_assign', [t.id, t.version, userB])
    const inexistente = await chamarT(userA, 'task_assign', [
      t.id,
      t.version,
      '00000000-0000-4000-8000-000000000000',
    ])
    return (
      JSON.stringify(alheio) === JSON.stringify(inexistente) && alheio.outcome === 'not_found'
    )
  })

  await afirma('duas atribuicoes simultaneas a destinos diferentes: uma vence', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Disputa de destino' })).task
    const paraA = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const paraA2 = await chamarT(userA2, 'task_assign', [t.id, t.version, userA2])

    const { rows } = await db.query('select assigned_to, version from public.tasks where id = $1', [
      t.id,
    ])
    const eventos = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'assigned'",
      [t.id],
    )
    const oks = [paraA, paraA2].filter((r) => r.outcome === 'ok').length
    const conflitos = [paraA, paraA2].filter((r) => r.outcome === 'conflict').length

    return (
      oks === 1 &&
      conflitos === 1 &&
      rows[0].version === 2 &&
      eventos.rows[0].n === 1 &&
      // O responsavel final e o do vencedor, e nao uma mistura dos dois.
      [userA, userA2].includes(rows[0].assigned_to)
    )
  })

  await afirma('existe exatamente UMA task_assign publica, sem overload antigo', async () => {
    const { rows } = await db.query(
      `select p.oid::regprocedure::text as sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'task_assign'`,
    )
    // Acrescentar parametro NAO substitui a funcao: sem o drop explicito, a
    // assinatura de dois argumentos continuaria publica com a semantica velha.
    return rows.length === 1 && rows[0].sig === 'task_assign(uuid,integer,uuid)'
  })

  // ===========================================================================
  console.log('\n  === 13. Pendencias: terminal congelada e no-ops ===\n')

  /** Cria e conclui, devolvendo a tarefa ja terminal. */
  const tarefaConcluida = async (titulo) => {
    const t = (await novaTask(userA, clinicA, { title: titulo })).task
    const c = await chamarT(userA, 'task_complete', [t.id, t.version])
    return c.task
  }

  await afirma('as cinco operacoes operacionais sao recusadas em terminal', async () => {
    const t = await tarefaConcluida('Congelada')
    const rs = [
      await chamarT(userA, 'task_update_details', [t.id, t.version, 'Outro titulo', null, false]),
      await chamarT(userA, 'task_assign', [t.id, t.version, userA]),
      await chamarT(userA, 'task_transfer', [t.id, t.version, userA2]),
      await chamarT(userA, 'task_release', [t.id, t.version]),
      await chamarT(userA, 'task_set_due', [t.id, t.version, '2027-01-01T10:00:00Z']),
    ]
    return rs.every((r) => r.outcome === 'invalid_state' && r.reason === 'terminal')
  })

  await afirma('invalid_state devolve a tarefa, para a tela mostrar o estado real', async () => {
    const t = await tarefaConcluida('Congelada com corpo')
    const r = await chamarT(userA, 'task_release', [t.id, t.version])
    return r.task !== undefined && r.task.status === 'completed'
  })

  await afirma('reabrir e a UNICA operacao aceita em terminal', async () => {
    const t = await tarefaConcluida('So reabrir')
    const r = await chamarT(userA, 'task_reopen', [t.id, t.version])
    return r.outcome === 'ok' && r.task.status === 'open'
  })

  await afirma('depois de reabrir, as demais voltam a ser permitidas', async () => {
    const t = await tarefaConcluida('Volta ao normal')
    const reaberta = (await chamarT(userA, 'task_reopen', [t.id, t.version])).task
    const r = await chamarT(userA, 'task_assign', [reaberta.id, reaberta.version, userA])
    return r.outcome === 'ok' && r.task.assignedTo === userA
  })

  /*
   * A precedencia importa: quem manda versao velha precisa saber disso ANTES de
   * ser ensinado sobre o estado atual. Se a resposta fosse invalid_state, o
   * cliente corrigiria a regra errada e tentaria de novo com a mesma versao.
   */
  await afirma('versao obsoleta em tarefa terminal responde conflict, nao invalid_state', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Precedencia' })).task
    const versaoVelha = t.version
    await chamarT(userA, 'task_set_due', [t.id, t.version, '2027-02-01T10:00:00Z'])
    const atual = (await db.query('select version from public.tasks where id = $1', [t.id])).rows[0]
    await chamarT(userA, 'task_complete', [t.id, atual.version])
    const r = await chamarT(userA, 'task_update_details', [t.id, versaoVelha, 'Novo', null, false])
    return r.outcome === 'conflict'
  })

  await afirma('assumir tarefa que ja tem dono: invalid_state, sem sobrescrever', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Ja tem dono' })).task
    const a = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const r = await chamarT(userA2, 'task_assign', [a.task.id, a.task.version, userA2])
    const { rows } = await db.query('select assigned_to from public.tasks where id = $1', [t.id])
    return (
      r.outcome === 'invalid_state' &&
      r.reason === 'already_assigned' &&
      rows[0].assigned_to === userA
    )
  })

  await afirma('transferir sem responsavel atual: invalid_state, nao assign implicito', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Sem dono' })).task
    const r = await chamarT(userA, 'task_transfer', [t.id, t.version, userA2])
    const { rows } = await db.query('select assigned_to from public.tasks where id = $1', [t.id])
    return (
      r.outcome === 'invalid_state' && r.reason === 'not_assigned' && rows[0].assigned_to === null
    )
  })

  await afirma('transferir para o mesmo responsavel e no-op', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Mesmo dono' })).task
    const a = await chamarT(userA, 'task_assign', [t.id, t.version, userA])
    const r = await chamarT(userA, 'task_transfer', [a.task.id, a.task.version, userA])
    const ev = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'transferred'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === a.task.version && ev.rows[0].n === 0
  })

  await afirma('devolver tarefa que ja esta na fila e no-op', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Ja na fila' })).task
    const r = await chamarT(userA, 'task_release', [t.id, t.version])
    const ev = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'released'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === 1 && ev.rows[0].n === 0
  })

  await afirma('concluir tarefa ja concluida e no-op', async () => {
    const t = await tarefaConcluida('Concluir duas vezes')
    const r = await chamarT(userA, 'task_complete', [t.id, t.version])
    const ev = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'completed'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === t.version && ev.rows[0].n === 1
  })

  await afirma('cancelar tarefa ja cancelada e no-op', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Cancelar duas vezes' })).task
    const c = await chamarT(userA, 'task_cancel', [t.id, t.version])
    const r = await chamarT(userA, 'task_cancel', [c.task.id, c.task.version])
    const ev = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'cancelled'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === c.task.version && ev.rows[0].n === 1
  })

  await afirma('reabrir tarefa ja aberta e no-op', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Reabrir aberta' })).task
    const r = await chamarT(userA, 'task_reopen', [t.id, t.version])
    const ev = await db.query(
      "select count(*)::int as n from public.task_events where task_id = $1 and event_type = 'reopened'",
      [t.id],
    )
    return r.outcome === 'ok' && r.task.version === 1 && ev.rows[0].n === 0
  })

  await afirma('cancelada -> concluir e invalid_transition, nao no-op', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Sem atalho' })).task
    const c = await chamarT(userA, 'task_cancel', [t.id, t.version])
    const r = await chamarT(userA, 'task_complete', [c.task.id, c.task.version])
    return r.outcome === 'invalid_state' && r.reason === 'invalid_transition'
  })

  // ===========================================================================
  console.log('\n  === 14. Pendencias: atomicidade, contexto e privilegios ===\n')

  await afirma('created guarda o responsavel inicial, sem inventar evento assigned', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Nasce com dono', assignee: userA2 })).task
    const { rows } = await db.query(
      'select event_type, metadata from public.task_events where task_id = $1 order by created_at, id',
      [t.id],
    )
    return (
      rows.length === 1 &&
      rows[0].event_type === 'created' &&
      rows[0].metadata.assignedTo.userId === userA2 &&
      rows[0].metadata.assignedTo.displayName !== undefined
    )
  })

  await afirma('created sem responsavel tem metadata vazia', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'Nasce sem dono' })).task
    const { rows } = await db.query(
      "select metadata from public.task_events where task_id = $1 and event_type = 'created'",
      [t.id],
    )
    return Object.keys(rows[0].metadata).length === 0
  })

  await afirma('UPDATE privilegiado NAO consegue zerar contexto fingindo ser FK', async () => {
    const p = await inserirPaciente(userA, clinicA, 'Paciente Blindado')
    const t = (await novaTask(userA, clinicA, { title: 'Contexto blindado', patientId: p })).task
    let recusou = false
    try {
      // Como DONO DA TABELA, que passa por cima de RLS e de grants.
      await db.query('update public.tasks set patient_id = null where id = $1', [t.id])
    } catch (e) {
      recusou = /CONTEXT_IMMUTABLE/.test(e.message)
    }
    const { rows } = await db.query('select patient_id from public.tasks where id = $1', [t.id])
    return recusou && rows[0].patient_id === p
  })

  await afirma('se o evento falha, a tarefa NAO muda (mesma transacao)', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'ATOMICIDADE' })).task

    // Trigger temporario que quebra a insercao do evento, e so dela.
    await db.exec(`
      create or replace function public.quebra_evento() returns trigger
      language plpgsql as $fn$
      begin
        if new.event_type = 'completed' then
          raise exception 'FALHA_PROPOSITAL no evento';
        end if;
        return new;
      end;
      $fn$;
      create trigger tmp_quebra before insert on public.task_events
        for each row execute function public.quebra_evento();
    `)

    let estourou = false
    try {
      await chamarT(userA, 'task_complete', [t.id, t.version])
    } catch (e) {
      estourou = /FALHA_PROPOSITAL/.test(e.message)
    }

    await db.exec(`
      drop trigger if exists tmp_quebra on public.task_events;
      drop function if exists public.quebra_evento();
    `)

    const { rows } = await db.query(
      'select status, completed_at, version from public.tasks where id = $1',
      [t.id],
    )
    // A tarefa continua aberta: o UPDATE foi desfeito junto com o evento.
    return (
      estourou &&
      rows[0].status === 'open' &&
      rows[0].completed_at === null &&
      rows[0].version === 1
    )
  })

  await afirma('nenhuma funcao interna e executavel por authenticated ou anon', async () => {
    const internas = [
      'public.task_row_json(public.tasks)',
      'public.task_noop(public.tasks)',
      'public.task_invalid_state(public.tasks, text)',
      'public.task_conflict(uuid)',
      'public.task_member_snapshot(uuid, uuid)',
      'public.stamp_task_event_actor()',
      'public.prevent_task_clinic_change()',
      'public.enforce_task_context_immutable()',
      'public.enforce_task_status_transition()',
      'public.bump_task_version()',
    ]
    for (const f of internas) {
      for (const papel of ['authenticated', 'anon']) {
        const { rows } = await db.query(
          'select has_function_privilege($1, $2, $3) as pode',
          [papel, f, 'EXECUTE'],
        )
        if (rows[0].pode) {
          falhou('funcao interna exposta', `${f} executavel por ${papel}`)
          return false
        }
      }
    }
    return true
  })

  await afirma('as nove RPCs publicas sao executaveis por authenticated, e nao por anon', async () => {
    const publicas = [
      'public.task_create(uuid, text, text, timestamptz, uuid, uuid, uuid, uuid)',
      'public.task_update_details(uuid, integer, text, text, boolean)',
      'public.task_assign(uuid, integer, uuid)',
      'public.task_transfer(uuid, integer, uuid)',
      'public.task_release(uuid, integer)',
      'public.task_set_due(uuid, integer, timestamptz)',
      'public.task_complete(uuid, integer)',
      'public.task_cancel(uuid, integer)',
      'public.task_reopen(uuid, integer)',
    ]
    for (const f of publicas) {
      const a = await db.query('select has_function_privilege($1,$2,$3) as pode', [
        'authenticated', f, 'EXECUTE',
      ])
      const n = await db.query('select has_function_privilege($1,$2,$3) as pode', [
        'anon', f, 'EXECUTE',
      ])
      if (!a.rows[0].pode || n.rows[0].pode) {
        falhou('grant de RPC errado', f)
        return false
      }
    }
    return true
  })

  await afirma('service_role tem DML mas nao TRUNCATE/REFERENCES/TRIGGER', async () => {
    const esperado = { SELECT: true, INSERT: true, UPDATE: true, DELETE: true, TRUNCATE: false, REFERENCES: false, TRIGGER: false }
    for (const tabela of ['public.tasks', 'public.task_events']) {
      for (const [priv, deve] of Object.entries(esperado)) {
        const { rows } = await db.query(
          'select has_table_privilege($1, $2, $3) as pode',
          ['service_role', tabela, priv],
        )
        if (rows[0].pode !== deve) {
          falhou('privilegio de service_role', `${tabela}.${priv} = ${rows[0].pode}`)
          return false
        }
      }
    }
    return true
  })

  // ===========================================================================
  console.log('\n  === 15. Confirmacoes v0.1: base de banco ===\n')

  const novoProfissionalConf = (userId, clinicId) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.professionals (clinic_id, name) values ($1,'Prof Confirmacao') returning id`,
        [clinicId],
      )
      return rows[0].id
    })

  /** Agendamento cujo starts_at fica a N horas de agora (pode ser negativo). */
  const novoAgendamentoEm = (userId, clinicId, pacienteId, profId, horas) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.appointments (clinic_id, patient_id, professional_id, starts_at, ends_at)
         values ($1,$2,$3,
                 now() + make_interval(hours => $4),
                 now() + make_interval(hours => $4) + interval '30 minutes')
         returning id, starts_at, status`,
        [clinicId, pacienteId, profId, horas],
      )
      return rows[0]
    })

  const scan = (clinicId) => db.query('select public.request_appointment_confirmation_scan($1)', [clinicId])

  const profA = await novoProfissionalConf(userA, clinicA)
  const profB = await novoProfissionalConf(userB, clinicB)

  await afirma('CHECK aceita source=appointment_confirmation em created', async () => {
    const t = (await novaTask(userA, clinicA, { title: 'CHECK source ok' })).task
    await db.query(
      `insert into public.task_events (clinic_id, task_id, event_type, metadata)
       values ($1,$2,'created','{"source":"appointment_confirmation"}'::jsonb)`,
      [clinicA, t.id],
    )
    return true
  })

  await afirmaRecusa(
    'CHECK rejeita qualquer outro valor de source',
    async () => {
      const t = (await novaTask(userA, clinicA, { title: 'CHECK source ruim' })).task
      await db.query(
        `insert into public.task_events (clinic_id, task_id, event_type, metadata)
         values ($1,$2,'created','{"source":"bogus"}'::jsonb)`,
        [clinicA, t.id],
      )
    },
    '23514',
  )

  await afirmaRecusa(
    'CHECK continua rejeitando chave desconhecida em created',
    async () => {
      const t = (await novaTask(userA, clinicA, { title: 'CHECK chave estranha' })).task
      await db.query(
        `insert into public.task_events (clinic_id, task_id, event_type, metadata)
         values ($1,$2,'created','{"foo":"bar"}'::jsonb)`,
        [clinicA, t.id],
      )
    },
    '23514',
  )

  await afirma('scan abre Task para agendamento elegivel: status, titulo, prazo, contexto, ator', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)

    const { rows: ag } = await db.query('select status from public.appointments where id = $1', [appt.id])
    const { rows: tk } = await db.query(
      `select id, title, due_at, patient_id, appointment_id, status
         from public.tasks where appointment_id = $1`,
      [appt.id],
    )
    if (ag[0].status !== 'awaiting_confirmation') return false
    if (tk.length !== 1) return false
    const t = tk[0]
    const prazoEsperado = new Date(new Date(appt.starts_at).getTime() - 24 * 3_600_000).toISOString()

    const { rows: ev } = await db.query(
      `select actor_user_id, actor_name_snapshot, metadata
         from public.task_events where task_id = $1 and event_type = 'created'`,
      [t.id],
    )

    return (
      t.title === 'Confirmar consulta de Paciente A' &&
      new Date(t.due_at).toISOString() === prazoEsperado &&
      t.patient_id === pacienteA &&
      t.status === 'open' &&
      ev.length === 1 &&
      ev[0].actor_user_id === null &&
      ev[0].actor_name_snapshot === 'Sistema' &&
      ev[0].metadata.source === 'appointment_confirmation'
    )
  })

  await afirma('scan ignora agendamento fora da janela de 24h (muito no futuro)', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 30)
    await scan(clinicA)
    const { rows } = await db.query(
      'select status from public.appointments where id = $1',
      [appt.id],
    )
    return rows[0].status === 'scheduled'
  })

  await afirma('scan ignora agendamento cujo starts_at ja passou', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, -1)
    await scan(clinicA)
    const { rows } = await db.query(
      'select status from public.appointments where id = $1',
      [appt.id],
    )
    return rows[0].status === 'scheduled'
  })

  await afirma('scan e escopado: clinica B fica intocada ao varrer clinica A', async () => {
    const apptB = await novoAgendamentoEm(userB, clinicB, pacienteB, profB, 12)
    await scan(clinicA)
    const { rows: ag } = await db.query('select status from public.appointments where id = $1', [apptB.id])
    const { rows: tk } = await db.query('select count(*)::int as n from public.tasks where appointment_id = $1', [apptB.id])
    return ag[0].status === 'scheduled' && tk[0].n === 0
  })

  await afirma('idempotencia: rodar o scan duas vezes nao duplica a Task', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    await scan(clinicA)
    const { rows } = await db.query(
      'select count(*)::int as n from public.tasks where appointment_id = $1',
      [appt.id],
    )
    return rows[0].n === 1
  })

  await afirmaRecusa(
    'request_appointment_confirmation_scan NAO e executavel por authenticated nem anon',
    () => chamarT(userA, 'request_appointment_confirmation_scan', [clinicA]),
    'permission denied',
  )

  await afirma('fechamento: confirmed conclui a Task automatica, com o ATOR REAL', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    const antes = (
      await db.query('select id, version from public.tasks where appointment_id = $1', [appt.id])
    ).rows[0]

    await comoUsuario(userA, () =>
      db.query("update public.appointments set status = 'confirmed' where id = $1", [appt.id]),
    )

    const { rows: tk } = await db.query(
      'select status, version, completed_at, completed_by from public.tasks where id = $1',
      [antes.id],
    )
    const { rows: ev } = await db.query(
      `select actor_user_id from public.task_events
        where task_id = $1 and event_type = 'completed'`,
      [antes.id],
    )
    return (
      tk[0].status === 'completed' &&
      tk[0].version === antes.version + 1 &&
      tk[0].completed_at !== null &&
      tk[0].completed_by === userA &&
      ev.length === 1 &&
      ev[0].actor_user_id === userA
    )
  })

  await afirma('fechamento: reschedule_requested tambem conclui a Task automatica', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    await comoUsuario(userA, () =>
      db.query("update public.appointments set status = 'reschedule_requested' where id = $1", [appt.id]),
    )
    const { rows } = await db.query('select status from public.tasks where appointment_id = $1', [appt.id])
    return rows[0].status === 'completed'
  })

  await afirma('fechamento: cancelled tambem conclui a Task automatica', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    await comoUsuario(userA, () =>
      db.query("update public.appointments set status = 'cancelled' where id = $1", [appt.id]),
    )
    const { rows } = await db.query('select status from public.tasks where appointment_id = $1', [appt.id])
    return rows[0].status === 'completed'
  })

  await afirma('fechamento NAO toca em Task manual do mesmo agendamento', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    const manual = (
      await novaTask(userA, clinicA, { title: 'Tarefa manual do mesmo agendamento', appointmentId: appt.id })
    ).task

    await comoUsuario(userA, () =>
      db.query("update public.appointments set status = 'confirmed' where id = $1", [appt.id]),
    )

    const { rows } = await db.query(
      `select id, status from public.tasks where appointment_id = $1 order by created_at`,
      [appt.id],
    )
    const automatica = rows.find((r) => r.id !== manual.id)
    const manualDepois = rows.find((r) => r.id === manual.id)
    return automatica.status === 'completed' && manualDepois.status === 'open'
  })

  await afirma('reagendar de volta para scheduled dentro da janela gera Task NOVA', async () => {
    const appt = await novoAgendamentoEm(userA, clinicA, pacienteA, profA, 12)
    await scan(clinicA)
    const primeira = (
      await db.query('select id from public.tasks where appointment_id = $1', [appt.id])
    ).rows[0]

    await comoUsuario(userA, () =>
      db.query("update public.appointments set status = 'reschedule_requested' where id = $1", [appt.id]),
    )
    // Reagenda: novo horario, dentro da janela de novo, e volta para scheduled.
    await comoUsuario(userA, () =>
      db.query(
        `update public.appointments
            set starts_at = now() + interval '10 hours',
                ends_at   = now() + interval '10 hours 30 minutes',
                status    = 'scheduled'
          where id = $1`,
        [appt.id],
      ),
    )
    await scan(clinicA)

    const { rows } = await db.query(
      `select id, status from public.tasks where appointment_id = $1 order by created_at`,
      [appt.id],
    )
    const segunda = rows.find((r) => r.id !== primeira.id)
    return (
      rows.length === 2 &&
      rows.find((r) => r.id === primeira.id).status === 'completed' &&
      segunda !== undefined &&
      segunda.status === 'open'
    )
  })

  await afirma('close_appointment_confirmation_task NAO e executavel por authenticated nem anon', async () => {
    for (const papel of ['authenticated', 'anon']) {
      const { rows } = await db.query('select has_function_privilege($1, $2, $3) as pode', [
        papel,
        'public.close_appointment_confirmation_task()',
        'EXECUTE',
      ])
      if (rows[0].pode) return false
    }
    return true
  })

} catch (e) {
  falhou('execucao', e.message)
} finally {
  await db.close()
}

console.log(
  `\n  ${checagens} checagens, ${falhas} falha(s)\n`,
)
process.exit(falhas === 0 ? 0 : 1)
