#!/usr/bin/env node
/**
 * Introspeccao READ-ONLY dos privilegios efetivos e do estado do RLS.
 *
 * Confere o que o banco REALMENTE tem contra a matriz planejada, em vez de
 * confiar em que a migration fez o que dizia. Nao executa nenhum DDL/DML.
 *
 * Nunca imprime a connection string nem qualquer credencial.
 */
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv({ path: join(ROOT, '.env.test') })

const TABLES = [
  'profiles',
  'clinics',
  'clinic_members',
  'patients',
  'professionals',
  'services',
  'professional_availability',
  'appointments',
  'conversations',
  'messages',
  'conversation_events',
  'tasks',
  'task_events',
]

/** Matriz planejada: a mesma da migration 0003 (policies) e 0006 (grants). */
const EXPECTED = {
  authenticated: {
    profiles: ['SELECT', 'UPDATE'],
    clinics: ['SELECT', 'UPDATE'],
    clinic_members: ['SELECT'],
    patients: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    professionals: ['SELECT', 'INSERT', 'UPDATE'],
    services: ['SELECT', 'INSERT', 'UPDATE'],
    professional_availability: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    // Atendimento: LE e nao ESCREVE. Toda escrita passa por funcao controlada,
    // porque um GRANT nao consegue expressar invariante (ver 0014).
    conversations: ['SELECT'],
    messages: ['SELECT'],
    conversation_events: ['SELECT'],
    // Pendencias: mesma disciplina. LE e nao ESCREVE.
    tasks: ['SELECT'],
    task_events: ['SELECT'],
  },
  anon: {
    profiles: [],
    clinics: [],
    clinic_members: [],
    patients: [],
    professionals: [],
    services: [],
    professional_availability: [],
    appointments: [],
    conversations: [],
    messages: [],
    conversation_events: [],
    tasks: [],
    task_events: [],
  },
}

const connectionString = process.env.SUPABASE_DB_URL
if (!connectionString) {
  console.error('SUPABASE_DB_URL ausente no .env.test.')
  process.exit(1)
}

/**
 * Campos discretos em vez da URI inteira.
 *
 * Senhas do Supabase costumam conter caracteres reservados no componente
 * userinfo de uma URI (`[`, `]`, `@`, `#`). O parser de connection string
 * normalizaria esses caracteres e a autenticacao falharia com 28P01 — que
 * parece "senha errada" mas e erro de parsing. Passar host/user/password
 * separados elimina a ambiguidade de encoding.
 */
function parseConnection(uri) {
  const match = /^postgresql:\/\/([^:]+):(.*)@([^/]+)\/(.+)$/.exec(uri)
  if (!match) {
    console.error('SUPABASE_DB_URL em formato inesperado.')
    process.exit(1)
  }
  const [, user, password, hostPort, database] = match
  const [host, port] = hostPort.split(':')
  return {
    user: decodeURIComponent(user),
    password: decodeURIComponent(password),
    host,
    port: Number(port ?? 5432),
    database: database.split('?')[0],
  }
}

const client = new pg.Client({
  ...parseConnection(connectionString),
  ssl: { rejectUnauthorized: false },
})
await client.connect()

let failures = 0
const fail = (message) => {
  failures += 1
  console.log(`    DIVERGENCIA: ${message}`)
}

/*
 * Modulo escrito mas ainda nao aplicado: diz isso ANTES de reprovar.
 *
 * Sem este aviso, as dezenas de "tabela ausente" e "funcao ausente" que vem a
 * seguir pareceriam violacao de privilegio — o pior tipo de alarme falso, o que
 * ensina a equipe a ignorar o vermelho. A checagem continua reprovando (o
 * inspector nao finge que passou); ela so explica o motivo primeiro.
 */
const pendentes = await client.query(
  `select t.nome from unnest($1::text[]) as t(nome)
    where to_regclass('public.' || t.nome) is null`,
  [TABLES],
)
const AUSENTES = pendentes.rows.map((r) => r.nome)
/*
 * As consultas de privilegio usam has_table_privilege, que LANCA EXCECAO em
 * tabela inexistente em vez de devolver falso. Sem filtrar, o inspector morre
 * com um stack trace de Postgres e nao chega a reportar nada — inclusive sobre
 * as tabelas que existem.
 */
