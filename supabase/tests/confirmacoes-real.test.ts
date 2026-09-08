/**
 * =============================================================================
 * Confirmacoes v0.1 — banco REAL do Supabase Dev
 * =============================================================================
 *
 * `request_appointment_confirmation_scan` fica com EXECUTE revogado de
 * public/anon/authenticated: so o dono do banco pode chama-la, exatamente
 * como `pg_cron` chamaria em producao. Por isso este arquivo abre um client
 * `pg` direto (via SUPABASE_DB_URL, papel do dono do banco) so para essa
 * chamada "nua" — o resto do cenario (clinicas, pacientes, agenda, Task
 * manual) passa pelo caminho real de `authenticated`, exatamente como a
 * suite de Pendencias contra o banco real.
 *
 * Este arquivo NAO cria nem habilita pg_cron: chama a funcao diretamente,
 * como uma execucao isolada do scan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createAgendaFixture, loadIsolationEnv, parseDbConnection } from './helpers'
import { eventosDe, novaTask, montarCenario, registrarLimpeza, type Cenario } from './task-helpers'

describe('Confirmacoes v0.1 — banco real (Dev)', () => {
  let cenario: Cenario | undefined
  let db: pg.Client

  registrarLimpeza(() => cenario)

  beforeAll(async () => {
    loadIsolationEnv() // trava de ambiente: nunca roda contra producao
    cenario = await montarCenario()

    const uri = process.env.SUPABASE_DB_URL
    if (!uri) throw new Error('SUPABASE_DB_URL ausente no .env.test.')
    db = new pg.Client({ ...parseDbConnection(uri), ssl: { rejectUnauthorized: false } })
    await db.connect()
  }, 120_000)

  afterAll(async () => {
    await db?.end()
  })

  const scan = (clinicId: string) =>
    db.query('select public.request_appointment_confirmation_scan($1)', [clinicId])

  /** now() + 12h: dentro da janela de 24h, sem depender de fuso do runner. */
  const dentroDaJanela = () => new Date(Date.now() + 12 * 3_600_000)

  it('1+2. scan e escopado por p_clinic_id; scheduled->awaiting_confirmation + Task nascem atomicamente', async () => {
    const c = cenario!
    const fixtureA = await createAgendaFixture(c.maria, dentroDaJanela())
    const fixtureB = await createAgendaFixture(c.bruno, dentroDaJanela())

    await scan(c.maria.clinicId)

    const { rows: apptA } = await db.query<{ status: string }>(
      'select status from public.appointments where id = $1',
      [fixtureA.appointmentId],
    )
    const { rows: apptB } = await db.query<{ status: string }>(
      'select status from public.appointments where id = $1',
      [fixtureB.appointmentId],
    )
    expect(apptA[0]?.status).toBe('awaiting_confirmation')
    expect(apptB[0]?.status).toBe('scheduled') // clinica B nao participou do scan de A

    const { rows: tasksA } = await db.query<{
      id: string
      status: string
      created_by: string | null
      patient_id: string
    }>(
      'select id, status, created_by, patient_id from public.tasks where appointment_id = $1',
      [fixtureA.appointmentId],
    )
    const { rows: tasksB } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.tasks where appointment_id = $1',
      [fixtureB.appointmentId],
    )
    expect(tasksA).toHaveLength(1)
    expect(tasksA[0]?.status).toBe('open')
    expect(tasksA[0]?.created_by).toBeNull()
    expect(tasksA[0]?.patient_id).toBe(c.maria.patientId)
    expect(tasksB[0]?.n).toBe(0)
  })

  it('3. Task automatica carrega source=appointment_confirmation e ator "Sistema"', async () => {
    const c = cenario!
    const fixture = await createAgendaFixture(c.maria, dentroDaJanela())
    await scan(c.maria.clinicId)

    const { rows: tasks } = await db.query<{ id: string }>(
      'select id from public.tasks where appointment_id = $1',
      [fixture.appointmentId],
    )
    expect(tasks).toHaveLength(1)

    const eventos = await eventosDe(c.admin, tasks[0]!.id)
    const criado = eventos.find((e) => e.event_type === 'created')
    expect(criado?.actor_user_id).toBeNull()
    expect(criado?.actor_name_snapshot).toBe('Sistema')
    expect(criado?.metadata.source).toBe('appointment_confirmation')
  })

  it('4. segunda execucao do scan nao duplica a Task', async () => {
    const c = cenario!
    const fixture = await createAgendaFixture(c.maria, dentroDaJanela())
    await scan(c.maria.clinicId)
    await scan(c.maria.clinicId)

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.tasks where appointment_id = $1',
      [fixture.appointmentId],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it.each([['confirmed'], ['reschedule_requested'], ['cancelled']] as const)(
    '5. %s fecha a Task automatica (e so ela)',
    async (novoStatus) => {
      const c = cenario!
      const fixture = await createAgendaFixture(c.maria, dentroDaJanela())
      await scan(c.maria.clinicId)

      const { error } = await c.maria.db
        .from('appointments')
        .update({ status: novoStatus })
        .eq('id', fixture.appointmentId)
      expect(error).toBeNull()

      const { rows } = await db.query<{ status: string }>(
        'select status from public.tasks where appointment_id = $1',
        [fixture.appointmentId],
      )
      expect(rows[0]?.status).toBe('completed')
    },
  )

  it('6. fechamento nao toca em Task manual do mesmo agendamento', async () => {
    const c = cenario!
    const fixture = await createAgendaFixture(c.maria, dentroDaJanela())
    await scan(c.maria.clinicId)
    const manual = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Tarefa manual do mesmo agendamento (teste real)',
      appointmentId: fixture.appointmentId,
    })

    const { error } = await c.maria.db
      .from('appointments')
      .update({ status: 'confirmed' })
      .eq('id', fixture.appointmentId)
    expect(error).toBeNull()

    const { rows } = await db.query<{ id: string; status: string }>(
      'select id, status from public.tasks where appointment_id = $1 order by created_at',
      [fixture.appointmentId],
    )
    const automatica = rows.find((r) => r.id !== manual.id)
    const manualDepois = rows.find((r) => r.id === manual.id)
    expect(automatica?.status).toBe('completed')
    expect(manualDepois?.status).toBe('open')
  })

  it('7. reagendar de volta para scheduled dentro da janela permite Task nova; a antiga fica concluida', async () => {
    const c = cenario!
    const fixture = await createAgendaFixture(c.maria, dentroDaJanela())
    await scan(c.maria.clinicId)
    const primeira = (
      await db.query<{ id: string }>('select id from public.tasks where appointment_id = $1', [
        fixture.appointmentId,
      ])
    ).rows[0]!

    await c.maria.db
      .from('appointments')
      .update({ status: 'reschedule_requested' })
      .eq('id', fixture.appointmentId)

    const novoInicio = new Date(Date.now() + 10 * 3_600_000)
    const novoFim = new Date(novoInicio.getTime() + 30 * 60_000)
    await c.maria.db
      .from('appointments')
      .update({
        starts_at: novoInicio.toISOString(),
        ends_at: novoFim.toISOString(),
        status: 'scheduled',
      })
      .eq('id', fixture.appointmentId)

    await scan(c.maria.clinicId)

    const { rows } = await db.query<{ id: string; status: string }>(
      'select id, status from public.tasks where appointment_id = $1 order by created_at',
      [fixture.appointmentId],
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === primeira.id)?.status).toBe('completed')
    const segunda = rows.find((r) => r.id !== primeira.id)
    expect(segunda?.status).toBe('open')
  })

  it('8. grants das duas funcoes internas continuam fechados para public/anon/authenticated', async () => {
    for (const assinatura of [
      'request_appointment_confirmation_scan(uuid)',
      'close_appointment_confirmation_task()',
    ]) {
      for (const papel of ['public', 'anon', 'authenticated']) {
        const { rows } = await db.query<{ pode: boolean }>(
          'select has_function_privilege($1, $2, $3) as pode',
          [papel, `public.${assinatura}`, 'EXECUTE'],
        )
        expect(rows[0]?.pode).toBe(false)
      }
    }
  })

  it('8b. scan nao e chamavel via RPC pelo caminho real de authenticated', async () => {
    const c = cenario!
    const { error } = await c.maria.db.rpc('request_appointment_confirmation_scan', {
      p_clinic_id: c.maria.clinicId,
    })
    expect(error).not.toBeNull()
  })
})
