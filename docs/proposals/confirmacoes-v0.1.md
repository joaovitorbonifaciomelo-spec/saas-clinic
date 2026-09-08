# Proposta técnica — Confirmação de Agendamento v0.1

> **Status: decisões de produto fechadas. Arquitetura resolvida, incluindo
> identidade técnica e fechamento automático da Task. Nada implementado.**
> Nenhuma migration, SQL, endpoint, componente ou teste foi escrito — este
> documento descreve o que será escrito quando a implementação for
> autorizada.
>
> Escrita depois de ler `appointment.ts`, `conversation.ts`, `task.ts`, o
> serviço e controller de `apps/api/src/appointments`, as migrations de
> Atendimento e de Pendências (incluindo o corpo real de `task_create`,
> `is_clinic_member`, `stamp_task_event_actor`, `bump_task_version`,
> `task_complete` e `enforce_appointment_status_transition`), e
> `docs/architecture.md` §6.1 (modo manual).
>
> Rodada anterior fechou as decisões de produto e a arquitetura de disparo
> (seções 4–6). Esta rodada fecha o **fechamento** do ciclo: identidade
> técnica da Task automática (seção 7), fechamento automático quando o
> agendamento sai de `awaiting_confirmation` (seção 8), e a reavaliação de
> atomicidade cobrindo os dois lados — abertura e fechamento (seção 9).

---

## 1. O problema real

Hoje, decidir "este agendamento precisa de confirmação" e agir sobre isso é
inteiramente manual e depende de alguém da recepção lembrar de olhar a agenda
dos próximos dias. Não há fila, não há prazo, não há rastro de quem foi
avisado — o mesmo problema que Pendências resolveu para tarefas internas,
mas aplicado especificamente à véspera de cada consulta.

O pedido desta rodada **não é** "mandar mensagem de WhatsApp automaticamente".
É: **garantir que ninguém esqueça de buscar a confirmação**, hoje sem envio
automático nenhum (`docs/architecture.md` §6.1: modo manual não envia nada),
amanhã com envio automático quando a Meta Cloud API existir — sem reescrever
nada quando esse dia chegar.

---

## 2. O achado que decide a arquitetura inteira

**O modelo atual já resolve quase tudo isto sozinho.**

1. **`AppointmentStatus` já tem os quatro desfechos.** `scheduled` →
   `awaiting_confirmation` → `confirmed` | `reschedule_requested` |
   `cancelled`. Não faltam estados — ver seção 3.
2. **A Pendência nasce com `appointmentId`/`patientId` como qualquer outra.**
   As colunas já são as mesmas que Atendimento/Paciente/Agendamento usam
   (commit `6ef02ab`) — mas **não pela RPC `task_create` diretamente**: ela
   tem uma trava de sessão que a automação não pode satisfazer. A seção 5
   explica exatamente por quê e o que fazer a respeito.
3. **O disparo já tem para onde apontar sem inventar estado novo:** a
   transição de status **é** o registro de que a confirmação foi pedida, e a
   fila "Atrasadas" de Pendências **é** o alarme de "não respondeu".
4. **O fechamento também não precisa de estado novo** (achado desta
   rodada): a MESMA transição de status que tira o agendamento de
   `awaiting_confirmation` é o gatilho natural para fechar a Task
   automática — ver seção 8.

A consequência prática, confirmada nesta rodada: **a v0.1 não precisa de
tabela nova, nem de coluna nova em `appointments` ou `tasks`.** Precisa de
três migrations pequenas e aditivas — seção 11.

---

## 3. Estados do `Appointment` que participam

| Status | Participa? | Papel |
|---|---|---|
| `scheduled` | **Sim — gatilho de entrada** | Único estado de onde a automação parte. |
| `awaiting_confirmation` | **Sim — resultado do disparo** | Marca "confirmação pedida, esperando resposta". |
| `confirmed` | **Sim — desfecho, fecha a Task** | Fecha o ciclo com sucesso. |
| `reschedule_requested` | **Sim — desfecho, fecha a Task** | Fecha o ciclo pedindo remarcação. |
| `cancelled` | **Sim — desfecho, fecha a Task** | Fecha o ciclo (cancelado antes ou depois do pedido). |
| `completed`, `no_show` | Não | Só acontecem depois da consulta; a automação já não tem o que fazer. |