const TABELAS_PRESENTES = TABLES.filter((t) => !AUSENTES.includes(t))
if (AUSENTES.length > 0) {
  console.log('\n  MODULO ESCRITO E AINDA NAO APLICADO')
  console.log('  ' + '-'.repeat(64))
  console.log(`    ausentes neste banco: ${AUSENTES.join(', ')}`)
  console.log('    As divergencias abaixo sao consequencia disso, nao de grants errados.')
  console.log('    Rode este inspector de novo IMEDIATAMENTE apos o db:push.')
}

// --- RLS ---------------------------------------------------------------------
console.log('\n  ESTADO DO RLS')
console.log('  ' + '-'.repeat(64))
for (const t of AUSENTES) fail(`tabela ausente no banco: ${t}`)

const rls = await client.query(
  `select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
          (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any($1) order by c.relname`,
  [TABLES],
)
for (const row of rls.rows) {
  console.log(
    `    ${row.table.padEnd(16)} rls=${row.enabled ? 'ON ' : 'OFF'}  forced=${row.forced ? 'yes' : 'no '}  policies=${row.policies}`,
  )
  if (!row.enabled) fail(`RLS DESABILITADO em ${row.table}`)
}
if (rls.rows.length !== TABLES.length)
  fail(`esperadas ${TABLES.length} tabelas, achadas ${rls.rows.length}`)

// --- Privilegios efetivos ----------------------------------------------------
const grants = await client.query(
  `select grantee, table_name, privilege_type
     from information_schema.role_table_grants
    where table_schema = 'public' and table_name = any($1)
      and grantee in ('anon','authenticated','service_role')
    order by grantee, table_name, privilege_type`,
  [TABLES],
)

const byRole = {}
for (const row of grants.rows) {
  byRole[row.grantee] ??= {}
  byRole[row.grantee][row.table_name] ??= []
  byRole[row.grantee][row.table_name].push(row.privilege_type)
}

/**
 * Privilegios que `authenticated` NUNCA pode ter.
 *
 * TRUNCATE e o mais perigoso: RLS cobre SELECT/INSERT/UPDATE/DELETE e NAO cobre
 * TRUNCATE. Com esse privilegio, um usuario da Clinica A apaga os dados de todos
 * os tenants sem violar policy nenhuma — e nenhum dos 24 testes de isolamento
 * detectaria, porque eles exercitam apenas as quatro operacoes cobertas por RLS.
 * TRIGGER permitiria anexar gatilhos a tabelas compartilhadas.
 */
const FORBIDDEN_FOR_AUTHENTICATED = ['TRUNCATE', 'TRIGGER', 'REFERENCES']

/**
 * Matriz explicita de service_role. Vale para as 11 tabelas, sem excecao.
 *
 * As 0006, 0013 e 0015 usaram `grant all`, e `all` em tabela nao e um conjunto
 * abstrato: expande para os sete privilegios que a tabela suporta. As 0016 e
 * 0017 revogaram os tres excedentes. Este bloco existe para que a regressao
 * apareca aqui e nao numa leitura manual de ACL seis meses depois.
 *
 * TRUNCATE e o que mais pesa: nao e coberto por RLS, nao dispara trigger de
 * linha, e esvazia todos os tenants numa instrucao sem deixar rastro.
 *
 * NAO HA EXCECAO POR TABELA, de proposito. Se um dia alguma precisar de outro
 * privilegio, a lista abaixo vira um mapa por tabela e a excecao fica escrita
 * com o motivo ao lado — nunca um caso especial silencioso no meio do laco.
 */
const SERVICE_ROLE_MATRIZ = {
  SELECT: true,
  INSERT: true,
  UPDATE: true,
  DELETE: true,
  TRUNCATE: false,
  REFERENCES: false,
  TRIGGER: false,
}

