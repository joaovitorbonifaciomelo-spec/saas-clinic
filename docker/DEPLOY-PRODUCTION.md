# Deploy de Production na VPS

Ambiente real da clinica, com dados de pacientes. Development continua sendo o
Supabase de desenvolvimento e `/opt/clinic-saas`, sem relacao com esta stack.

## Arquitetura

```
Internet
  -> Tailscale Funnel :10000 (HTTPS)
  -> 127.0.0.1:3320
  -> clinic-saas-production-web:3000
  -> clinic-saas-production-net
  -> clinic-saas-production-api:3333
  -> Supabase Production
```

URL publica: `https://srv1779541.taild2349f.ts.net:10000`

| Porta | Onde          | Exposicao                                  |
| ----- | ------------- | ------------------------------------------ |
| 10000 | Funnel        | publica, com HTTPS do Tailscale            |
| 3320  | host          | somente `127.0.0.1`                        |
| 3000  | container Web | somente rede da stack e o mapeamento acima |
| 3333  | container API | somente rede da stack                      |

O navegador nunca chama a API: as chamadas partem do servidor do Next, com
`NEXT_PUBLIC_API_URL=http://clinic-saas-production-api:3333`.

Nunca buildar na VPS: ela tem 1 vCPU e roda a automacao de WhatsApp de uma cliente.

## Arquivos na VPS

```
/opt/clinic-saas-production/
  docker-compose.yml   <- docker/clinic-saas-production.compose.yml
  .env                 <- modo 600, a partir de docker/clinic-saas-production.env.example
  .env.previous        <- .env anterior, para rollback
```

Baixe o compose do GitHub no commit aprovado e crie o `.env` na propria VPS.
Copiado do Windows, ele pode levar CRLF para dentro dos valores.

No `.env`, `WEB_ORIGIN` e a URL publica acima.

## GitHub (somente nomes)

Em Settings -> Secrets and variables -> Actions:

| Tipo     | Nome                                       | Valor                                    |
| -------- | ------------------------------------------ | ---------------------------------------- |
| Variable | `PRODUCTION_NEXT_PUBLIC_SUPABASE_URL`      | URL do projeto Production                |
| Variable | `PRODUCTION_NEXT_PUBLIC_API_URL`           | `http://clinic-saas-production-api:3333` |
| Secret   | `PRODUCTION_NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key do projeto Production           |

## Passos

1. **Criar o Supabase Production** em `sa-east-1`, Postgres 17.
2. **Aplicar as migrations.** `pnpm db:push` recusa Production de proposito. Rode
   `pnpm supabase link --project-ref <production>`, confira o ref e rode
   `pnpm db:push:raw`. Depois, tire o link com `pnpm supabase unlink` ou volte
   para Development. Nao rode as suites de teste aqui: elas usam `service_role` e
   criam dados.
3. **Configurar o Auth:** desligar o cadastro publico e definir a Site URL como a
   URL publica. **Nao** criar o job `appointment-confirmation-pilot`: as
   migrations nao o criam, e a clinica ja tem automacao de WhatsApp separada.
4. **Configurar** as variables e o secret do GitHub.
5. **Buildar as imagens.** Web: workflow `Web image`, manual, no commit aprovado.
   API: use a tag `sha-` ja publicada pelo workflow `API image`.
6. **Criar** `/opt/clinic-saas-production` com os arquivos acima.
7. **Subir:**
   ```bash
   cd /opt/clinic-saas-production
   docker compose config --quiet   # acusa variavel faltando
   docker compose pull
   docker compose up -d
   docker compose ps               # os dois healthy
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3320/
   ```
8. **Ativar o Funnel** (secao abaixo).
9. **Validar o HTTPS e o isolamento:**
   ```bash
   curl -sI https://srv1779541.taild2349f.ts.net:10000/ | head -1
   ss -tlnp | grep -E ':(3320|3333) '           # 3320 so em 127.0.0.1
   pm2 list                                     # bot-longatti: restarts inalterados
   docker ps --format '{{.Names}} {{.Status}}'  # evolution/postgres/redis/retornaveis Up
   free -h
   ```
   Se o contador de restarts do `bot-longatti` subir, desative o Funnel 10000 e
   rode `docker compose down`.
10. **Criar a clinica e os usuarios.** Crie as contas no painel do Supabase, com
    e-mail ja confirmado. O primeiro login cria a clinica no onboarding e vira
    `admin`. Nao ha convite na interface: os demais entram por SQL administrativo
    em `clinic_members` (`clinic_id`, `user_id`, `role`), com role `attendant`,
    `professional` ou `admin`.
11. **Smoke test** com um `admin` e um `attendant`: login, agenda, pacientes,
    atendimento, pendencias e logout, em dados de teste que depois serao removidos.
    Confirme que os formularios salvam: as Server Actions dependem de o Funnel
    repassar o host com a porta.
12. **Habilitar o uso real**, somente com o backup abaixo decidido e testado.

## Tailscale Funnel

O no ja publica outros servicos pelo mesmo Funnel: a porta 443 (API de Development)
e a 8443 (Retornaveis). Cada comando abaixo mexe so na porta 10000.

**Verificar:**

```bash
tailscale funnel status
```

**Ativar:**

```bash
tailscale funnel status                                      # antes: anote 443 e 8443
tailscale funnel --bg --https=10000 http://127.0.0.1:3320
tailscale funnel status                                      # 443 e 8443 iguais, 10000 novo
```

**Desativar somente a 10000:**

```bash
tailscale funnel --https=10000 off
tailscale funnel status                                      # 443 e 8443 continuam
```

**NUNCA rode `tailscale funnel reset`:** ele apaga a configuracao inteira do no e
derruba tambem o Retornaveis e a API de Development.

## Backup

Production precisa, antes do passo 12, de:

- **backup do Supabase**, sem assumir que o plano Free inclua backup automatico;
- **politica de retencao** definida com a clinica;
- **restore testado** de verdade, em um projeto separado.

A forma sera decidida antes do uso real.

## Rollback

Toda imagem e fixada por SHA, entao voltar devolve exatamente o binario anterior.

```bash
cd /opt/clinic-saas-production
cp .env .env.previous             # ANTES de cada atualizacao
# para reverter:
cp .env.previous .env
docker compose up -d
docker compose ps
```

Migrations nao voltam com a imagem. Se a versao nova trouxe migration, avalie a
compatibilidade antes de reverter; os scripts existentes estao em `supabase/rollback`.