Nenhum status novo. A tabela de transições já em produção
(`APPOINTMENT_STATUS_TRANSITIONS`, `appointment.ts:42`) já permite
exatamente este caminho.

---

## 4. Decisões de produto — fechadas

| Parâmetro | Valor |
|---|---|
| Antecedência do disparo | **24h** antes de `starts_at` |
| Frequência da varredura | **a cada 15 minutos** |
| Condição de elegibilidade | `status = 'scheduled' AND starts_at > now() AND starts_at <= now() + interval '24 hours'` |
| Execuções perdidas | **Janela larga, reavaliada a cada tick — sem mecanismo de retry separado** (seção 9) |
| Transição ao disparar | `scheduled → awaiting_confirmation`, **automática** |
| Pendência criada, na mesma transação | Título `"Confirmar consulta de {Paciente}"`; `dueAt = starts_at - 24h`; `patientId` + `appointmentId` preenchidos; sem responsável (fila geral) |
| Resposta do paciente | **Sempre manual** nesta versão — recepção usa o `StatusPanel` já existente |
| Identidade técnica da Task automática | **`created.metadata.source = "appointment_confirmation"`**, opcional, **nunca vira badge/UI** — ver seção 7 *(refina a rodada anterior, que não prevía nenhuma marca)* |
| Agendamento sai de `awaiting_confirmation` (`confirmed`/`reschedule_requested`/`cancelled`) | **Fecha (conclui) automaticamente** a Task `open` deste agendamento cuja `source` seja `appointment_confirmation` — só ela; outras Tasks do mesmo agendamento não são tocadas — ver seção 8 *(substitui "sem cascata" da rodada anterior)* |
| Reagendado de volta para `scheduled` | Se `starts_at` voltar a entrar na janela de 24h, o scan **pode gerar uma nova Task** — o ciclo não fica bloqueado pela Task antiga, que já foi fechada — ver seção 8 |
| Ator "Sistema" | Mantido via variável de sessão (GUC) — mecanismo **interno**, nunca exposto a `authenticated`/`anon` — ver seção 6 |
| Escopo inicial | **Opt-in só da clínica piloto** — nenhuma tabela/coluna de configuração; o `clinic_id` é parâmetro fixo passado ao agendar o job |
| Mudança de banco | **Nenhuma tabela nova. Nenhuma coluna nova** — confirmado na análise (seção 11) |

---

## 5. Quem cria a Task sem `auth.uid()`, sem usuário fake, sem `service_role` da aplicação

**Achado que muda o desenho da rodada anterior:** `task_create` **não pode
ser reaproveitada como está.** Seu primeiro guard é:

```sql
if not public.is_clinic_member(p_clinic_id) then
  return jsonb_build_object('outcome', 'not_found');
end if;
```

e `is_clinic_member` (`20260825120100_membership_helpers.sql:25`) resolve
```sql
m.user_id = (select auth.uid())
```
Com `auth.uid()` nulo (sem JWT, caso de qualquer execução via `pg_cron`),
essa comparação nunca é verdadeira — `is_clinic_member` sempre devolve
`false`, e `task_create` sempre devolveria `not_found`. Não é uma barreira
acidental: ela existe para impedir que **uma sessão de usuário** crie
pendência numa clínica da qual não é membro. Esse risco simplesmente não
existe para um job de sistema que já leu o `clinic_id` direto da linha do
`appointments` que está processando — não há sessão para verificar.

**Resolução: uma função nova, dedicada, que não passa por `task_create`.**
`request_appointment_confirmation_scan(p_clinic_id uuid)` — `SECURITY
DEFINER`, insere direto em `tasks`/`task_events`, com grants **revogados**
de `public`, `anon` e `authenticated` (só o dono do banco/`pg_cron` pode
chamá-la — nunca exposta como RPC de cliente, diferente de `task_create`).
Sem usuário fake, sem token, sem `service_role` na API: a função roda com
os privilégios de quem a *definiu* (padrão `SECURITY DEFINER` já usado em
`create_clinic_with_owner`, `task_create` etc.), e o `pg_cron`, ao chamá-la,
não precisa de credencial nenhuma — é código rodando dentro do próprio
Postgres.