console.log('\n  PRIVILEGIOS PROIBIDOS PARA authenticated')
console.log('  ' + '-'.repeat(64))
for (const table of TABELAS_PRESENTES) {
  const held = await client.query(
    `select p as priv, has_table_privilege('authenticated', $1, p) as granted
       from unnest($2::text[]) as p`,
    [`public.${table}`, FORBIDDEN_FOR_AUTHENTICATED],
  )
  const violations = held.rows.filter((r) => r.granted).map((r) => r.priv)
  console.log(
    `    ${table.padEnd(16)} ${violations.length === 0 ? 'nenhum dos proibidos (OK)' : 'POSSUI: ' + violations.join(', ')}`,
  )
  for (const priv of violations) fail(`authenticated tem ${priv} em ${table}`)
}

// --- PUBLIC ------------------------------------------------------------------
console.log('\n  PRIVILEGIOS VIA PUBLIC (papel implicito herdado por todos)')
console.log('  ' + '-'.repeat(64))
const publicGrants = await client.query(
  `select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = any($1) and grantee = 'PUBLIC'`,
  [TABLES],
)
if (publicGrants.rows.length === 0) {
  console.log(`    nenhum privilegio concedido a PUBLIC nas ${TABLES.length} tabelas (OK)`)
} else {
  for (const row of publicGrants.rows) fail(`PUBLIC tem ${row.privilege_type} em ${row.table_name}`)
}

// --- Schema ------------------------------------------------------------------
console.log('\n  PRIVILEGIOS DO SCHEMA public')
console.log('  ' + '-'.repeat(64))
const schemaPrivs = await client.query(
  `select r as role,
          has_schema_privilege(r, 'public', 'CREATE') as create_priv,
          has_schema_privilege(r, 'public', 'USAGE') as usage_priv
     from unnest(array['anon','authenticated','service_role']) as r`,
)
for (const row of schemaPrivs.rows) {
  console.log(
    `    ${row.role.padEnd(16)} CREATE=${row.create_priv ? 'SIM' : 'nao'}   USAGE=${row.usage_priv ? 'sim' : 'nao'}`,
  )
  // CREATE no schema permitiria criar objetos e escapar do modelo de isolamento.
  if (row.create_priv && row.role !== 'service_role') {
    fail(`${row.role} tem CREATE no schema public`)
  }
  if (!row.usage_priv) fail(`${row.role} sem USAGE no schema public`)
}

for (const role of ['anon', 'authenticated', 'service_role']) {
  console.log(`\n  PRIVILEGIOS EFETIVOS - ${role}`)
  console.log('  ' + '-'.repeat(64))
  for (const table of TABELAS_PRESENTES) {
    const actual = (byRole[role]?.[table] ?? []).sort()
    console.log(`    ${table.padEnd(16)} ${actual.length ? actual.join(', ') : '(nenhum)'}`)

    const expected = EXPECTED[role]?.[table]
    if (expected) {
      const want = [...expected].sort()
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        fail(`${role}.${table}: esperado [${want.join(', ')}], efetivo [${actual.join(', ')}]`)
      }
    }
  }
  // service_role nao e conferido aqui: a matriz celula a celula, mais adiante,
  // cobre as 11 tabelas e e mais estrita do que "tem os quatro de DML".
}

// --- Policies ----------------------------------------------------------------
console.log('\n  POLICIES POR TABELA')
console.log('  ' + '-'.repeat(64))
const policies = await client.query(
  `select tablename, policyname, cmd, roles::text
     from pg_policies where schemaname = 'public' and tablename = any($1)
    order by tablename, cmd, policyname`,
  [TABLES],
)
for (const row of policies.rows) {
  console.log(
    `    ${row.tablename.padEnd(16)} ${row.cmd.padEnd(6)} ${row.policyname}  roles=${row.roles}`,
  )
}

const writePolicies = policies.rows.filter(
  (r) => r.tablename === 'clinic_members' && r.cmd !== 'SELECT',
)
if (writePolicies.length > 0) {
  fail(`clinic_members tem policy de escrita: ${writePolicies.map((r) => r.policyname).join(', ')}`)
}

// As 9 policies da migration 0003. Perder uma abriria acesso; ganhar uma que nao
// esteja no arquivo significa que alguem mexeu no banco fora das migrations.
/**
 * Policies esperadas POR TABELA, nao um total unico.
 *
 * Um total agregado esconderia dois erros que se cancelam — uma policy a menos
 * em `appointments` e uma a mais em `patients` somariam igual e passariam.
 */
