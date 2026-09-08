# Proposta técnica — Confirmação de Agendamento v0.1

> **Status: decisões de produto fechadas. Arquitetura resolvida. Nada
> implementado.** Nenhuma migration, SQL, endpoint, componente ou teste foi
> escrito — este documento descreve o que será escrito quando a
> implementação for autorizada.
>
> Escrita depois de ler `appointment.ts`, `conversation.ts`, `task.ts`, o
> serviço e controller de `apps/api/src/appointments`, as migrations de
> Atendimento e de Pendências (incluindo o corpo real de `task_create` e de
> `is_clinic_member`), e `docs/architecture.md` §6.1 (modo manual).
>
> Todas as decisões de produto da rodada anterior foram fechadas por você e
> estão incorporadas ao texto (seção 4). As cinco questões técnicas em
> aberto (quem cria a Task sem sessão, como representar o ator Sistema,
> atomicidade/duplicidade, disponibilidade do `pg_cron`, migrations) estão
> resolvidas nas seções 5–9.

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

A consequência prática, confirmada nesta rodada: **a v0.1 não precisa de
tabela nova, nem de coluna nova em `appointments` ou `tasks`.** Precisa de
duas migrations pequenas e aditivas — seção 9.

---

## 3. Estados do `Appointment` que participam

| Status | Participa? | Papel |
|---|---|---|
| `scheduled` | **Sim — gatilho de entrada** | Único estado de onde a automação parte. |
| `awaiting_confirmation` | **Sim — resultado do disparo** | Marca "confirmação pedida, esperando resposta". |
| `confirmed` | **Sim — desfecho** | Fecha o ciclo com sucesso. |
| `reschedule_requested` | **Sim — desfecho** | Fecha o ciclo pedindo remarcação. |
| `cancelled` | **Sim — desfecho / interrupção** | Fecha o ciclo (cancelado antes ou depois do pedido). |
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
| Execuções perdidas | **Janela larga, reavaliada a cada tick — sem mecanismo de retry separado** (ver seção 6) |
| Transição ao disparar | `scheduled → awaiting_confirmation`, **automática** |
| Pendência criada, na mesma transação | Título `"Confirmar consulta de {Paciente}"`; `dueAt = starts_at - 24h`; `patientId` + `appointmentId` preenchidos; sem responsável (fila geral) |
| Resposta do paciente | **Sempre manual** nesta versão — recepção usa o `StatusPanel` já existente |
| Agendamento cancelado com Pendência aberta | **Sem cascata** — a Pendência permanece aberta; a recepção cancela/conclui manualmente |
| Marcador "criada automaticamente" | **Não existe** — nenhuma chave nova em `metadata`. O ator "Sistema" é resolvido de outro jeito (seção 6), sem tocar no JSON |
| Escopo inicial | **Opt-in só da clínica piloto** — nenhuma tabela/coluna de configuração; o `clinic_id` é parâmetro fixo passado ao agendar o job, não um dado consultado em runtime |
| Mudança de banco | **Nenhuma tabela nova. Nenhuma coluna nova** — confirmado na análise (seção 9) |

Isso fecha o que era D1, D3, D4 (parte), D5, D6, D7, D8 e a parte de escopo
da D2 na rodada anterior. O que restava sem resposta técnica concreta —
"quem chama, sem sessão, sem usuário fake, sem `service_role`" — é o
assunto das seções 5–8.

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

      insert into public.task_events (clinic_id, task_id, event_type, metadata)
      values (v_appt.clinic_id, v_task_id, 'created', '{}'::jsonb);

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

Sem marcador em `metadata` (decisão fechada). A resolução usa uma coluna que
**já existe e já é texto livre**: `task_events.actor_name_snapshot` — a
mesma coluna que hoje guarda o nome de um usuário que já saiu da clínica.
`actor_role_snapshot` é tipado como o enum `clinic_role`
(`admin`/`attendant`/`professional`) e **não** pode virar `'sistema'` sem
alterar esse enum — não vale a pena para v0.1, então fica `null`, exatamente
como já fica quando o ator não é resolvível hoje.