```sql
create or replace function public.request_appointment_confirmation_scan(
  p_clinic_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt record;
  v_task_id uuid;
begin
  perform set_config('app.system_actor_name', 'Sistema', true);

  for v_appt in
    select a.id, a.clinic_id, a.patient_id, a.starts_at, p.name as patient_name
      from public.appointments a
      join public.patients p on p.id = a.patient_id
     where a.clinic_id = p_clinic_id
       and a.status = 'scheduled'
       and a.starts_at > now()
       and a.starts_at <= now() + interval '24 hours'
       and not exists (
         select 1 from public.tasks t
          where t.appointment_id = a.id and t.status = 'open'
       )
       for update of a skip locked
  loop
    begin
      update public.appointments
         set status = 'awaiting_confirmation'
       where id = v_appt.id
         and status = 'scheduled';  -- reafirma a condicao no instante exato

      if not found then
        continue;  -- outra execucao ja tratou este agendamento
      end if;

      insert into public.tasks
        (clinic_id, title, due_at, patient_id, appointment_id, created_by)
      values
        (v_appt.clinic_id,
         'Confirmar consulta de ' || v_appt.patient_name,
         v_appt.starts_at - interval '24 hours',
         v_appt.patient_id,
         v_appt.id,
         null)
      returning id into v_task_id;

      -- 'source' e a identidade tecnica da Task — ver secao 7. E a UNICA
      -- chave alem de assignedTo que o CHECK do banco passara a aceitar.
      insert into public.task_events (clinic_id, task_id, event_type, metadata)
      values (
        v_appt.clinic_id, v_task_id, 'created',
        jsonb_build_object('source', 'appointment_confirmation')
      );

    exception when others then
      -- Bloco BEGIN/EXCEPTION cria savepoint implicito: falha aqui desfaz
      -- SO este agendamento, sem derrubar o restante da varredura nem
      -- travar o agendamento_id numa transicao pendurada.
      raise warning 'confirmacao automatica: falha no agendamento %: %',
        v_appt.id, sqlerrm;
    end;
  end loop;
end;
$$;

revoke execute on function public.request_appointment_confirmation_scan(uuid)
  from public, anon, authenticated;
```

O `clinic_id` do piloto é passado como argumento no próprio agendamento do
`pg_cron` (`select request_appointment_confirmation_scan('<uuid-da-clinica-piloto>')`),
não lido de tabela nenhuma — é assim que a decisão "opt-in só do piloto" se
cumpre sem coluna de configuração nova.

---

## 6. Como `task_events` representa o ator "Sistema"

A resolução usa uma coluna que **já existe e já é texto livre**:
`task_events.actor_name_snapshot` — a mesma coluna que hoje guarda o nome
de um usuário que já saiu da clínica. `actor_role_snapshot` é tipado como
o enum `clinic_role` (`admin`/`attendant`/`professional`) e **não** pode
virar `'sistema'` sem alterar esse enum — não vale a pena para v0.1, então
fica `null`, exatamente como já fica quando o ator não é resolvível hoje.

O trigger `stamp_task_event_actor()` (`20260828101200_task_events.sql:207`)
recebe um ajuste pequeno e aditivo — hoje ele zera o nome sempre que
`auth.uid()` é nulo; passa a checar antes um valor de sessão opcional:

```sql
create or replace function public.stamp_task_event_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_role public.clinic_role;
begin
  if auth.uid() is null then
    new.actor_user_id       := null;
    -- Se algo setou app.system_actor_name NESTA transacao, usa — senao,
    -- mesmo comportamento de sempre (null). missing_ok=true evita erro
    -- quando a config nunca foi setada (todo o resto do sistema).
    new.actor_name_snapshot := nullif(current_setting('app.system_actor_name', true), '');
    new.actor_role_snapshot := null;
    return new;
  end if;

  select s.full_name, s.role into v_name, v_role
    from public.current_actor_snapshot(new.clinic_id) as s;

  new.actor_user_id       := auth.uid();
  new.actor_name_snapshot := v_name;
  new.actor_role_snapshot := v_role;
  return new;
end;
$$;
```

`request_appointment_confirmation_scan` chama
`perform set_config('app.system_actor_name', 'Sistema', true)` logo no
início (o `true` final = escopo da **transação atual**, some sozinho ao
fim — nunca vaza para outra sessão ou outro caller). O resultado: a tela
mostra **"Sistema criou a pendência."** em vez de "Alguém criou a
pendência.", sem nenhuma chave nova em JSON, sem alterar o enum de papéis,
sem tocar em `frase()` no frontend.

