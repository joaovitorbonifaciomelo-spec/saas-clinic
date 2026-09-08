-- =============================================================================
-- Confirmacoes v0.1 — varredura que abre a Task de confirmacao
--
-- POR QUE NAO REAPROVEITA `task_create`
--
-- `task_create` comeca com `if not public.is_clinic_member(p_clinic_id)`, e
-- `is_clinic_member` resolve `m.user_id = (select auth.uid())`. Com
-- `auth.uid()` nulo — o caso de QUALQUER execucao via `pg_cron`, sem sessao
-- de usuario — essa comparacao nunca e verdadeira, e `task_create` sempre
-- devolveria `not_found`. Nao e uma barreira acidental: ela existe para
-- impedir que uma SESSAO crie pendencia numa clinica da qual nao e membro.
-- Esse risco nao existe aqui: quem chama ja leu o `clinic_id` direto da
-- linha de `appointments` que esta processando.
--
-- Por isso esta e uma funcao NOVA e dedicada, que insere direto em
-- `tasks`/`task_events` — nunca exposta como RPC de cliente (ver o
-- `revoke` no fim do arquivo).
--
-- ESCOPO: SOMENTE a clinica recebida em p_clinic_id
--
-- Sem varredura global e sem clinica hardcoded no corpo da funcao — quem
-- agenda o `pg_cron` decide o escopo passando o argumento
-- (`select request_appointment_confirmation_scan('<uuid-da-clinica>')`).
-- Isso e o que faz o opt-in "so da clinica piloto" funcionar sem nenhuma
-- tabela nem coluna de configuracao.
--
-- DUPLICACAO, em tres camadas (nenhuma sozinha e suficiente):
--
--   1. `for update of a skip locked` — se duas execucoes coincidirem
--      (a anterior ainda rodando quando a proxima dispara: pg_cron nao
--      impede isso sozinho), a segunda PULA as linhas que a primeira ja
--      travou, em vez de esperar ou duplicar.
--   2. O `update` do agendamento REAFIRMA `status = 'scheduled'` no
--      instante exato — mesmo que as duas leituras tenham acontecido antes
--      de qualquer lock, so a primeira encontra a linha; a segunda recebe
--      `not found` e pula.
--   3. Depois do disparo, `status <> 'scheduled'` — a proxima varredura
--      nem seleciona a linha. Um agendamento remarcado
--      (`reschedule_requested -> scheduled`) volta a ser elegivel de
--      proposito: nova data, novo ciclo.
--
-- ATOMICIDADE por agendamento: o bloco `begin...exception...end` dentro do
-- loop cria um SAVEPOINT implicito por iteracao. Se o insert da Task ou do
-- evento falhar depois do `update` do agendamento ja ter rodado, so aquele
-- agendamento desfaz (volta a `scheduled`, sem Task) — os demais da mesma
-- varredura, processados antes ou depois, nao sao afetados.
--
-- EXECUCOES PERDIDAS: nenhum mecanismo de retry separado. A janela e larga
-- (24h, reavaliada a cada chamada) e a condicao e sobre ESTADO
-- (`status = 'scheduled'`), nao sobre "aconteceu num intervalo especifico".
-- Um agendamento que deveria ter sido pego e nao foi continua elegivel na
-- proxima chamada.
-- =============================================================================

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
         and status = 'scheduled';

      if not found then
        continue;
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

      -- 'source' e a identidade tecnica desta Task — ver a migration do
      -- CHECK. E a UNICA chave alem de assignedTo que o banco aceita aqui.
      insert into public.task_events (clinic_id, task_id, event_type, metadata)
      values (
        v_appt.clinic_id, v_task_id, 'created',
        jsonb_build_object('source', 'appointment_confirmation')
      );

    exception when others then
      raise warning 'confirmacao automatica: falha no agendamento %: %',
        v_appt.id, sqlerrm;
    end;
  end loop;
end;
$$;

-- =============================================================================
-- EXECUTE — nunca exposta. So o dono do banco/pg_cron chama.
-- =============================================================================

revoke execute on function public.request_appointment_confirmation_scan(uuid)
  from public, anon, authenticated;

comment on function public.request_appointment_confirmation_scan(uuid) is
  'Varredura de confirmacao de agendamento (Confirmacoes v0.1). Chamada '
  'SOMENTE por pg_cron/dono do banco, com o clinic_id explicito no '
  'argumento — nunca varredura global, nunca RPC de cliente.';
