# Deploy de Production na VPS

Ambiente real da clinica, com dados de pacientes. Development continua sendo o
Supabase atual e `/opt/clinic-saas`, sem relacao com esta stack.

## Arquitetura

```
Internet -> Caddy (PUBLIC_IP:80/443) -> web:3000 -> api:3333 -> Supabase Production
```

Containers: `clinic-saas-production-caddy`, `clinic-saas-production-web` e
`clinic-saas-production-api`, na rede `clinic-saas-production-net`. Web e API nao
publicam porta. O navegador nunca chama a API: as chamadas partem do servidor do
Next, com `NEXT_PUBLIC_API_URL=http://clinic-saas-production-api:3333`.

Nunca buildar na VPS: ela tem 1 vCPU e roda a automacao de WhatsApp de uma cliente.

## Arquivos na VPS

```
/opt/clinic-saas-production/
  docker-compose.yml                  <- docker/clinic-saas-production.compose.yml
  clinic-saas-production.Caddyfile    <- docker/clinic-saas-production.Caddyfile
  .env                                <- modo 600, a partir de docker/clinic-saas-production.env.example
  .env.previous                       <- .env anterior, para rollback
```

Baixe os dois primeiros do GitHub no commit aprovado e crie o `.env` na propria
VPS. Copiado do Windows, ele pode levar CRLF para dentro dos valores.

## GitHub (somente nomes)

| Tipo     | Nome                                       | Valor                                    |
| -------- | ------------------------------------------ | ---------------------------------------- |
| Variable | `PRODUCTION_NEXT_PUBLIC_SUPABASE_URL`      | URL do projeto Production                |
| Variable | `PRODUCTION_NEXT_PUBLIC_API_URL`           | `http://clinic-saas-production-api:3333` |
| Secret   | `PRODUCTION_NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key do projeto Production           |

## Passos

1. **Criar o Supabase Production** em `sa-east-1`, Postgres 17.
2. **Aplicar as migrations.** `pnpm db:push` recusa Production de proposito. Rode
   `pnpm supabase link --project-ref <production>`, confira o ref e rode
   `pnpm db:push:raw`. Depois, volte o link para Development. Nao rode as suites
   de teste aqui: elas usam `service_role` e criam dados.
3. **Configurar o Auth:** desligar o cadastro publico e definir a Site URL como
   `https://HOST`. **Nao** criar o job `appointment-confirmation-pilot`: as
   migrations nao o criam, e a clinica ja tem automacao de WhatsApp separada.
4. **Criar o hostname**, com registro A para o IP da VPS. Sem AAAA: o Caddy so
   publica no IPv4.
5. **Abrir 80 e 443** no firewall da Hostinger. A 80 e necessaria para emitir o
   certificado e o redirecionamento para HTTPS.
6. **Configurar** as variables e o secret do GitHub.
7. **Buildar as imagens.** Web: workflow `Web image`, manual, no commit aprovado.
   API: use a tag `sha-` ja publicada pelo workflow `API image`.
8. **Criar** `/opt/clinic-saas-production` com os arquivos acima.
9. **Subir:**
   ```bash
   cd /opt/clinic-saas-production
   docker compose config --quiet   # acusa variavel faltando
   docker compose pull
   docker compose up -d
   ```
10. **Validar o HTTPS e o isolamento:**
    ```bash
    docker compose ps                                  # os tres healthy
    curl -sI https://HOST/ | head -1
    ss -tlnp | grep -E ':(80|443|3333) '
    pm2 list                                           # bot-longatti: restarts inalterados
    docker ps --format '{{.Names}} {{.Status}}'        # evolution/postgres/redis/retornaveis Up
    free -h
    ```
    Se o contador de restarts do `bot-longatti` subir, reverta com `docker compose down`.
11. **Criar a clinica e os usuarios.** Crie as contas no painel do Supabase, com
    e-mail ja confirmado. O primeiro login cria a clinica no onboarding e vira
    `admin`. Nao ha convite na interface: os demais entram por SQL administrativo
    em `clinic_members` (`clinic_id`, `user_id`, `role`), com role `attendant`,
    `professional` ou `admin`.
12. **Smoke test** com um `admin` e um `attendant`: login, agenda, pacientes,
    atendimento, pendencias e logout, em dados de teste que depois serao removidos.
13. **Habilitar o uso real**, somente com o backup abaixo decidido e testado.

## Backup

Production precisa, antes do passo 13, de:

- **backup do Supabase**, sem assumir que o plano Free inclua backup automatico;
- **politica de retencao** definida com a clinica;
- **restore testado** de verdade, em um projeto separado.

A forma sera decidida na criacao do projeto Production.

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
