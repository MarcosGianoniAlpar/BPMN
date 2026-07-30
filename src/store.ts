import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { ProcessSpec } from './types/process-spec.js';
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
  first: NewVersionInput;
}): Promise<{ projectId: string; versionId: string; versionNumber: number }> {
  const sql = await db();
  const projectId = randomUUID();

  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO projects (id, name, source_filename, source_text)
      VALUES (${projectId}, ${input.name}, ${input.sourceFilename ?? null}, ${input.sourceText})
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