**Por que este mecanismo é seguro e continua v0.1, não motor genérico:**
`set_config('app.system_actor_name', …, true)` só existe **dentro da
função que a chamou**, nunca é lido de fora, e nenhum papel externo
(`authenticated`, `anon`, ou a própria API) tem como setá-lo — não há rota,
não há RPC, não há parâmetro de entrada que aceite esse valor do cliente.
Só o código-fonte de `request_appointment_confirmation_scan`, que por sua
vez só é chamável pelo dono do banco (seção 5), pode produzir o nome
"Sistema" num evento. Um `authenticated` mal-intencionado não tem caminho
para forjar um evento de sistema — o único jeito de `auth.uid()` ser nulo
numa chamada de API é não estar autenticado, e sem chamar a função nova (que
não é exposta) o `current_setting` nunca é setado.

Todo caminho que **não** passa por `request_appointment_confirmation_scan`
continua se comportando exatamente como antes: a variável de sessão nunca é
setada, `current_setting(..., true)` devolve `null`, e o resultado é
idêntico ao de hoje.

---

## 7. Identidade técnica da Task automática

`created.metadata.source = "appointment_confirmation"` — chave opcional,
só presente quando a Task nasce da varredura. Toda Task criada pelos
quatro caminhos já existentes (Atendimento, Paciente, Agendamento,
`/pendencias`) continua **sem** essa chave, porque nenhum deles a envia —
nenhuma mudança de comportamento para eles.

**Isso não vira badge nem qualquer elemento de UI** (decisão fechada): é
identidade técnica, para o próprio banco reconhecer "esta Task pertence à
automação de confirmação" quando precisar fechá-la (seção 8) ou, no
futuro, quando alguém precisar auditar ou desligar a automação. A tela
continua mostrando exatamente o que mostra hoje — só o ator muda para
"Sistema" (seção 6), o que já é visível por si só sem precisar de metadata.

### Mudança mínima em CHECK e Zod

O CHECK `task_events_created_metadata`
(`20260828101200_task_events.sql:110`) hoje só aceita a chave `assignedTo`
em `created.metadata` — qualquer outra chave, incluindo `source`, seria
**rejeitada pelo banco** sem este ajuste:

```sql
-- ANTES
constraint task_events_created_metadata check (
  event_type <> 'created'
  or (
    metadata - 'assignedTo' = '{}'::jsonb
    and (
      not (metadata ? 'assignedTo')
      or (
        (metadata -> 'assignedTo') ? 'userId'
        and (metadata -> 'assignedTo') - 'userId' - 'displayName' = '{}'::jsonb
      )
    )
  )
),

-- DEPOIS — aditivo: so acrescenta a chave 'source', com valor fechado
constraint task_events_created_metadata check (
  event_type <> 'created'
  or (
    metadata - 'assignedTo' - 'source' = '{}'::jsonb
    and (
      not (metadata ? 'assignedTo')
      or (
        (metadata -> 'assignedTo') ? 'userId'
        and (metadata -> 'assignedTo') - 'userId' - 'displayName' = '{}'::jsonb
      )
    )
    and (
      not (metadata ? 'source')
      or (metadata ->> 'source') = 'appointment_confirmation'
    )
  )
),
```

`source` é **um valor fechado**, não texto livre — o CHECK só aceita
exatamente `'appointment_confirmation'`. Se um dia existir uma segunda
automação, o CHECK cresce por uma migration nova (`in
('appointment_confirmation', 'outro_valor')`), do mesmo jeito que qualquer
enum deste projeto cresce — não abre a porta para qualquer string.

Espelho em `packages/shared/src/task.ts`, na mesma função
`taskCreatedMetadataSchema` que já existe:

```ts
// ANTES
export const taskCreatedMetadataSchema = z
  .object({ assignedTo: taskAssigneeSnapshotSchema.optional() })
  .strict()

// DEPOIS
export const taskCreatedMetadataSchema = z
  .object({
    assignedTo: taskAssigneeSnapshotSchema.optional(),
    /** Identidade tecnica, nunca UI. Fechado de proposito — ver CHECK do banco. */
    source: z.literal('appointment_confirmation').optional(),
  })
  .strict()
```

