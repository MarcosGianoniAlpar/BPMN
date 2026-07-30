import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { ProcessSpec } from './types/process-spec.js';
import type { MeetingMinutes } from './types/meeting-minutes.js';
import type { LintResult } from './lintBpmn.js';
import { estimateCost, priceLabel } from './pricing.js';

/**
 * Persistencia em PostgreSQL (Supabase). Modelo: um PROJETO por documento, com
 * uma sequencia ordenada de VERSOES. Coerente com a Opcao A da arquitetura — o
 * ProcessSpec e a fonte da verdade; cada geracao/revisao/congelamento vira uma
 * versao nova, nunca sobrescreve a anterior.
 *
 * Conexao via DATABASE_URL. Em serverless (Vercel) use a connection string do
 * *pooler* do Supabase (porta 6543, modo Transaction); por isso `prepare:false`
 * (o pooler em modo transaction nao suporta prepared statements).
 */

export type VersionKind = 'generated' | 'refined' | 'frozen';

export interface ProjectSummary {
  id: string;
  name: string;
  sourceFilename: string | null;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  latestVersionNumber: number;
  latestKind: VersionKind;
  nodeCount: number;
}

export interface VersionRecord {
  id: string;
  projectId: string;
  versionNumber: number;
  kind: VersionKind;
  spec: ProcessSpec;
  bpmnXml: string;
  lint: LintResult | null;
  note: string | null;
  createdAt: string;
}

export interface VersionMeta {
  id: string;
  versionNumber: number;
  kind: VersionKind;
  note: string | null;
  createdAt: string;
  nodeCount: number;
}

export interface ProjectDetail extends ProjectSummary {
  sourceText: string;
  versions: VersionMeta[];
}

// ---- Conexao (singleton por instancia/processo) ----

type Sql = postgres.Sql;

let sqlClient: Sql | undefined;

function getSql(): Sql {
  if (sqlClient) return sqlClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL nao definida. Copie a connection string do Supabase ' +
        '(Settings > Database > Connection pooling, porta 6543) para o .env / env do Vercel.',
    );
  }
  sqlClient = postgres(url, {
    prepare: false, // pooler transaction-mode do Supabase nao suporta prepared statements
    ssl: 'require', // Supabase exige TLS
    idle_timeout: 20,
    max: 5,
  });
  return sqlClient;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    source_filename text,
    source_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS versions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    kind text NOT NULL,
    process_spec jsonb NOT NULL,
    bpmn_xml text NOT NULL,
    lint jsonb,
    note text,
    input_tokens integer,
    output_tokens integer,
    model text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_versions_project
    ON versions(project_id, version_number);
  -- Chamadas de IA que NAO viram uma versao de projeto: a transcricao -> ata do
  -- modo transcricao, e QUALQUER chamada que falhou depois de queimar tokens
  -- (max_tokens, por exemplo). Sem elas o painel de custo subestimaria o gasto —
  -- e erraria justamente nos casos caros, que sao os que estouram o limite.
  CREATE TABLE IF NOT EXISTS ai_calls (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    source_filename text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS failed boolean NOT NULL DEFAULT false;
  -- Ata estruturada do modo transcricao. Ela e uma ENTREGA por si so (o
  -- especialista revisa, baixa e arquiva), entao precisa sobreviver a aba: antes
  -- desta tabela a ata existia so no textarea do navegador, e uma chamada de IA
  -- JA PAGA se perdia num F5. Guarda tambem a transcricao de origem, como
  -- 'projects' guarda o documento-fonte — sem ela nao da para reprocessar.
  CREATE TABLE IF NOT EXISTS minutes (
    id uuid PRIMARY KEY,
    title text NOT NULL,
    source_filename text,
    transcript text NOT NULL,
    minutes jsonb NOT NULL,
    markdown text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Procedencia: de qual ata este projeto nasceu (nulo quando veio de documento
  -- pronto). Sem esta coluna, ata e diagrama ficam como duas listas soltas e o
  -- banco nao sabe dizer que um veio do outro.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS minutes_id uuid
    REFERENCES minutes(id) ON DELETE SET NULL;
  -- Contador de chamadas de IA por janela de tempo. Vive no BANCO porque em
  -- serverless nao existe memoria compartilhada: cada invocacao da funcao e um
  -- processo novo, e um contador em variavel zeraria a cada chamada.
  -- scope e 'global' ou 'ip:<endereco>'; a PK composta faz o UPSERT ser atomico.
  CREATE TABLE IF NOT EXISTS rate_limit (
    scope text NOT NULL,
    window_start timestamptz NOT NULL,
    hits integer NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, window_start)
  );
`;

let schemaReady: Promise<void> | undefined;

/** Garante o schema uma vez por instancia (idempotente; barato). */
function ensureSchema(sql: Sql): Promise<void> {
  if (!schemaReady) schemaReady = sql.unsafe(SCHEMA_SQL).then(() => undefined);
  return schemaReady;
}

/** Handle pronto para uso: conecta e garante o schema. */
async function db(): Promise<Sql> {
  const sql = getSql();
  await ensureSchema(sql);
  return sql;
}

// ---- Helpers ----

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function nodeCountOf(spec: unknown): number {
  const nodes = (spec as ProcessSpec | null)?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

interface NewVersionInput {
  kind: VersionKind;
  spec: ProcessSpec;
  bpmnXml: string;
  lint?: LintResult | null;
  note?: string | null;
  /** Uso de tokens da chamada de IA que gerou esta versao (ausente em 'frozen'). */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Modelo usado na geracao/revisao. */
  model?: string | null;
}

/** Cria um projeto com sua primeira versao (a geracao inicial). */
export async function createProjectWithVersion(input: {
  name: string;
  sourceFilename?: string | null;
  sourceText: string;
  /** Ata de origem, quando o diagrama nasceu do modo transcricao. */
  minutesId?: string | null;
  first: NewVersionInput;
}): Promise<{ projectId: string; versionId: string; versionNumber: number }> {
  const sql = await db();
  const projectId = randomUUID();

  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO projects (id, name, source_filename, source_text, minutes_id)
      VALUES (
        ${projectId}, ${input.name}, ${input.sourceFilename ?? null},
        ${input.sourceText}, ${input.minutesId ?? null}
      )
    `;
    const { versionId, versionNumber } = await insertVersion(tx, projectId, input.first);
    return { projectId, versionId, versionNumber };
  });
}

