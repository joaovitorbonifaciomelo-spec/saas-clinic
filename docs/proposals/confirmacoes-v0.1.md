# Proposta técnica — Confirmação de Agendamento v0.1

> **Status: proposta para decisão. Nada implementado.** Nenhuma migration,
> SQL, endpoint, componente ou teste foi escrito.
>
> Escrita depois de ler `appointment.ts`, `conversation.ts`, `task.ts`, o
> serviço e controller de `apps/api/src/appointments`, as migrations de
> Atendimento e de Pendências, e `docs/architecture.md` §6.1 (modo manual).
>
> Há **9 decisões abertas**, listadas na seção 11. Este documento não escolhe
> por você — mostra o que o schema atual já resolve sozinho, o que exige uma
> escolha de produto, e o que exige uma escolha de arquitetura.

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

**O modelo atual já resolve quase tudo isto sozinho — nenhuma automação nova
precisa saber disso, ela só precisa usar o que já existe.**

Três peças, já no schema, já prontas:

1. **`AppointmentStatus` já tem os quatro desfechos.** `scheduled` →
   `awaiting_confirmation` → `confirmed` | `reschedule_requested` |
   `cancelled`. Não faltam estados — ver seção 3.
2. **`task_create` já aceita `appointmentId` e `patientId`.** É a mesma RPC
   que os botões "Criar pendência" de Atendimento/Paciente/Agendamento já
   chamam (commit `6ef02ab`). A automação é só mais um chamador — ver
   seção 9.
3. **O disparo já tem para onde apontar sem inventar estado novo:** a
   transição de status **é** o registro de que a confirmação foi pedida, e a
   fila "Atrasadas" de Pendências **é** o alarme de "não respondeu" — ver
   seções 4 e 6.

A consequência prática: **a v0.1 não precisa de tabela nova, nem de coluna
nova nos agendamentos, nem de enum novo.** Ela precisa de uma função no
banco e de uma decisão sobre quem a chama (seção 5).

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
exatamente este caminho — a automação não pede nenhuma transição que o
`StatusPanel` manual já não faça hoje.

---

## 4. Quando uma confirmação deve ser disparada

Condição de entrada, avaliada periodicamente (ver seção 5 para "por quem"):

```
status = 'scheduled'
  AND starts_at está dentro da janela de antecedência configurada
  AND não existe Pendência ABERTA já vinculada a este appointment_id
```

A terceira cláusula é o que evita duplicidade — ver seção 6. As duas
primeiras são a regra de negócio central, e a **janela de antecedência (ex.:
48h, 24h) é uma decisão de produto, não técnica** — ver seção 11, decisão D1.

Quando a condição bate, a automação faz **uma única operação atômica** (uma
função SQL, não dois passos separados que podem falhar no meio):

1. `status: scheduled → awaiting_confirmation` (transição já permitida);
2. cria uma Pendência via a mesma lógica de `task_create`, com
   `appointmentId` e `patientId` preenchidos, título como *"Confirmar
   consulta de {paciente} — {data} às {hora}"*, `dueAt` definido pela janela
   (decisão D1) e sem responsável (fila geral, como qualquer Pendência sem
   atribuição direta).

Se qualquer uma das duas etapas falhar, as duas revertem — nunca um
agendamento fica `awaiting_confirmation` sem a Pendência correspondente,
nem o contrário.

---

## 5. Quem dispara — a decisão de arquitetura real (não é retórica, é a D2)

Este é o único ponto onde a v0.1 precisa de algo que **não existe hoje**: um
jeito de rodar código no banco **sem uma sessão de usuário autenticado**.
Tudo que a API faz hoje parte de um JWT real (`apps/api` não tem
`service_role` no código, de propósito — ver o "Achados" do plano original).
Um job periódico não tem esse JWT.

Duas opções realistas, ambas viáveis sem violar nenhuma regra já
estabelecida no projeto:

**Opção A — `pg_cron` chamando uma função `SECURITY DEFINER` direto no
Postgres.** Mesmo padrão já usado por `create_clinic_with_owner`,
`task_create` etc. Roda como o dono do banco, não como `authenticated`, e
**o schema já tolera isso**: `stamp_task_event_actor()` (migration
`20260828101200_task_events.sql:217`) já trata `auth.uid() is null` como
caso válido — é exatamente o mesmo caminho que preserva o histórico quando
um usuário sai da clínica. A Pendência nasce com `actor_user_id: null`
("Alguém criou a pendência" na tela — ver decisão D6). Vantagem: nenhuma
credencial nova, nenhuma rota nova na API, nenhuma superfície de ataque
nova. `pg_cron` é extensão gerenciada do Supabase — precisa confirmar que
está disponível/habilitada no projeto Dev antes de implementar.