Nenhuma outra função, tela ou teste que já existe precisa mudar: `source`
é opcional em ambas as camadas, e `TaskEventView.metadata` já é `Record<string, unknown>`
— continua aceitando a chave nova sem tocar em tipos de leitura.

---

## 8. Fechamento automático da Task ao sair de `awaiting_confirmation`

**Onde fechar: um trigger em `appointments`, não a API, não um job
separado.** A mudança de status já acontece por um caminho só —
`appointments.service.ts#changeStatus`, um `UPDATE` simples sob RLS,
chamado pelo `StatusPanel` — mas amarrar o fechamento da Task a **esse
serviço específico** significa que qualquer caminho futuro que também
mude o status (um webhook do WhatsApp, por exemplo) teria que lembrar de
repetir a mesma lógica. Um trigger `AFTER UPDATE OF status` dispara
**não importa quem** mudou o status, hoje ou no futuro — mesmo raciocínio
que já rege `enforce_appointment_status_transition`, `bump_task_version` e
todo o resto do banco deste projeto.

```sql
create or replace function public.close_appointment_confirmation_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_id uuid;
begin
  if not (
    old.status = 'awaiting_confirmation'
    and new.status in ('confirmed', 'reschedule_requested', 'cancelled')
  ) then
    return new;
  end if;

  -- So a Task ABERTA cuja origem e ESTA automacao. Uma Task manual do
  -- mesmo agendamento (criada pelo botao "Criar pendencia") nao tem
  -- source = 'appointment_confirmation' e fica intocada.
  select t.id into v_task_id
    from public.tasks t
    join public.task_events e
      on e.task_id = t.id and e.event_type = 'created'
   where t.appointment_id = new.id
     and t.status = 'open'
     and (e.metadata ->> 'source') = 'appointment_confirmation';

  if v_task_id is null then
    return new;  -- nada da automacao aberto para este agendamento
  end if;

  -- Mesma forma de UPDATE que task_complete usa — bump_task_version() e
  -- enforce_task_status_transition() ja disparam sozinhos, automaticamente,
  -- por serem triggers em tasks. So NAO ha expectedVersion aqui: isto e uma
  -- cascata interna, nao um pedido de cliente com uma versao vista na tela.
  update public.tasks
     set status = 'completed',
         completed_at = now(),
         completed_by = auth.uid()
   where id = v_task_id
     and status = 'open';

  if found then
    insert into public.task_events (clinic_id, task_id, event_type)
    values (new.clinic_id, v_task_id, 'completed');
  end if;
  -- 'not found' aqui so aconteceria se a Task foi concluida/cancelada por
  -- OUTRA transacao no intervalo entre o select e o update — no-op seguro,
  -- sem erro: o mundo ja esta como o gatilho queria deixar.

  return new;
end;
$$;

drop trigger if exists appointments_close_confirmation_task on public.appointments;
create trigger appointments_close_confirmation_task
  after update of status on public.appointments
  for each row execute function public.close_appointment_confirmation_task();
```

**Por que `SECURITY DEFINER` aqui não é sobre `auth.uid()` — é sobre
grants.** Diferente da função de varredura (seção 5), este trigger roda
**dentro da sessão real** de quem mudou o status do agendamento — a
recepcionista, autenticada, com `auth.uid()` preenchido normalmente. O
motivo de precisar `SECURITY DEFINER` é outro: `tasks`/`task_events` não
têm `UPDATE`/`INSERT` liberado para `authenticated` (é RPC-only, de
propósito — mesma razão pela qual `task_create` existe em vez de um
`INSERT` direto). Sem `SECURITY DEFINER`, o trigger tentaria escrever com
os privilégios da recepcionista e falharia por falta de grant.

**Consequência boa, não pedida mas correta:** como o trigger roda com
`auth.uid()` da recepcionista de verdade, o evento `completed` da Task é
carimbado com ela como atora — "Maria concluiu a pendência.", não
"Sistema concluiu a pendência.". Faz sentido: foi a ação real dela
(confirmar o agendamento) que causou o fechamento. O GUC do ator "Sistema"
(seção 6) só é necessário no lado da **criação**, onde de fato não há
sessão nenhuma.

### Ponto 3 — reagendar de volta para `scheduled`