/** Adiciona uma nova versao (refinamento ou congelamento) a um projeto existente. */
export async function addVersion(
  projectId: string,
  input: NewVersionInput,
): Promise<{ versionId: string; versionNumber: number }> {
  const sql = await db();
  const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId}`;
  if (!project) throw new Error(`Projeto nao encontrado: ${projectId}`);

  return sql.begin(async (tx) => {
    const res = await insertVersion(tx, projectId, input);
    await tx`UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;
    return res;
  });
}

async function insertVersion(
  sql: postgres.TransactionSql,
  projectId: string,
  input: NewVersionInput,
): Promise<{ versionId: string; versionNumber: number }> {
  const rows = await sql<{ n: number }[]>`
    SELECT COALESCE(MAX(version_number), 0)::int AS n
    FROM versions WHERE project_id = ${projectId}
  `;
  const versionNumber = Number(rows[0]?.n ?? 0) + 1;
  const versionId = randomUUID();
  const specJson = input.spec as unknown as postgres.JSONValue;
  const lintJson = input.lint ? (input.lint as unknown as postgres.JSONValue) : null;
  await sql`
    INSERT INTO versions
      (id, project_id, version_number, kind, process_spec, bpmn_xml, lint, note,
       input_tokens, output_tokens, model)
    VALUES (
      ${versionId}, ${projectId}, ${versionNumber}, ${input.kind},
      ${sql.json(specJson)}, ${input.bpmnXml},
      ${lintJson === null ? null : sql.json(lintJson)}, ${input.note ?? null},
      ${input.usage?.inputTokens ?? null}, ${input.usage?.outputTokens ?? null},
      ${input.model ?? null}
    )
  `;
  return { versionId, versionNumber };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const sql = await db();
  const rows = await sql`
    SELECT p.id, p.name, p.source_filename, p.created_at, p.updated_at,
           COUNT(v.id)::int          AS version_count,
           MAX(v.version_number)::int AS latest_number
    FROM projects p
    LEFT JOIN versions v ON v.project_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `;

  const summaries: ProjectSummary[] = [];
  for (const r of rows) {
    const [latest] = await sql`
      SELECT kind, process_spec FROM versions
      WHERE project_id = ${r.id} ORDER BY version_number DESC LIMIT 1
    `;
    summaries.push({
      id: r.id,
      name: r.name,
      sourceFilename: r.source_filename,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      versionCount: Number(r.version_count),
      latestVersionNumber: r.latest_number ?? 0,
      latestKind: (latest?.kind as VersionKind) ?? 'generated',
      nodeCount: latest ? nodeCountOf(latest.process_spec) : 0,
    });
  }
  return summaries;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail | undefined> {
  const sql = await db();
  const [p] = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
  if (!p) return undefined;

  const versions = await sql`
    SELECT id, version_number, kind, process_spec, note, created_at
    FROM versions WHERE project_id = ${projectId} ORDER BY version_number ASC
  `;

  const meta: VersionMeta[] = versions.map((v) => ({
    id: v.id,
    versionNumber: v.version_number,
    kind: v.kind as VersionKind,
    note: v.note,
    createdAt: toIso(v.created_at),
    nodeCount: nodeCountOf(v.process_spec),
  }));

  const last = meta[meta.length - 1];
  return {
    id: p.id,
    name: p.name,
    sourceFilename: p.source_filename,
    sourceText: p.source_text,
    createdAt: toIso(p.created_at),
    updatedAt: toIso(p.updated_at),
    versionCount: meta.length,
    latestVersionNumber: last?.versionNumber ?? 0,
    latestKind: last?.kind ?? 'generated',
    nodeCount: last?.nodeCount ?? 0,
    versions: meta,
  };
}

function rowToVersion(row: {
  id: string;
  project_id: string;
  version_number: number;
  kind: string;
  process_spec: unknown;
  bpmn_xml: string;
  lint: unknown;
  note: string | null;
  created_at: unknown;
}): VersionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    kind: row.kind as VersionKind,
    spec: row.process_spec as ProcessSpec,
    bpmnXml: row.bpmn_xml,
    lint: (row.lint as LintResult | null) ?? null,
    note: row.note,
    createdAt: toIso(row.created_at),
  };
}