const EXPECTED_POLICIES_BY_TABLE = {
  profiles: 2,
  clinics: 2,
  clinic_members: 1,
  patients: 4,
  professionals: 3,
  services: 3,
  professional_availability: 4,
  appointments: 3,
  conversations: 1,
  messages: 1,
  conversation_events: 1,
  // Pendencias: UMA policy em cada, so de SELECT. A ausencia de policy de
  // INSERT/UPDATE/DELETE e a defesa, e o numero exato e o que a denuncia se
  // alguem acrescentar uma permissiva.
  tasks: 1,
  task_events: 1,
}

console.log('')
for (const table of TABELAS_PRESENTES) {
  const actual = policies.rows.filter((row) => row.tablename === table).length
  const expected = EXPECTED_POLICIES_BY_TABLE[table]
  console.log(`    ${table.padEnd(26)} ${actual} policy(ies) (esperado ${expected})`)
  if (actual !== expected) {
    fail(`${table}: esperadas ${expected} policies, encontradas ${actual}`)
  }
}

// --- service_role nas tabelas do Atendimento ---------------------------------
console.log('')
console.log('  MATRIZ DE service_role (as 11 tabelas)')
console.log('  ' + '-'.repeat(64))
const privsMatriz = Object.keys(SERVICE_ROLE_MATRIZ)
console.log('    ' + 'tabela'.padEnd(28) + privsMatriz.map((p) => p.slice(0, 4).padEnd(7)).join(''))
for (const table of TABELAS_PRESENTES) {
  const linha = []
  for (const priv of privsMatriz) {
    const { rows } = await client.query(
      `select has_table_privilege('service_role', $1, $2) as ok`,
      [`public.${table}`, priv],
    )
    const efetivo = rows[0].ok
    const esperado = SERVICE_ROLE_MATRIZ[priv]
    linha.push((efetivo ? 'sim' : '-').padEnd(7))
    if (efetivo !== esperado) {
      fail(
        `service_role.${table}: ${priv} esperado ${esperado ? 'SIM' : 'nao'}, efetivo ${efetivo ? 'SIM' : 'nao'}`,
      )
    }
  }
  console.log('    ' + table.padEnd(28) + linha.join(''))
}

// --- EXECUTE nas funcoes do Atendimento --------------------------------------
/**
 * O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova. Uma
 * funcao que deveria ser interna fica exposta por omissao, nao por engano
 * visivel — por isso a lista negativa importa tanto quanto a positiva.
 */
const EXPOSED_FUNCTIONS = [
  'conversation_create_manual',
  'conversation_add_manual_message',
  'conversation_assign',
  'conversation_transfer',
  'conversation_release',
  'conversation_set_status',
  'conversation_link_patient',
  'conversation_unlink_patient',
  // Diretorio da equipe: leitura/UX. A autorizacao real continua na FK e nas
  // funcoes de controle; este so devolve nome para a tela.
  'clinic_member_directory',
  // Pendencias: as nove operacoes controladas.
  'task_create',
  'task_update_details',
  'task_assign',
  'task_transfer',
  'task_release',
  'task_set_due',
  'task_complete',
  'task_cancel',
  'task_reopen',
]
const INTERNAL_FUNCTIONS = [
  'conversation_log_appointment',
  'conversation_row_json',
  'message_row_json',
  'conversation_conflict',
  // Predicado e trigger de occurred_at: sao a autoridade, e ninguem os chama
  // de fora. Expostos, so dariam superficie sem utilidade.
  'message_occurred_at_ok',
  'reject_future_occurred_at',
  // Pendencias: devolvem ESTADO ou sao gatilhos. Expostas, seriam leitura
  // lateral que ignora o contrato, ou superficie sem utilidade.
  'task_row_json',
  'task_noop',
  'task_invalid_state',
  'task_conflict',
  'task_member_snapshot',
  'stamp_task_event_actor',
  'prevent_task_clinic_change',
  'enforce_task_context_immutable',
  'enforce_task_status_transition',
  'bump_task_version',
  // Confirmacoes v0.1: varredura (chamada nua pelo dono do banco/pg_cron) e
  // o trigger de fechamento — nenhuma das duas e RPC de cliente.
  'request_appointment_confirmation_scan',
  'close_appointment_confirmation_task',
]