Já coberto pela combinação dos dois mecanismos, sem nenhum código a mais:

1. Agendamento em `awaiting_confirmation` recebe `reschedule_requested` →
   o trigger acima fecha a Task automática (`completed`).
2. Recepção reagenda: atualiza `starts_at`/`ends_at` e transiciona
   `reschedule_requested → scheduled` (já permitido hoje).
3. Não há mais Task `open` com `appointment_id` = este e `source =
   'appointment_confirmation'` — foi fechada no passo 1.
4. Quando o novo `starts_at` entrar na janela de 24h, a próxima varredura
   (seção 5) trata o agendamento como elegível de novo — `status =
   'scheduled'` bate, e a cláusula `not exists (... status = 'open' ...)`
   não encontra mais a Task antiga (ela virou `completed`). Uma Task nova
   nasce para o novo horário.

---

## 9. Atomicidade — reavaliada para os dois lados

**Abertura (seção 5):** dentro do `for` da varredura, cada iteração roda
num bloco `begin...exception...end`, que cria um **savepoint implícito**.
Update do agendamento e insert da Task+evento acontecem em sequência
dentro do mesmo savepoint — se o insert falhar, o savepoint inteiro
desfaz, **incluindo** a transição de status que já tinha rodado; o
agendamento volta a `scheduled` como se nada tivesse acontecido. Nenhum
outro agendamento da mesma varredura é afetado, e a varredura inteira não
aborta por causa de um caso.

