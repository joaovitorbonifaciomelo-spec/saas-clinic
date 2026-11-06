# Backup de Production

Dump logico diario do Supabase Production, feito na VPS. O plano Free nao garante
backup automatico, entao esta rotina e o backup da clinica.

**Estes arquivos contem dados de pacientes e hashes de senha.** Nunca os envie ao
GitHub nem a destino sem criptografia.

## Como funciona

|                |                                                                     |
| -------------- | ------------------------------------------------------------------- |
| Ferramenta     | `pg_dump` em container temporario `postgres:17.11-alpine`           |
| Formato        | custom, comprimido                                                  |
| Conteudo       | schemas `public`, `auth`, `supabase_migrations`                     |
| Horario        | todo dia, 03:00 `America/Sao_Paulo`, por `clinic-saas-backup.timer` |
| Retencao local | 7 dias, somente arquivos com o padrao exato do nome                 |
| Arquivos       | `/opt/clinic-saas-production/backups/`                              |
| Credencial     | `/opt/clinic-saas-production/backup.env`, modo 600                  |
| Registro       | `/opt/clinic-saas-production/backup.log` e `journalctl`             |

Fica de fora o schema `storage`, porque o sistema nao usa Storage hoje. Se isso
mudar, inclua-o e faca backup dos arquivos, que nao ficam no banco.

**Se o servidor mudar de major do Postgres**, atualize a imagem no script: o
`pg_dump` recusa servidor mais novo que ele, e o backup passa a falhar.

## Operacao

```bash
systemctl list-timers clinic-saas-backup.timer   # proxima execucao
tail -n 20 /opt/clinic-saas-production/backup.log
ls -lh /opt/clinic-saas-production/backups/
systemctl start clinic-saas-backup.service       # backup manual
```

Falhas ficam so no log: nada avisa ninguem. Confira o log regularmente ate existir
um alerta.

Trocou a senha do banco? Rode de novo
`/opt/clinic-saas-production/bin/clinic-saas-set-backup-credential.sh`.

## Restore

**Nunca restaure direto no Production sem decisao explicita.** O procedimento abaixo
**ainda nao foi testado**: um backup so esta provado depois de restaurado. Teste
primeiro em um projeto Supabase separado e criado para isso, e apague-o depois,
porque ele tera dados reais.

1. Crie o projeto separado, em `sa-east-1`, com Postgres 17.
2. Confira o arquivo:
   ```bash
   docker run --rm -v /opt/clinic-saas-production/backups:/backup postgres:17.11-alpine \
     pg_restore --list /backup/ARQUIVO.dump | less
   ```
3. Aplique as migrations do commit correspondente no projeto separado (`db push`),
   para ter o mesmo schema, permissoes e policies.
4. Restaure somente os dados, com triggers desligados, para nao gerar profiles e
   eventos duplicados. Use um arquivo de env com a credencial do projeto **separado**:
   ```bash
   docker run --rm --env-file /caminho/env-do-projeto-separado \
     -e PGOPTIONS='-c session_replication_role=replica' \
     -v /opt/clinic-saas-production/backups:/backup postgres:17.11-alpine \
     sh -c 'pg_restore --data-only --no-owner --schema=auth --schema=public \
       --dbname="$PGDATABASE" /backup/ARQUIVO.dump'
   ```
5. Compare as contagens com o esperado e teste login e leitura de um paciente.

As tabelas de `auth` podem ter mudado entre versoes da plataforma, e o projeto novo
tem outras chaves: sessoes abertas nao valem, e cada pessoa precisa entrar de novo.
Registre aqui o que precisou de ajuste no primeiro teste real.
