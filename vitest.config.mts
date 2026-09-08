import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        // Depende de banco remoto: fora do `pnpm test`, roda em `pnpm test:isolation`.
        test: {
          name: 'isolation',
          root: './supabase',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // O do cookie precisa do app Next no ar: projeto proprio, script proprio.
          // Estes dois dependem de coisas que a isolation nao exige:
          // o do cookie precisa do app Next no ar; o do atendimento
          // precisa das migrations 0012-0014 aplicadas.
          exclude: [
            'tests/clinic-hint.test.ts',
            'tests/atendimento-*.test.ts',
            'tests/agenda-mes.test.ts',
            // Pendencias (banco) tem projeto proprio (`pnpm test:tasks`); a UI
            // de Pendencias entra no projeto `hint`, que ja tem o Next no ar.
            // Sem estas duas linhas, as suites rodariam DUAS vezes: o include
            // desta secao e `tests/**`, entao todo arquivo novo entra aqui por
            // padrao.
            'tests/tasks-*.test.ts',
            'tests/confirmacoes-*.test.ts',
            'tests/pendencias-ui.test.ts',
            'tests/dashboard-pendencias.test.ts',
            'tests/pendencia-atalhos.test.ts',
          ],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
      {
        /*
         * Pendencias contra o banco REAL. Depende das quatro migrations de
         * tasks aplicadas no Dev, entao fica fora de `pnpm test` e roda em
         * `pnpm test:tasks`.
         */
        test: {
          name: 'tasks',
          root: './supabase',
          environment: 'node',
          include: ['tests/tasks-*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
      {
        /*
         * Confirmacoes contra o banco REAL. Depende das quatro migrations de
         * Confirmacoes aplicadas no Dev, entao fica fora de `pnpm test` e
         * roda em `pnpm test:confirmacoes`.
         */
        test: {
          name: 'confirmacoes',
          root: './supabase',
          environment: 'node',
          include: ['tests/confirmacoes-*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
      {
        /*
         * Seguranca do cookie de clinica. Depende do app Next no ar (WEB_URL)
         * alem do banco e da API, entao fica fora de `pnpm test:isolation` e
         * roda em `pnpm test:hint`.
         */
        test: {
          name: 'hint',
          root: './supabase',
          environment: 'node',
          include: [
            'tests/clinic-hint.test.ts',
            'tests/atendimento-ui.test.ts',
            'tests/agenda-mes.test.ts',
            'tests/pendencias-ui.test.ts',
            'tests/dashboard-pendencias.test.ts',
            'tests/pendencia-atalhos.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
      {
        /*
         * Garantias de banco do Atendimento. Depende das migrations 0012 a
         * 0014 estarem aplicadas, entao fica fora de `pnpm test:isolation`
         * enquanto o db:push nao acontecer.
         */
        test: {
          name: 'atendimento',
          root: './supabase',
          environment: 'node',
          include: ['tests/atendimento-*.test.ts'],
          exclude: ['tests/atendimento-ui.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          env: { NODE_ENV: 'test' },
          setupFiles: ['./tests/setup-env.ts'],
        },
      },
    ],
  },
})