**Fechamento (seção 8):** aqui a atomicidade é **de graça**, garantida
pelo próprio Postgres — o trigger roda como parte da MESMA transação que
já está fazendo o `UPDATE` do agendamento (é assim que todo trigger
`AFTER` funciona: mesma transação da instrução que disparou). Não há
`BEGIN/EXCEPTION` no trigger de fechamento de propósito: se algo dentro
dele falhar de verdade (erro inesperado, não o caso esperado de "já
fechada"), a exceção deve **propagar e abortar a transação inteira** —
o agendamento **não pode** virar `confirmed` se a Task correspondente não
puder ser fechada, porque isso deixaria os dois lados dessincronizados (o
tipo exato de "estado intermediário inconsistente" que a rodada pediu para
evitar). O caso esperado e não-excepcional — Task já fechada por outra via
— nunca lança exceção: é um `update ... where status = 'open'` comum, que
silenciosamente afeta zero linhas (`if found` cobre isso, sem
`exception`).

**Duplicação entre execuções concorrentes da varredura**, sem mudança em
relação à rodada anterior — três camadas:

1. `FOR UPDATE SKIP LOCKED` na seleção: uma segunda execução sobreposta
   pula as linhas que a primeira já travou.
2. Reafirmação da condição no `UPDATE` do agendamento
   (`where ... and status = 'scheduled'`): se duas execuções liam a mesma
   linha como elegível antes de qualquer lock, só a primeira `UPDATE` a
   encontra; a segunda recebe `not found` e pula.
3. A transição de status é a trava de fundo entre execuções não
   sobrepostas: depois do disparo, `status <> 'scheduled'`, e a próxima
   varredura nem seleciona a linha.

**Execuções perdidas:** nenhum mecanismo de retry separado. A janela é
larga (24h, reavaliada a cada 15 min) e a condição é sobre **estado**
(`status = 'scheduled'`), não sobre "aconteceu num intervalo específico" —
um agendamento que deveria ter sido pego e não foi continua elegível no
próximo tick, sem lógica de recuperação dedicada.

---

## 10. `pg_cron` no Supabase Dev — verificado, não habilitado

Consulta direta (`pg_available_extensions`, `pg_extension`) contra o
projeto Dev, só leitura, nada alterado:

| Pergunta | Resposta |
|---|---|
| Está disponível para instalar? | **Sim** — `pg_cron` versão `1.6.4` aparece em `pg_available_extensions`. |
| Já está instalada/habilitada? | **Não** — ausente de `pg_extension`; `installed_version` é `null`. |

Nenhum bloqueio de infraestrutura para a Opção A (`pg_cron` + funções
`SECURITY DEFINER`). Habilitar a extensão e agendar o job é passo de
**implementação**, fora desta rodada — normalmente via o painel do Supabase
(Database → Extensions) ou `create extension pg_cron;` com privilégio
adequado, a confirmar no momento de implementar.

---

## 11. Migrations necessárias

**Confirmado: nenhuma tabela nova, nenhuma coluna nova.** Três migrations,
todas aditivas (nenhuma altera comportamento de código já em produção):

1. **Nova função `request_appointment_confirmation_scan(p_clinic_id uuid)`**
   (seção 5) — `SECURITY DEFINER`, `revoke execute` de `public`/`anon`/
   `authenticated` explícito.
2. **Ajuste em `stamp_task_event_actor()`** (seção 6) — troca `null` fixo
   por `nullif(current_setting('app.system_actor_name', true), '')` no
   ramo `auth.uid() is null`. Aditivo e retrocompatível.
3. **Ajuste em `task_events_created_metadata` + nova função
   `close_appointment_confirmation_task()` e seu trigger** (seções 7 e 8)
   — o CHECK ganha a cláusula opcional de `source`, e o novo trigger é
   `SECURITY DEFINER` com grants padrão de trigger (não é RPC, não recebe
   `revoke` explícito — triggers não são chamados por role, são disparados
   pelo evento).

E, fora do banco, um espelho pequeno em `packages/shared/src/task.ts`
(`taskCreatedMetadataSchema` ganha `source`, seção 7) — mesmo arquivo, sem
migration própria.

Fora das migrations: agendar o job em si
(`select cron.schedule(...)`) — depende da extensão estar habilitada
(seção 10) e do `clinic_id` real da clínica piloto, então é passo de
implementação/operação, não de schema.

---

## 12. Como isso cria Pendências sem acoplar os módulos

O mesmo padrão dos quatro pontos de entrada existentes (Atendimento,
Paciente, Agendamento) — só que em vez de chamar `task_create` (barrada
por sessão, seção 5), grava direto nas mesmas colunas que `task_create`
grava:

```
Confirmações  ──▶  insert em tasks(appointment_id, patient_id, …)  ──▶  Pendências
     │                                                                    │
     └── só sabe que essas colunas existem e sao nullable ────────────────┘
         (mesmo contrato que os botões manuais usam)
```

A automação não importa nada de `apps/web/.../pendencias`, não conhece
`.pd-*`, não sabe que existe um Dashboard. Pendências continua sendo o
único módulo que sabe o que é uma Pendência; Confirmações só sabe que
precisa gravar uma linha com os IDs certos — e, agora, fechá-la quando o
agendamento sai de `awaiting_confirmation`, o que também não exige
conhecer nada de `/pendencias`: é uma linha em `tasks`/`task_events`, as
mesmas tabelas.

---

## 13. Os quatro desfechos

| Desfecho | O que acontece com o agendamento | Pendência |
|---|---|---|
| **Confirmado** | Recepção fala com o paciente, marca `awaiting_confirmation → confirmed` no `StatusPanel`. | **Fecha automaticamente** (trigger, seção 8) — ator do evento `completed` é a própria recepcionista. |
| **Pediu reagendamento** | `awaiting_confirmation → reschedule_requested`. | **Fecha automaticamente**, mesmo trigger. O fluxo de remarcação já existente assume dali; se voltar a `scheduled` dentro da janela, nova Task nasce (seção 8, ponto 3). |
| **Não respondeu** | Nada muda de status. | Fica aberta e **vence** — cai em "Atrasadas" no Dashboard e em `/pendencias`. Nenhum estado novo: é o próprio prazo vencido. O trigger de fechamento não dispara porque o status não muda. |
| **Cancelado** | Em qualquer momento, `→ cancelled`. | **Fecha automaticamente**, mesmo trigger — só se o cancelamento aconteceu a partir de `awaiting_confirmation`. Um agendamento cancelado ainda em `scheduled` (antes de qualquer disparo) não tem Task para fechar. |

---

## 14. O que já funciona sem WhatsApp real vs. o que depende da Meta Cloud API

### Funciona hoje, sem nenhuma integração nova

- Disparo automático (`pg_cron` + função) na janela de 24h, a cada 15 min.
- Transição `scheduled → awaiting_confirmation`.
- Criação da Pendência vinculada, com ator "Sistema" e identidade técnica
  (`source`).
- Fechamento automático da Pendência quando o agendamento sai de
  `awaiting_confirmation`, com o ator humano real.
- Toda a jornada humana: recepção liga, manda mensagem pelo WhatsApp
  pessoal ou o que já faz hoje, registra o resultado pelo `StatusPanel` —
  o modo manual do Atendimento já serve para registrar esse contato, se a
  recepção quiser (`POST /conversations/:id/messages`, sem enviar nada).
- Todo o alarme de "não respondeu" (fila de Pendências vencidas).

### Depende da Meta Cloud API

- **Envio automático de fato.** Hoje `conversation.channel` só é criado
  como `'manual'` — nenhum caminho de código cria `channel: 'whatsapp'`
  ainda, embora o enum já exista (`CONVERSATION_CHANNELS`,
  `CONVERSATION_PROVIDERS = ['meta_cloud', 'evolution']`) — o schema foi
  desenhado para isto, só não foi ligado.
- **Recebimento automático da resposta do paciente** ("SIM"/"não posso") e
  tradução disso em `confirmed`/`reschedule_requested` sem toque humano —
  isso é bot/webhook, não Confirmações v0.1 (fora de escopo, seção 15).
- **`messages.deliveryStatus`** (`pending/sent/delivered/read/failed`) só
  passa a carregar informação real quando existe canal de verdade; hoje o
  CHECK do banco proíbe qualquer valor ali para mensagens manuais.
- Conversão do telefone do paciente para E.164 na fronteira (`toE164BR`,
  já existe) antes de qualquer envio real.

**A v0.1 inteira descrita aqui roda sem depender de uma linha da integração
Meta Cloud.**

---

## 15. Fora do escopo da v0.1 (de propósito)

Envio real de mensagem; recebimento e interpretação automática da resposta
do paciente (bot); múltiplas tentativas/lembretes escalonados; motor de
regras configurável ("se X, então Y"); qualquer automação que não seja
confirmação de agendamento; tabela de histórico de tentativas; canal
`whatsapp` de fato criado em `conversations`; badge ou qualquer elemento de
UI mostrando "criada automaticamente"; fechamento automático de Tasks que
não tenham `source = 'appointment_confirmation'`; qualquer UI nova — a
v0.1 usa Pendências e o `StatusPanel` que já existem, sem nenhuma tela
nova.

---

## 16. Operação: o agendamento automático (`pg_cron`) no Dev

Habilitado SOMENTE no Supabase Dev (ref `xrhcwtbswzjcvgxyvpel`), como piloto
de uma única clínica. Não existe migration para isto — de propósito: o
`clinic_id` da clínica piloto é configuração deste ambiente, não código, e
**nunca** deve aparecer em um arquivo versionado. A extensão `pg_cron` foi
ativada e o job criado por uma sessão administrativa direta no banco
(`SUPABASE_DB_URL` do `.env.test`, que nunca é commitado), não por
`supabase db push`.

**Onde a configuração vive:** inteiramente dentro do próprio banco do
projeto Dev, nas tabelas do schema `cron` que a extensão cria
(`cron.job` guarda nome, schedule e o comando SQL — incluindo o
`clinic_id` literal — de cada job; `cron.job_run_details` guarda o
histórico de execuções). Não há arquivo, `.env` ou variável de ambiente da
aplicação envolvidos.

**Job:** `appointment-confirmation-pilot`, `*/15 * * * *`, chama
`public.request_appointment_confirmation_scan(<clinic_id da clínica
piloto>)`. A função continua com `EXECUTE` revogado de
`public`/`anon`/`authenticated` — o job roda como o dono do `cron`
(o mesmo papel que aplica migrations), não como um papel de cliente.

**Para inspecionar o estado atual** (conectado ao banco do Dev, papel
administrativo):

```sql
select jobid, jobname, schedule, command, active from cron.job;
select * from cron.job_run_details order by start_time desc limit 20;
```

**Para desativar sem remover** (mantém o histórico e a definição, só para
de rodar):

```sql
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'appointment-confirmation-pilot'), active := false);
```

**Para remover completamente:**

```sql
select cron.unschedule('appointment-confirmation-pilot');
```

**Para desativar a extensão inteira** (só depois de remover todos os jobs
que dependem dela):

```sql
drop extension if exists pg_cron;
```

Nenhum destes comandos toca em tabela do domínio (`appointments`, `tasks`,
etc.) — `pg_cron` é infraestrutura do próprio Postgres, isolada do schema
`public`.