export async function getVersion(
  projectId: string,
  versionNumber: number,
): Promise<VersionRecord | undefined> {
  const sql = await db();
  const [row] = await sql`
    SELECT * FROM versions
    WHERE project_id = ${projectId} AND version_number = ${versionNumber}
  `;
  return row ? rowToVersion(row as Parameters<typeof rowToVersion>[0]) : undefined;
}

export async function getLatestVersion(projectId: string): Promise<VersionRecord | undefined> {
  const sql = await db();
  const [row] = await sql`
    SELECT * FROM versions WHERE project_id = ${projectId}
    ORDER BY version_number DESC LIMIT 1
  `;
  return row ? rowToVersion(row as Parameters<typeof rowToVersion>[0]) : undefined;
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const sql = await db();
  const result = await sql`DELETE FROM projects WHERE id = ${projectId}`;
  return result.count > 0;
}

// ---- Atas (modo transcricao) ----

export interface MinutesSummary {
  id: string;
  title: string;
  sourceFilename: string | null;
  createdAt: string;
  updatedAt: string;
  /** Etapas do fluxo detectado — indica se a ata tem material para virar diagrama. */
  stepCount: number;
  /** Quantos diagramas ja nasceram desta ata. */
  projectCount: number;
}

export interface MinutesRecord extends MinutesSummary {
  minutes: MeetingMinutes;
  markdown: string;
  transcript: string;
}

/** Salva a ata recem-gerada. Devolve o id para o cliente reabrir/editar depois. */
export async function saveMinutes(input: {
  title: string;
  sourceFilename?: string | null;
  transcript: string;
  minutes: MeetingMinutes;
  markdown: string;
}): Promise<{ minutesId: string }> {
  const sql = await db();
  const minutesId = randomUUID();
  const json = input.minutes as unknown as postgres.JSONValue;
  await sql`
    INSERT INTO minutes (id, title, source_filename, transcript, minutes, markdown)
    VALUES (
      ${minutesId}, ${input.title}, ${input.sourceFilename ?? null},
      ${input.transcript}, ${sql.json(json)}, ${input.markdown}
    )
  `;
  return { minutesId };
}