**Opção B — um agendador externo (ex.: Vercel Cron) chamando uma rota nova
na API.** Exigiria introduzir alguma forma de credencial de serviço na API
— algo que o projeto **nunca fez** até aqui, deliberadamente. É mais
trabalho, mais superfície nova, e vai contra uma decisão de arquitetura já
tomada sem necessidade real.

**Recomendação: Opção A.** Resolve o problema com o padrão que o projeto já
usa em cinco lugares (RPCs `SECURITY DEFINER`), sem tocar na API nem no
modelo de segredos.

---

## 6. Como registrar tentativa e resultado, e como evitar duplicidade

**Tentativa** = a existência da Pendência. Não precisa de coluna nova: uma
Pendência com `appointment_id = X` **é** o registro de que uma confirmação
foi solicitada, com timestamp (`created_at`) e, se a v0.1 adotar D6, um
marcador de que foi automática.

**Resultado** = a transição de status do próprio agendamento, feita pela
recepção do jeito que já existe hoje — o `StatusPanel` manual, sem nenhuma
tela nova. Confirmar, pedir reagendamento e cancelar já são um clique cada.

**Duplicidade** é evitada em duas camadas, e a segunda não depende da
primeira sair certo:

1. **A transição de status é a trava principal.** Depois do disparo, o
   agendamento não está mais em `scheduled` — a condição de entrada (seção
   4) já não bate mais. Um agendamento remarcado (`reschedule_requested →
   scheduled`, transição já permitida) volta a ser elegível de propósito:
   nova data, novo ciclo de confirmação é o comportamento correto, não um
   bug.
2. **A checagem "já existe Pendência aberta para este `appointment_id`"**
   cobre o caso em que o job roda duas vezes antes da primeira transição
   commitar (concorrência entre execuções). Barata: é o mesmo índice que já
   existiria em `tasks(appointment_id)` para qualquer consulta por
   contexto.

Nenhuma tabela de log de tentativas é necessária na v0.1 — seria motor de
automação genérico antes da hora. Se um dia precisar de múltiplas tentativas
por agendamento (lembrete em D-2 **e** D-1, por exemplo), *aí* uma tabela de
tentativas se justifica. Hoje seria complexidade sem uso.

---

## 7. Os quatro desfechos

| Desfecho | O que acontece | Pendência |
|---|---|---|
| **Confirmado** | Recepção fala com o paciente, marca `awaiting_confirmation → confirmed` no `StatusPanel`. | Fica para a recepção **concluir manualmente** — a automação não pode adivinhar que a conversa aconteceu fora da tela (decisão D4). |
| **Pediu reagendamento** | `awaiting_confirmation → reschedule_requested`. | Idem: conclui ou cancela manualmente, e o fluxo de remarcação já existente assume dali. |
| **Não respondeu** | Nada muda de status. | A Pendência **fica aberta e vence** — cai em "Atrasadas" no Dashboard e em `/pendencias`, exatamente o alarme que se quer. Nenhum estado novo, nenhum job de "verificar não-resposta": é o próprio prazo vencido. |
| **Cancelado** | Em qualquer momento, `→ cancelled` (transição já permitida de `scheduled` e de `awaiting_confirmation`). | A Pendência correspondente fica órfã de sentido — ver decisão D5 (auto-cancelar a Pendência quando o agendamento é cancelado, ou deixar para a recepção limpar). |

---

## 8. O que já funciona sem WhatsApp real vs. o que depende da Meta Cloud API

### Funciona hoje, sem nenhuma integração nova

- Disparo automático (cron/RPC) na janela configurada.
- Transição `scheduled → awaiting_confirmation`.
- Criação da Pendência vinculada.
- Toda a jornada humana: recepção liga, manda mensagem pelo WhatsApp pessoal
  ou o que já faz hoje, registra o resultado pelo `StatusPanel` — **o modo
  manual do Atendimento já serve para registrar esse contato**, se a
  recepção quiser (`POST /conversations/:id/messages`, sem enviar nada).
- Todo o alarme de "não respondeu" (fila de Pendências vencidas).

### Depende da Meta Cloud API

- **Envio automático de fato.** Hoje `conversation.channel` só é criado como
  `'manual'` — nenhum caminho de código cria `channel: 'whatsapp'` ainda,
  embora o enum já exista (`CONVERSATION_CHANNELS`, `CONVERSATION_PROVIDERS
  = ['meta_cloud', 'evolution']`) — o schema foi desenhado para isto, só não
  foi ligado.
- **Recebimento automático da resposta do paciente** ("SIM"/"não posso") e
  tradução disso em `confirmed`/`reschedule_requested` sem toque humano.
  Isso é bot/webhook, não Confirmações v0.1 — ver "fora do escopo", seção 12.
