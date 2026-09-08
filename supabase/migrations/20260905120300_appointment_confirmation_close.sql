-- =============================================================================
-- Confirmacoes v0.1 — fecha a Task quando o agendamento sai de
-- awaiting_confirmation
--
-- POR QUE UM TRIGGER EM `appointments`, E NAO NA API
--
-- A mudanca de status hoje acontece por um caminho so
-- (`appointments.service.ts#changeStatus`, um UPDATE simples sob RLS,
-- chamado pelo StatusPanel) — mas amarrar o fechamento da Task a ESSE
-- servico especifico significa que qualquer caminho futuro que tambem mude
-- o status (um webhook do WhatsApp, por exemplo) teria que lembrar de
-- repetir a mesma logica. Um trigger `AFTER UPDATE OF status` dispara nao
-- importa quem mudou o status, hoje ou no futuro — mesmo raciocinio que ja
-- rege `enforce_appointment_status_transition` e `bump_task_version`.
--
-- SO A TASK DESTA AUTOMACAO, NUNCA OUTRAS
--
-- O select junta `tasks` a seu proprio evento `created` e filtra por
-- `metadata->>'source' = 'appointment_confirmation'`. Uma Task manual do
-- mesmo agendamento (criada pelo botao "Criar pendencia") nao tem essa
-- chave e fica intocada — o `join` so encontra a Task certa porque cada
-- Task tem exatamente UM evento `created`.
--
-- SEM DUPLICAR SEMANTICA DE CONCLUSAO
--
-- O UPDATE e o INSERT abaixo sao a MESMA forma que `task_complete` usa
-- (`status='completed', completed_at=now(), completed_by=auth.uid()` +
-- evento `completed` sem metadata) — nao uma segunda rotina reinventando
-- "o que significa concluir uma Task". `bump_task_version()` e
-- `enforce_task_status_transition()` ja disparam sozinhos, como triggers em
-- `tasks`, exatamente como disparariam para `task_complete`. A UNICA
-- diferenca deliberada: sem `expectedVersion` — isto e uma cascata interna
-- do sistema, nao um pedido de cliente com uma versao vista na tela, e o
-- proprio `where status = 'open'` ja evita duplicar o fechamento.
--
-- POR QUE `SECURITY DEFINER` AQUI NAO E SOBRE `auth.uid()`
--
-- Diferente da funcao de varredura, este trigger roda DENTRO da sessao real
-- de quem mudou o status do agendamento — a recepcionista, autenticada, com
-- `auth.uid()` preenchido normalmente. O motivo de precisar `SECURITY
-- DEFINER` e outro: `tasks`/`task_events` nao tem UPDATE/INSERT liberado
-- para `authenticated` (e RPC-only, de proposito). Sem `SECURITY DEFINER`,
-- o trigger tentaria escrever com os privilegios da recepcionista e
-- falharia por falta de grant.
--
-- Consequencia boa, nao pedida mas correta: como o trigger roda com
-- `auth.uid()` da recepcionista de verdade, o evento `completed` e
-- carimbado com ela como atora ("Maria concluiu a pendência.") — nao
-- "Sistema". Fez sentido: foi a acao real dela que causou o fechamento. O
-- GUC do ator "Sistema" so e necessario no lado da CRIACAO, onde de fato
-- nao ha sessao nenhuma.
--
-- ATOMICIDADE: de graca, garantida pelo proprio Postgres — o trigger AFTER
-- roda como parte da MESMA transacao que ja esta fazendo o UPDATE do
-- agendamento. Sem BEGIN/EXCEPTION aqui de proposito: se algo falhar de
-- verdade (nao o caso esperado de "ja fechada", que e um UPDATE comum sem
-- excecao), a excecao deve propagar e abortar a transacao inteira — o
-- agendamento nao pode virar `confirmed` se a Task correspondente nao puder
-- ser fechada, ou os dois lados ficariam dessincronizados.
-- =============================================================================

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

  select t.id into v_task_id
    from public.tasks t
    join public.task_events e
      on e.task_id = t.id and e.event_type = 'created'
   where t.appointment_id = new.id
     and t.status = 'open'
     and (e.metadata ->> 'source') = 'appointment_confirmation';

  if v_task_id is null then
    return new;
  end if;

  update public.tasks
     set status       = 'completed',
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

-- =============================================================================
-- EXECUTE — funcao de trigger, nunca chamada como RPC.
-- =============================================================================

revoke execute on function public.close_appointment_confirmation_task()
  from public, anon, authenticated;