O trigger `stamp_task_event_actor()` (`20260828101200_task_events.sql:207`)
precisa de um ajuste pequeno e aditivo — hoje ele zera o nome sempre que
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
    -- Novo: se algo setou app.system_actor_name NESTA transacao, usa —
    -- senao, mesmo comportamento de sempre (null). missing_ok=true evita
    -- erro quando a config nunca foi setada (todo o resto do sistema).
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
sem tocar em `frase()` no frontend — `actorNameSnapshot` já é o campo que
essa função lê hoje.

Todo caminho que **não** passa por `request_appointment_confirmation_scan`
continua se comportando exatamente como antes: a variável de sessão nunca é
setada, `current_setting(..., true)` devolve `null`, e o resultado é
idêntico ao de hoje.

---

## 7. Atomicidade e duplicação quando o cron roda 2×

Três camadas, cada uma cobrindo o que a anterior deixaria passar:

1. **`FOR UPDATE SKIP LOCKED` na varredura.** Se duas execuções do scan
   coincidirem (a de 15 min anterior ainda rodando quando a próxima
   dispara — `pg_cron` não impede isso sozinho), a segunda **pula** as
   linhas que a primeira já travou, em vez de esperar ou duplicar.
2. **Reafirmação da condição no `UPDATE`.** `where id = v_appt.id and
   status = 'scheduled'` — mesmo que duas execuções tenham lido a mesma
   linha como elegível antes de qualquer lock (janela teórica), só a
   primeira `UPDATE` a encontrar `status = 'scheduled'`; a segunda recebe
   `not found` e o `continue` pula para o próximo agendamento sem criar
   Pendência duplicada.
3. **A transição de status é a trava de fundo, entre execuções não
   sobrepostas.** Depois do disparo, o agendamento não está mais
   `scheduled` — a próxima varredura (15 min depois) nem sequer o
   seleciona. Um agendamento remarcado (`reschedule_requested → scheduled`)
   volta a ser elegível de propósito: nova data, novo ciclo de confirmação.

**Atomicidade por agendamento:** o bloco `begin...exception...end` dentro do
loop cria um savepoint implícito por iteração — se `insert into tasks` ou
`task_events` falhar depois do `UPDATE` já ter rodado, **só aquele
agendamento** desfaz (volta a `scheduled`, sem Pendência); os agendamentos
processados antes dele na mesma varredura continuam confirmados e com
Pendência, e os agendamentos seguintes do loop continuam sendo
processados.

**Execuções perdidas** (cron não rodou, ou a função inteira falhou):
nenhum mecanismo de retry separado é necessário. A janela de elegibilidade é
**larga** (24h, reavaliada a cada 15 min) e a condição é sobre **estado**
(`status = 'scheduled'`), não sobre "aconteceu num intervalo de tempo
específico". Um agendamento que deveria ter sido pego às 10h e não foi
continua `scheduled` e dentro da janela às 10h15, 10h30 etc. — a próxima
execução que rodar o pega, sem qualquer lógica de "recuperar o que perdi".
Isso é exatamente por que a decisão fechada foi "janela larga, não
estreita" (seção 4): uma janela estreita (ex.: "entre 24h e 23h45 antes")
perderia definitivamente um agendamento se um único tick falhasse.

---

## 8. `pg_cron` no Supabase Dev — verificado, não habilitado

Consulta direta (`pg_available_extensions`, `pg_extension`) contra o projeto
Dev, só leitura, nada alterado:

| Pergunta | Resposta |
|---|---|
| Está disponível para instalar? | **Sim** — `pg_cron` versão `1.6.4` aparece em `pg_available_extensions`. |
| Já está instalada/habilitada? | **Não** — ausente de `pg_extension`; `installed_version` é `null`. |