- **`messages.deliveryStatus`** (`pending/sent/delivered/read/failed`) só
  passa a carregar informação real quando existe canal de verdade; hoje o
  CHECK do banco proíbe qualquer valor ali para mensagens manuais.
- Conversão do telefone do paciente para E.164 na fronteira
  (`toE164BR`, já existe) antes de qualquer envio real.

**Ou seja: a v0.1 inteira descrita aqui roda sem depender de uma linha da
integração Meta Cloud.** Ela é o trabalho que vale a pena fazer primeiro
justamente porque não fica bloqueada esperando a API do WhatsApp.

---

## 9. Mudanças de banco necessárias

**Nenhuma tabela nova. Nenhuma coluna nova em `appointments`.**
`task_create` já aceita tudo que a automação precisa enviar.

O que precisa ser escrito:

1. Uma função `SECURITY DEFINER`, ex. `request_appointment_confirmation()`,
   que faz a operação atômica da seção 4 — provavelmente iterando os
   agendamentos elegíveis de todas as clínicas numa varredura, já que quem
   chama não tem `clinic_id` de sessão.
2. O agendamento do `pg_cron` (uma linha de SQL, se a extensão estiver
   disponível — precisa confirmar).
3. **Se** a decisão D6 (seção 11) escolher marcar a Pendência como
   "automática" para a tela mostrar uma frase melhor que "Alguém criou a
   pendência": um ajuste pequeno e aditivo em
   `task_events_created_metadata` (permitir mais uma chave opcional) e no
   `taskCreatedMetadataSchema` correspondente em `packages/shared`. Sem essa
   decisão, zero mudança de schema.

Tudo dentro do que `db:push` no projeto Dev já sabe fazer — mesmo padrão das
migrations de Pendências.

---

## 10. Como isso cria Pendências sem acoplar os módulos

Já é assim que os quatro pontos de entrada existentes funcionam (Atendimento,
Paciente, Agendamento, e agora a automação seria o quinto): todos chamam
`task_create`, nenhum lê o código-fonte um do outro.

```
Confirmações  ──▶  task_create(appointmentId, patientId, …)  ──▶  Pendências
     │                                                              │
     └── só sabe que "appointment_id" e "patient_id" existem ───────┘
         (as MESMAS colunas nullable que os botões manuais já usam)
```

A automação não importa nada de `apps/web/.../pendencias`, não conhece
`.pd-*`, não sabe que existe um Dashboard. Ela só grava uma linha em
`tasks` com os IDs certos — exatamente como o botão "Criar pendência" do
Agendamento faz hoje, só que disparado por tempo em vez de clique. Pendências
continua sendo o único módulo que sabe o que é uma Pendência; Confirmações só
sabe que precisa de uma.

---

## 11. Decisões que precisam de você

| # | Decisão | Opções | Onde importa |
|---|---|---|---|
| **D1** | Janela de antecedência do disparo | Fixa (ex.: 48h) vs. configurável por clínica/serviço | §4 |
| **D2** | Quem dispara | `pg_cron` + RPC (recomendado) vs. agendador externo + rota nova na API | §5 |
| **D3** | Frequência da varredura | A cada hora? Uma vez por dia? | §5 |
| **D4** | Resultado é sempre manual na v0.1, ou o Atendimento por WhatsApp real (quando existir) pode concluir a Pendência sozinho? | Manual sempre (v0.1) vs. planejar o gancho automático desde já | §7 |
| **D5** | Agendamento cancelado com Pendência de confirmação aberta | Cancela a Pendência junto (automático) vs. deixa para a recepção limpar | §7 |
| **D6** | Vale marcar a Pendência como "criada automaticamente" para a tela mostrar isso (em vez de "Alguém criou a pendência")? | Sim (pequeno ajuste aditivo, §9) vs. não (aceitar o texto genérico na v0.1) | §5, §9 |
| **D7** | Título/texto exato da Pendência gerada | Este documento sugere um formato em §4 — precisa aprovação do texto final | §4 |
| **D8** | A automação roda em todas as clínicas por padrão, ou é opt-in por clínica? | Ligada para todos vs. flag por clínica | §4 |
| **D9** | `pg_cron` está disponível/habilitado no projeto Supabase Dev? | Precisa confirmar antes de qualquer implementação — se não estiver, a Opção A da D2 muda de custo | §5 |

---

## 12. Fora do escopo da v0.1 (de propósito)

Envio real de mensagem; recebimento e interpretação automática da resposta
do paciente (bot); múltiplas tentativas/lembretes escalonados; motor de
regras configurável ("se X, então Y"); qualquer automação que não seja
confirmação de agendamento; tabela de histórico de tentativas; canal
`whatsapp` de fato criado em `conversations`; qualquer UI nova — a v0.1 usa
Pendências e o `StatusPanel` que já existem, tela por tela, sem nenhuma tela
nova.
