# =============================================================================
# Imagem do frontend Next.js (saida standalone)
#
# Build no GitHub Actions, nunca na VPS: aquela maquina tem 1 vCPU e roda a
# automacao de WhatsApp de uma cliente real.
#
# Contexto: raiz do monorepo. O BuildKit usa docker/web.Dockerfile.dockerignore
# no lugar do .dockerignore da raiz, que e o da API e exclui apps/web.
#
# As variaveis NEXT_PUBLIC_* sao embutidas no bundle em BUILD TIME, entao cada
# imagem pertence a um unico ambiente. Sao publicas por natureza: nenhum segredo
# pode entrar por aqui, e nao existe valor padrao de proposito.
#
#   manifests - so os package.json, camada estavel de cache
#   build     - instala dependencias e gera .next/standalone
#   runtime   - standalone + static + public, nada mais
# =============================================================================
FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# -----------------------------------------------------------------------------
# manifests - apps/api entra apenas com o manifesto: o lockfile descreve o
# workspace inteiro e o --frozen-lockfile recusa se um membro estiver ausente.
# -----------------------------------------------------------------------------
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY apps/web/package.json        apps/web/
COPY apps/api/package.json        apps/api/

# -----------------------------------------------------------------------------
# build - o filtro deixa apps/api de fora. As devDependencies da raiz ainda entram
# neste estagio (o pnpm instala a raiz junto), mas nada delas chega ao runtime.
# -----------------------------------------------------------------------------
FROM manifests AS build
RUN pnpm install --frozen-lockfile --filter "@clinicas/web..."
COPY packages/ packages/
COPY apps/web/ apps/web/

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# `next build` passa sem estas variaveis e o erro so apareceria na primeira
# requisicao, em producao. Aqui a ausencia derruba o build, com o nome da variavel.
RUN : "${NEXT_PUBLIC_SUPABASE_URL:?build-arg NEXT_PUBLIC_SUPABASE_URL ausente}" \
 && : "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY ausente}" \
 && : "${NEXT_PUBLIC_API_URL:?build-arg NEXT_PUBLIC_API_URL ausente}"

# O script do web ja compila @clinicas/shared antes do next build.
RUN pnpm --filter @clinicas/web build

# -----------------------------------------------------------------------------
# runtime - sem pnpm nem corepack. O trace do standalone preserva a estrutura do
# monorepo, por isso o server.js fica em apps/web/.
# -----------------------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# O Docker define HOSTNAME como o id do container, e o server.js escutaria so
# nessa interface: o healthcheck em 127.0.0.1 falharia.
ENV HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public           ./apps/web/public

# Menor privilegio: a porta e 3000 (>1024), entao root e desnecessario.
USER node
WORKDIR /app/apps/web
EXPOSE 3000

# `/` e publica e nao tem sessao para validar, entao nao consulta o Supabase: um
# health que depende de terceiro faria instabilidade dele reiniciar o container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
