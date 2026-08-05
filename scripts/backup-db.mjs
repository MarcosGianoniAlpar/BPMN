/**
 * Backup do banco (Supabase/Postgres) via `pg_dump`.
 *
 * Por que existe: o plano free do Supabase NAO faz backup automatico. Os
 * processos e versoes salvos pelo especialista sao o unico registro do trabalho
 * dele — um `DROP` acidental, um projeto pausado por inatividade ou o fim do
 * plano free levariam tudo junto.
 *
 * Uso:
 *   npm run backup                 # dump completo em backups/
 *   npm run backup -- --so-dados   # so os INSERTs, sem DDL
 *
 * IMPORTANTE — porta: a `DATABASE_URL` do app aponta para o pooler de TRANSACAO
 * (6543), exigido pelo serverless. O `pg_dump` nao funciona por ali (ele precisa
 * de recursos de sessao). Este script troca a porta para 5432 (pooler de SESSAO)
 * automaticamente; para apontar para outro lugar, defina `BACKUP_DATABASE_URL`.
 *
 * O arquivo gerado contem dados da empresa: guarde FORA do Supabase (e a pasta
 * backups/ esta no .gitignore de proposito).
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = resolve(RAIZ, 'backups');

function morrer(mensagem) {
  console.error(`\n✖ ${mensagem}\n`);
  process.exit(1);
}

/**
 * Conexao para o dump, em variaveis PG* em vez de argumento de linha de comando
 * — assim a senha nao aparece no `argv` do processo (visivel a qualquer um que
 * liste os processos da maquina).
 *
 * Troca a porta do pooler de transacao (6543) pela do pooler de sessao (5432):
 * o `pg_dump` nao opera na primeira.
 */
function conexaoDeBackup() {
  const bruta = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!bruta) {
    morrer(
      'DATABASE_URL nao definida. Copie .env.example para .env e preencha ' +
        '(ou defina BACKUP_DATABASE_URL para apontar direto ao banco).',
    );
  }

  let url;
  try {
    url = new URL(bruta);
  } catch {
    morrer('A URL do banco nao e valida.');
  }

  const ajustada = url.port === '6543';
  if (ajustada) url.port = '5432';

  return {
    ajustada,
    alvo: `${url.hostname}:${url.port || 5432}${url.pathname}`,
    env: {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.replace(/^\//, '') || 'postgres',
      // Supabase so aceita conexao cifrada.
      PGSSLMODE: url.searchParams.get('sslmode') ?? 'require',
    },
  };
}

/**
 * `pg_dump` esta instalado? Sem ele a mensagem tem que dizer o que fazer.
 *
 * Sem `shell: true` de proposito — `pg_dump` e um executavel de verdade (nao um
 * .cmd), entao o spawn direto acha ele no PATH tambem no Windows, e os
 * argumentos vao para o processo sem passar por interpretacao de shell.
 */
function checarPgDump() {
  return new Promise((resolvePromise) => {
    const p = spawn('pg_dump', ['--version']);
    let saida = '';
    p.stdout.on('data', (d) => (saida += d));
    p.on('error', () => resolvePromise(null));
    p.on('close', (code) => resolvePromise(code === 0 ? saida.trim() : null));
  });
}

function carimbo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

async function main() {
  const versao = await checarPgDump();
  if (!versao) {
    morrer(
      'pg_dump nao encontrado no PATH.\n' +
        '  Windows: instale o PostgreSQL (https://www.postgresql.org/download/windows/)\n' +
        '           e adicione ...\\PostgreSQL\\<versao>\\bin ao PATH.\n' +
        '  macOS:   brew install libpq && brew link --force libpq\n' +
        '  Linux:   sudo apt install postgresql-client',
    );
  }

  const { env, ajustada, alvo } = conexaoDeBackup();
  const soDados = process.argv.includes('--so-dados');

  await mkdir(PASTA, { recursive: true });
  const destino = resolve(PASTA, `bpmn-${carimbo()}${soDados ? '-dados' : ''}.sql`);

  const args = [
    // Sem dono nem ACL: o dump tem que restaurar em qualquer projeto Supabase,
    // nao so naquele de onde saiu.
    '--no-owner',
    '--no-privileges',
    // Um INSERT por linha: mais legivel e resiliente que COPY na hora do aperto.
    '--column-inserts',
    ...(soDados ? ['--data-only'] : []),
  ];

  console.log(`• ${versao}`);
  console.log(`• origem  ${alvo}`);
  if (ajustada) console.log('• porta 6543 -> 5432 (pg_dump nao opera no pooler de transacao)');
  console.log(`• destino ${destino}`);

  const arquivo = createWriteStream(destino);
  const dump = spawn('pg_dump', args, { env: { ...process.env, ...env } });

  dump.stdout.pipe(arquivo);
  let erro = '';
  dump.stderr.on('data', (d) => (erro += d));

  dump.on('close', async (code) => {
    if (code !== 0) {
      morrer(`pg_dump falhou (codigo ${code}):\n${erro.trim()}`);
    }
    const { size } = await stat(destino);
    if (size === 0) {
      morrer('o dump saiu vazio — verifique a conexao e as permissoes.');
    }
    console.log(`\n✔ backup concluido — ${(size / 1024).toFixed(1)} KB`);
    console.log('  Guarde uma copia FORA do Supabase (Drive, disco externo).');
  });
}

main().catch((e) => morrer(e.message));