export async function listMinutes(): Promise<MinutesSummary[]> {
  const sql = await db();
  const rows = await sql`
    SELECT m.id, m.title, m.source_filename, m.created_at, m.updated_at,
           COALESCE(jsonb_array_length(m.minutes #> '{process_flow,steps}'), 0)::int AS step_count,
           COUNT(p.id)::int AS project_count
    FROM minutes m
    LEFT JOIN projects p ON p.minutes_id = m.id
    GROUP BY m.id
    ORDER BY m.updated_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sourceFilename: r.source_filename,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    stepCount: Number(r.step_count),
    projectCount: Number(r.project_count),
  }));
}

export async function getMinutesDoc(id: string): Promise<MinutesRecord | undefined> {
  const sql = await db();
  const [r] = await sql`
    SELECT m.id, m.title, m.source_filename, m.transcript, m.minutes, m.markdown,
           m.created_at, m.updated_at,
           COALESCE(jsonb_array_length(m.minutes #> '{process_flow,steps}'), 0)::int AS step_count,
           (SELECT COUNT(*)::int FROM projects p WHERE p.minutes_id = m.id) AS project_count
    FROM minutes m WHERE m.id = ${id}
  `;
  if (!r) return undefined;
  return {
    id: r.id,
    title: r.title,
    sourceFilename: r.source_filename,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    stepCount: Number(r.step_count),
    projectCount: Number(r.project_count),
    minutes: r.minutes as MeetingMinutes,
    markdown: r.markdown,
    transcript: r.transcript,
  };
}

/**
 * Grava as correcoes do especialista no texto da ata. Só o Markdown muda: o JSON
 * estruturado continua sendo o que a IA devolveu, e é o Markdown — o texto
 * revisado — que vira o diagrama e o arquivo baixado.
 */
export async function updateMinutesMarkdown(
  id: string,
  markdown: string,
): Promise<boolean> {
  const sql = await db();
  const result = await sql`
    UPDATE minutes SET markdown = ${markdown}, updated_at = now() WHERE id = ${id}
  `;
  return result.count > 0;
}

export async function deleteMinutesDoc(id: string): Promise<boolean> {
  const sql = await db();
  const result = await sql`DELETE FROM minutes WHERE id = ${id}`;
  return result.count > 0;
}

// ---- Limite de chamadas de IA ----

export interface RateVerdict {
  allowed: boolean;
  /** Qual teto barrou (so quando `allowed` e false). */
  scope?: 'ip' | 'global';
  limit?: number;
  hits?: number;
  /** Segundos ate a janela virar, para o cabecalho Retry-After. */
  retryAfterSeconds?: number;
}

const HOUR_S = 3600;
const DAY_S = 86400;

/** Soma 1 na janela atual do escopo e devolve o total ja contando esta chamada. */
async function bump(
  sql: Sql,
  scope: string,
  unidade: 'hour' | 'day',
): Promise<{ hits: number; windowStart: Date }> {
  const [row] = await sql<{ hits: number; window_start: Date }[]>`
    INSERT INTO rate_limit (scope, window_start, hits)
    VALUES (${scope}, date_trunc(${unidade}, now()), 1)
    ON CONFLICT (scope, window_start) DO UPDATE SET hits = rate_limit.hits + 1
    RETURNING hits, window_start
  `;
  return { hits: Number(row?.hits ?? 1), windowStart: new Date(row?.window_start ?? Date.now()) };
}

function faltamSegundos(windowStart: Date, duracao: number): number {
  const fim = windowStart.getTime() + duracao * 1000;
  return Math.max(1, Math.ceil((fim - Date.now()) / 1000));
}

/**
 * Reserva uma chamada de IA para este visitante, ou nega se estourou o teto.
 *
 * Conta ANTES da chamada, de proposito: a IA cobra pelos tokens gerados mesmo
 * quando o resultado e inutilizavel, entao reservar so depois do sucesso
 * deixaria justamente as falhas (as caras) fora da conta.
 *
 * A ordem importa: o teto por IP e checado primeiro e so entao o global e
 * incrementado. Se fosse o contrario, alguem martelando a rota com um IP ja
 * bloqueado consumiria o teto do dia e derrubaria a app para todo mundo.
 */
export async function reserveAiCall(
  ip: string,
  limits: { perIpPerHour: number; globalPerDay: number },
): Promise<RateVerdict> {
  const sql = await db();

  if (limits.perIpPerHour > 0) {
    const { hits, windowStart } = await bump(sql, `ip:${ip}`, 'hour');
    if (hits > limits.perIpPerHour) {
      return {
        allowed: false,
        scope: 'ip',
        limit: limits.perIpPerHour,
        hits,
        retryAfterSeconds: faltamSegundos(windowStart, HOUR_S),
      };
    }
  }

  if (limits.globalPerDay > 0) {
    const { hits, windowStart } = await bump(sql, 'global', 'day');
    if (hits > limits.globalPerDay) {
      return {
        allowed: false,
        scope: 'global',
        limit: limits.globalPerDay,
        hits,
        retryAfterSeconds: faltamSegundos(windowStart, DAY_S),
      };
    }
  }

  // Janelas velhas nao servem para nada; a limpeza e uma linha e a tabela e
  // minuscula perto do custo de uma chamada de IA.
  await sql`DELETE FROM rate_limit WHERE window_start < now() - interval '2 days'`;

  return { allowed: true };
}

/** Tipos de chamada de IA avulsa (sem versao associada). */
export type AiCallKind = 'minutes' | 'generate' | 'refine';

/**
 * Registra uma chamada de IA que nao gera versao de projeto, para que ela
 * apareca no relatorio de uso/custo. A key e da empresa: nenhuma chamada pode
 * ficar fora da conta — inclusive as que FALHARAM depois de gastar tokens
 * (`failed: true`), que sao cobradas do mesmo jeito.
 */
export async function recordAiCall(input: {
  kind: AiCallKind;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  sourceFilename?: string | null;
  failed?: boolean;
}): Promise<void> {
  const sql = await db();
  await sql`
    INSERT INTO ai_calls (id, kind, model, input_tokens, output_tokens, source_filename, failed)
    VALUES (
      ${randomUUID()}, ${input.kind}, ${input.model},
      ${input.usage.inputTokens}, ${input.usage.outputTokens},
      ${input.sourceFilename ?? null}, ${input.failed ?? false}
    )
  `;
}

export interface UsagePerModel {
  model: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costKnown: boolean;
}

export interface UsageReport {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** true se todos os modelos usados tem preco conhecido. */
  costComplete: boolean;
  perModel: UsagePerModel[];
}

/**
 * Relatorio de uso/custo: agrega tokens por modelo em TODAS as chamadas de IA —
 * as versoes geradas/revisadas (as 'frozen' nao tem tokens) mais as chamadas
 * avulsas de `ai_calls` (ex.: transcricao -> ata). Custo e ESTIMATIVA baseada em
 * precos de lista (ver pricing.ts).
 */
export async function getUsageReport(): Promise<UsageReport> {
  const sql = await db();
  const rows = await sql`
    WITH todas AS (
      SELECT model, input_tokens, output_tokens
      FROM versions
      WHERE input_tokens IS NOT NULL AND model IS NOT NULL
      UNION ALL
      SELECT model, input_tokens, output_tokens FROM ai_calls
    )
    SELECT model,
           COUNT(*)::int                           AS calls,
           COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
    FROM todas
    GROUP BY model
  `;

  const perModel: UsagePerModel[] = rows.map((r) => {
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    const cost = estimateCost(r.model, inputTokens, outputTokens);
    return {
      model: r.model,
      label: priceLabel(r.model),
      calls: Number(r.calls),
      inputTokens,
      outputTokens,
      costUsd: cost.totalCost,
      costKnown: cost.known,
    };
  });
  perModel.sort((a, b) => b.costUsd - a.costUsd);

  return {
    totalCalls: perModel.reduce((s, m) => s + m.calls, 0),
    totalInputTokens: perModel.reduce((s, m) => s + m.inputTokens, 0),
    totalOutputTokens: perModel.reduce((s, m) => s + m.outputTokens, 0),
    totalCostUsd: perModel.reduce((s, m) => s + m.costUsd, 0),
    costComplete: perModel.every((m) => m.costKnown),
    perModel,
  };
}