Ou seja: nenhum bloqueio de infraestrutura para a Opção A (`pg_cron` +
função `SECURITY DEFINER`). Habilitar a extensão e agendar o job é passo de
**implementação**, fora desta rodada — normalmente via o painel do Supabase
(Database → Extensions) ou `create extension pg_cron;` com privilégio
adequado, a confirmar no momento de implementar.

---

## 9. Migrations necessárias

**Confirmado: nenhuma tabela nova, nenhuma coluna nova.** Duas migrations,
as duas aditivas (nenhuma altera comportamento de código já em produção):

1. **Nova função `request_appointment_confirmation_scan(p_clinic_id uuid)`**
   (seção 5) — `SECURITY DEFINER`, `revoke execute` de `public`/`anon`/
   `authenticated` explícito (só chamável pelo `pg_cron`/dono do banco).
2. **Ajuste em `stamp_task_event_actor()`** (seção 6) — troca `null` fixo
   por `nullif(current_setting('app.system_actor_name', true), '')` no
   ramo `auth.uid() is null`. Aditivo e retrocompatível: sem a variável de
   sessão setada, o comportamento é idêntico ao de hoje.

Fora das migrations: agendar o job em si
(`select cron.schedule(...)`) — depende da extensão estar habilitada
(seção 8) e do `clinic_id` real da clínica piloto, então é passo de
implementação/operação, não de schema.

---

## 10. Como isso cria Pendências sem acoplar os módulos

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
precisa gravar uma linha com os IDs certos.

---

## 11. Os quatro desfechos

| Desfecho | O que acontece | Pendência |
|---|---|---|
| **Confirmado** | Recepção fala com o paciente, marca `awaiting_confirmation → confirmed` no `StatusPanel`. | Conclui manualmente — a automação não pode adivinhar que a conversa aconteceu fora da tela. |
| **Pediu reagendamento** | `awaiting_confirmation → reschedule_requested`. | Idem: conclui ou cancela manualmente; o fluxo de remarcação já existente assume dali. |
| **Não respondeu** | Nada muda de status. | Fica aberta e **vence** — cai em "Atrasadas" no Dashboard e em `/pendencias`. Nenhum estado novo, nenhum job de "verificar não-resposta": é o próprio prazo vencido. |
| **Cancelado** | Em qualquer momento, `→ cancelled`. | **Sem cascata** (decisão fechada) — a Pendência permanece aberta até a recepção agir. |

---

## 12. O que já funciona sem WhatsApp real vs. o que depende da Meta Cloud API

### Funciona hoje, sem nenhuma integração nova

- Disparo automático (`pg_cron` + função) na janela de 24h, a cada 15 min.
- Transição `scheduled → awaiting_confirmation`.
- Criação da Pendência vinculada, com ator "Sistema".
- Toda a jornada humana: recepção liga, manda mensagem pelo WhatsApp pessoal
  ou o que já faz hoje, registra o resultado pelo `StatusPanel` — o modo
  manual do Atendimento já serve para registrar esse contato, se a
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
  isso é bot/webhook, não Confirmações v0.1 (fora de escopo, seção 13).
- **`messages.deliveryStatus`** (`pending/sent/delivered/read/failed`) só
  passa a carregar informação real quando existe canal de verdade; hoje o
  CHECK do banco proíbe qualquer valor ali para mensagens manuais.
- Conversão do telefone do paciente para E.164 na fronteira (`toE164BR`,
  já existe) antes de qualquer envio real.

**A v0.1 inteira descrita aqui roda sem depender de uma linha da integração
Meta Cloud.**

---

## 13. Fora do escopo da v0.1 (de propósito)

Envio real de mensagem; recebimento e interpretação automática da resposta
do paciente (bot); múltiplas tentativas/lembretes escalonados; motor de
regras configurável ("se X, então Y"); qualquer automação que não seja
confirmação de agendamento; tabela de histórico de tentativas; canal
`whatsapp` de fato criado em `conversations`; cascata automática de
cancelamento da Pendência; qualquer UI nova — a v0.1 usa Pendências e o
`StatusPanel` que já existem, sem nenhuma tela nova.
