-- =============================================================================
-- Confirmacoes v0.1 — identidade tecnica da Task automatica em created.metadata
--
-- Uma Task nascida da varredura de confirmacao de agendamento carrega
-- `created.metadata.source = 'appointment_confirmation'`. Aditiva: o CHECK
-- anterior so aceitava a chave `assignedTo` em `created.metadata` — esta
-- migration acrescenta `source` como chave opcional, com valor FECHADO, nao
-- texto livre. Se um dia existir uma segunda automacao, o CHECK cresce por
-- migration explicita (`in ('appointment_confirmation', 'outro_valor')`), do
-- mesmo jeito que qualquer enum deste projeto cresce.
--
-- `source` NUNCA vira UI. E identidade tecnica para o proprio banco
-- reconhecer "esta Task pertence a esta automacao" quando precisar fecha-la
-- (ver `close_appointment_confirmation_task` na proxima migration) — nao um
-- rotulo para pessoa ver. O frontend continua sem tocar nesta chave.
--
-- DROP + ADD porque o PostgreSQL nao tem "ALTER CHECK": e a unica forma de
-- trocar a definicao de uma constraint ja existente.
-- =============================================================================

alter table public.task_events
  drop constraint task_events_created_metadata;

alter table public.task_events
  add constraint task_events_created_metadata check (
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
  );