console.log('')
console.log('  EXECUTE NAS FUNCOES DO ATENDIMENTO')
console.log('  ' + '-'.repeat(64))
const fns = await client.query(
  `select p.proname, p.oid::regprocedure::text as sig,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any($1)
    order by p.proname`,
  [[...EXPOSED_FUNCTIONS, ...INTERNAL_FUNCTIONS]],
)
for (const row of fns.rows) {
  const esperado = EXPOSED_FUNCTIONS.includes(row.proname)
  console.log(
    `    ${row.proname.padEnd(34)} authenticated=${row.auth_exec ? 'SIM' : 'nao'}  anon=${row.anon_exec ? 'SIM' : 'nao'}  (esperado ${esperado ? 'exposta' : 'INTERNA'})`,
  )
  if (esperado && !row.auth_exec) fail(`${row.proname} deveria ser executavel por authenticated`)
  if (!esperado && row.auth_exec) fail(`${row.proname} NAO deveria estar exposta a authenticated`)
  if (row.anon_exec) fail(`${row.proname} executavel por anon`)
}
for (const nome of [...EXPOSED_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
  if (!fns.rows.some((r) => r.proname === nome)) fail(`funcao ausente no banco: ${nome}`)
}

/*
 * ASSINATURA EXATA, e nao so o nome.
 *
 * Acrescentar um parametro a uma funcao NAO a substitui: o PostgreSQL a
 * identifica por nome + tipos, entao `create or replace` com um argumento a
 * mais cria uma SEGUNDA funcao. As duas ficam publicas, a antiga continua
 * executavel com a semantica velha, e ninguem percebe — porque o cliente novo
 * nunca a chama.
 *
 * `task_assign` passou exatamente por essa troca (dois argumentos -> tres).
 * Conferir a assinatura e contar as sobrecargas e o que denuncia um drop
 * esquecido.
 */
const ASSINATURAS_ESPERADAS = {
  task_assign: 'task_assign(uuid,integer,uuid)',
  task_transfer: 'task_transfer(uuid,integer,uuid)',
  task_create: 'task_create(uuid,text,text,timestamp with time zone,uuid,uuid,uuid,uuid)',
  task_update_details: 'task_update_details(uuid,integer,text,text,boolean)',
  task_release: 'task_release(uuid,integer)',
  task_set_due: 'task_set_due(uuid,integer,timestamp with time zone)',
  task_complete: 'task_complete(uuid,integer)',
  task_cancel: 'task_cancel(uuid,integer)',
  task_reopen: 'task_reopen(uuid,integer)',
}

console.log('')
console.log('  ASSINATURAS DAS RPCS DE PENDENCIAS')
console.log('  ' + '-'.repeat(64))
for (const [nome, esperada] of Object.entries(ASSINATURAS_ESPERADAS)) {
  const encontradas = fns.rows.filter((r) => r.proname === nome)
  const sigs = encontradas.map((r) => r.sig)
  console.log(`    ${nome.padEnd(24)} ${sigs.join(' | ') || '(ausente)'}`)

  if (encontradas.length > 1) {
    fail(`${nome} tem ${encontradas.length} sobrecargas: ${sigs.join(' | ')}`)
  }
  if (encontradas.length === 1 && sigs[0] !== esperada) {
    fail(`${nome}: assinatura ${sigs[0]} — esperada ${esperada}`)
  }
}

// --- Trigger em auth.users ---------------------------------------------------
const trigger = await client.query(
  `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`,
)
console.log('\n  TRIGGERS EM auth.users')
console.log('  ' + '-'.repeat(64))
for (const row of trigger.rows) console.log(`    ${row.tgname}`)

await client.end()

console.log('\n  ' + '='.repeat(64))
if (failures > 0) {
  console.log(`  RESULTADO: ${failures} DIVERGENCIA(S) em relacao a matriz planejada.\n`)
  process.exit(1)
}
console.log('  RESULTADO: privilegios efetivos batem com a matriz planejada.\n')
