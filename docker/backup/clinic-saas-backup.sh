#!/usr/bin/env bash
# =============================================================================
# Backup logico diario do Supabase Production do Clinic SaaS.
#
# Roda pg_dump num container temporario, para nao instalar nada no host e nao
# depender do Postgres de nenhum outro projeto da VPS. O arquivo final so existe
# se o dump terminou e foi lido de volta pelo pg_restore. A retencao so roda
# depois disso: um backup com falha nunca apaga um backup bom.
#
# A credencial fica em backup.env (modo 600) e chega ao pg_dump pelo ambiente do
# container, nunca por argumento de linha de comando.
# =============================================================================
set -Eeuo pipefail
umask 077

readonly BASE=/opt/clinic-saas-production
readonly DIR="$BASE/backups"
readonly ENV_FILE="$BASE/backup.env"
readonly LOG="$BASE/backup.log"
readonly LOCK="$BASE/.backup.lock"
# Precisa ser da mesma major do servidor ou mais nova, ou o pg_dump se recusa a rodar.
readonly IMAGE=postgres:17.11-alpine
readonly CONTAINER=clinic-saas-backup-run
readonly RETENTION_MINUTES=$((7 * 24 * 60))

log() {
  local line
  line="$(TZ=America/Sao_Paulo date '+%Y-%m-%d %H:%M:%S %z') $*"
  echo "$line"
  echo "$line" >>"$LOG"
}

tmp=""
on_exit() {
  local status=$?
  [ -n "$tmp" ] && rm -f -- "$tmp"
  if [ "$status" -ne 0 ]; then
    log "FALHA exit=$status"
  fi
}
trap on_exit EXIT

[ -f "$ENV_FILE" ] || { log "backup.env ausente"; exit 2; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || { log "backup.env precisa de modo 600"; exit 2; }
[ -d "$DIR" ] || { log "diretorio de backups ausente"; exit 2; }

exec 9>"$LOCK"
flock -n 9 || { log "outro backup em andamento"; exit 3; }

stamp="$(TZ=America/Sao_Paulo date +%Y-%m-%d_%H-%M)"
name="clinic-saas-production-$stamp.dump"
final="$DIR/$name"
tmp="$DIR/.$name.tmp"

[ -e "$final" ] && { log "ja existe $name"; exit 4; }

run() {
  docker run --rm --name "$CONTAINER" \
    --memory 256m --cpus 0.5 --cpu-shares 256 \
    --env-file "$ENV_FILE" \
    -v "$DIR:/backup" \
    "$IMAGE" "$@"
}

log "inicio $name"

# public: dados da clinica. auth: contas e hashes de senha.
# supabase_migrations: qual versao do schema este dump representa.
run pg_dump --format=custom --compress=6 \
  --schema=public --schema=auth --schema=supabase_migrations \
  --file="/backup/.$name.tmp"

[ -s "$tmp" ] || { log "dump vazio"; exit 5; }

# Le o arquivo de volta e confere que as tabelas essenciais estao nele.
toc="$(run pg_restore --list "/backup/.$name.tmp")"
for table in 'public patients' 'public appointments' 'public clinics' 'public clinic_members' 'auth users' 'auth identities'; do
  grep -q "TABLE DATA $table " <<<"$toc" || { log "dump sem dados de: $table"; exit 6; }
done

chmod 600 "$tmp"
mv -- "$tmp" "$final"
tmp=""

size="$(stat -c %s "$final")"
log "SUCESSO $name bytes=$size"

# Retencao: somente este diretorio, somente este padrao exato de nome.
find "$DIR" -maxdepth 1 -type f -regextype posix-extended \
  -regex '.*/clinic-saas-production-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\.dump' \
  -mmin "+$RETENTION_MINUTES" -print -delete | while IFS= read -r removed; do
  log "retencao removeu $(basename "$removed")"
done
