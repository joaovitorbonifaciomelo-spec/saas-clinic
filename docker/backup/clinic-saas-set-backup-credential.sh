#!/usr/bin/env bash
# =============================================================================
# Grava a credencial do backup em backup.env (modo 600), na propria VPS.
#
# A connection string e digitada sem eco e nao passa por argumento, entao nao
# aparece na tela, no historico nem na lista de processos. Nada dela e impresso.
# =============================================================================
set -Eeuo pipefail
umask 077

readonly BASE=/opt/clinic-saas-production
readonly ENV_FILE="$BASE/backup.env"
readonly IMAGE=postgres:17.11-alpine

printf 'Cole a connection string do Session pooler do Production e tecle Enter (nao aparece na tela): '
IFS= read -rs url
echo

tmp="$(mktemp "$BASE/.backup.env.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT

printf '%s' "$url" | python3 -c '
import sys
from urllib.parse import urlsplit, unquote

def stop(message):
    print("RECUSADA: " + message, file=sys.stderr)
    sys.exit(1)

raw = sys.stdin.read().strip()
if "xrhcwtbswzjcvgxyvpel" in raw:
    stop("esta string e do Development.")
if "wispzoqbtibldrfzgefn" not in raw:
    stop("esta string nao e do Production (wispzoqbtibldrfzgefn).")
if "[" in raw or "]" in raw or "%5B" in raw.upper() or "%5D" in raw.upper():
    stop("remova os colchetes do modelo [YOUR-PASSWORD]. Se a senha tiver colchetes de verdade, troque a senha.")
if "YOUR-PASSWORD" in raw.upper():
    stop("a senha ainda e o texto do modelo.")
try:
    u = urlsplit(raw)
    host, port = u.hostname, u.port or 5432
except ValueError:
    stop("formato invalido.")
if u.scheme not in ("postgres", "postgresql") or not host or not u.username or not u.password:
    stop("faltam usuario, senha ou host.")
password = unquote(u.password)
if "\n" in password or "\r" in password:
    stop("senha com quebra de linha.")
print("PGHOST=" + host)
print("PGPORT=" + str(port))
print("PGUSER=" + unquote(u.username))
print("PGPASSWORD=" + password)
print("PGDATABASE=" + (u.path.lstrip("/") or "postgres"))
print("PGSSLMODE=require")
print("PGAPPNAME=clinic-saas-backup")
' >"$tmp"
unset url

chmod 600 "$tmp"

echo 'Testando a conexao (somente leitura)...'
if ! docker run --rm --env-file "$tmp" "$IMAGE" psql -Atqc 'select 1' >/dev/null; then
  echo 'FALHOU: credencial nao gravada. Confira a senha antes de tentar de novo: tentativas repetidas podem bloquear o acesso temporariamente.' >&2
  exit 1
fi

mv -- "$tmp" "$ENV_FILE"
trap - EXIT
echo 'OK: credencial gravada e conexao validada.'
