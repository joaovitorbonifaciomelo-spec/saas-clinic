-- =============================================================================
-- Confirmacoes v0.1 — ator "Sistema" em task_events, via GUC de transacao
--
-- `stamp_task_event_actor()` ja tratava `auth.uid()` nulo como caso valido
-- (ex.: ator que saiu da clinica) — zerava nome e papel. Esta migration
-- ensina o MESMO ramo a checar, antes de zerar, se a transacao setou
-- `app.system_actor_name`. So a varredura de confirmacao de agendamento
-- (proxima migration, `SECURITY DEFINER`, sem sessao de usuario) seta esse
-- valor; nenhum outro caminho do sistema o toca, entao o comportamento de
-- hoje fica IDENTICO para todo o resto — aditiva e retrocompativel.
--
-- SEGURANCA: `app.system_actor_name` nao e legivel nem gravavel por
-- `authenticated`/`anon`. Nao ha rota, RPC nem parametro de entrada que
-- aceite esse valor do cliente — so o codigo-fonte da funcao de varredura,
-- que por sua vez so e executavel pelo dono do banco/`pg_cron` (revoke
-- explicito na propria migration dela), pode produzir "Sistema" num evento.
-- `set_config(..., true)` e escopo de TRANSACAO: some sozinho ao fim, nunca
-- vaza para outra sessao ou outro chamador.
--
-- `actor_role_snapshot` continua NULL neste ramo — e o enum `clinic_role`
-- (admin/attendant/professional) e nao vale a pena estende-lo so para um
-- valor "sistema" na v0.1.
-- =============================================================================

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
    -- missing_ok=true: nunca erro quando a config nao foi setada (todo o
    -- resto do sistema, hoje e sempre — so a varredura de confirmacao a seta).
    new.actor_name_snapshot := nullif(current_setting('app.system_actor_name', true), '');
    new.actor_role_snapshot := null;
    return new;
  end if;

  select s.full_name, s.role
    into v_name, v_role
    from public.current_actor_snapshot(new.clinic_id) as s;

  new.actor_user_id       := auth.uid();
  new.actor_name_snapshot := v_name;
  new.actor_role_snapshot := v_role;
  return new;
end;
$$;
