import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import type { ProcessSpec } from './types/process-spec.js';
import type { LintResult } from './lintBpmn.js';
import { estimateCost, priceLabel } from './pricing.js';

/**
 * Persistencia local em SQLite (modulo nativo do Node 22.5+, sem dependencia
 * externa). Modelo: um PROJETO por documento, com uma sequencia ordenada de
 * VERSOES. Coerente com a Opcao A da arquitetura — o ProcessSpec e a fonte da
 * verdade; cada geracao/revisao/congelamento vira uma versao nova, nunca
 * sobrescreve a anterior.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(
  __dirname,
  '..',
  process.env.BPMN_DB_PATH ?? join('data', 'bpmn.db'),
);

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DEFAULT_DB_PATH), { recursive: true });
  db = new DatabaseSync(DEFAULT_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_filename TEXT,
      source_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      process_spec TEXT NOT NULL,
      bpmn_xml TEXT NOT NULL,
      lint TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_project
      ON versions(project_id, version_number);
  `);
  migrateUsageColumns(db);
  return db;
}

/**
 * Migracao idempotente: adiciona colunas de uso (tokens + modelo) a bancos que
 * foram criados antes do relatorio de custo existir. node:sqlite nao tem
 * "ADD COLUMN IF NOT EXISTS", entao checamos o schema antes.
 */
function migrateUsageColumns(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(versions)').all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('input_tokens')) d.exec('ALTER TABLE versions ADD COLUMN input_tokens INTEGER');
  if (!have.has('output_tokens')) d.exec('ALTER TABLE versions ADD COLUMN output_tokens INTEGER');
  if (!have.has('model')) d.exec('ALTER TABLE versions ADD COLUMN model TEXT');
}

function nodeCountOf(specJson: string): number {
  try {
    const spec = JSON.parse(specJson) as ProcessSpec;
    return spec.nodes?.length ?? 0;
  } catch {
    return 0;
  }
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
export function createProjectWithVersion(input: {
  name: string;
  sourceFilename?: string | null;
  sourceText: string;
  first: NewVersionInput;
}): { projectId: string; versionId: string; versionNumber: number } {
  const d = getDb();
  const now = new Date().toISOString();
  const projectId = randomUUID();

  const tx = d.prepare('BEGIN');
  tx.run();
  try {
    d.prepare(
      `INSERT INTO projects (id, name, source_filename, source_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, input.name, input.sourceFilename ?? null, input.sourceText, now, now);

    const { versionId, versionNumber } = insertVersion(d, projectId, input.first, now);
    d.prepare('COMMIT').run();
    return { projectId, versionId, versionNumber };
  } catch (err) {
    d.prepare('ROLLBACK').run();
    throw err;
  }
}

/** Adiciona uma nova versao (refinamento ou congelamento) a um projeto existente. */
export function addVersion(
  projectId: string,
  input: NewVersionInput,
): { versionId: string; versionNumber: number } {
  const d = getDb();
  const project = d.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`Projeto nao encontrado: ${projectId}`);

  const now = new Date().toISOString();
  const tx = d.prepare('BEGIN');
  tx.run();
  try {
    const res = insertVersion(d, projectId, input, now);
    d.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    d.prepare('COMMIT').run();
    return res;
  } catch (err) {
    d.prepare('ROLLBACK').run();
    throw err;
  }
}

function insertVersion(
  d: DatabaseSync,
  projectId: string,
  input: NewVersionInput,
  now: string,
): { versionId: string; versionNumber: number } {
  const row = d
    .prepare(
      'SELECT COALESCE(MAX(version_number), 0) AS n FROM versions WHERE project_id = ?',
    )
    .get(projectId) as { n: number };
  const versionNumber = row.n + 1;
  const versionId = randomUUID();
  d.prepare(
    `INSERT INTO versions
       (id, project_id, version_number, kind, process_spec, bpmn_xml, lint, note,
        input_tokens, output_tokens, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    versionId,
    projectId,
    versionNumber,
    input.kind,
    JSON.stringify(input.spec),
    input.bpmnXml,
    input.lint ? JSON.stringify(input.lint) : null,
    input.note ?? null,
    input.usage?.inputTokens ?? null,
    input.usage?.outputTokens ?? null,
    input.model ?? null,
    now,
  );
  return { versionId, versionNumber };
}

export function listProjects(): ProjectSummary[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT p.id, p.name, p.source_filename, p.created_at, p.updated_at,
              COUNT(v.id) AS version_count,
              MAX(v.version_number) AS latest_number
       FROM projects p
       LEFT JOIN versions v ON v.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    source_filename: string | null;
    created_at: string;
    updated_at: string;
    version_count: number;
    latest_number: number | null;
  }>;

  return rows.map((r) => {
    const latest = d
      .prepare(
        `SELECT kind, process_spec FROM versions
         WHERE project_id = ? ORDER BY version_number DESC LIMIT 1`,
      )
      .get(r.id) as { kind: VersionKind; process_spec: string } | undefined;
    return {
      id: r.id,
      name: r.name,
      sourceFilename: r.source_filename,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      versionCount: r.version_count,
      latestVersionNumber: r.latest_number ?? 0,
      latestKind: latest?.kind ?? 'generated',
      nodeCount: latest ? nodeCountOf(latest.process_spec) : 0,
    };
  });
}

export function getProjectDetail(projectId: string): ProjectDetail | undefined {
  const d = getDb();
  const p = d.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | {
        id: string;
        name: string;
        source_filename: string | null;
        source_text: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!p) return undefined;

  const versions = d
    .prepare(
      `SELECT id, version_number, kind, process_spec, note, created_at
       FROM versions WHERE project_id = ? ORDER BY version_number ASC`,
    )
    .all(projectId) as Array<{
    id: string;
    version_number: number;
    kind: VersionKind;
    process_spec: string;
    note: string | null;
    created_at: string;
  }>;

  const meta: VersionMeta[] = versions.map((v) => ({
    id: v.id,
    versionNumber: v.version_number,
    kind: v.kind,
    note: v.note,
    createdAt: v.created_at,
    nodeCount: nodeCountOf(v.process_spec),
  }));

  const last = meta[meta.length - 1];
  return {
    id: p.id,
    name: p.name,
    sourceFilename: p.source_filename,
    sourceText: p.source_text,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
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
  kind: VersionKind;
  process_spec: string;
  bpmn_xml: string;
  lint: string | null;
  note: string | null;
  created_at: string;
}): VersionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    kind: row.kind,
    spec: JSON.parse(row.process_spec) as ProcessSpec,
    bpmnXml: row.bpmn_xml,
    lint: row.lint ? (JSON.parse(row.lint) as LintResult) : null,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function getVersion(
  projectId: string,
  versionNumber: number,
): VersionRecord | undefined {
  const d = getDb();
  const row = d
    .prepare('SELECT * FROM versions WHERE project_id = ? AND version_number = ?')
    .get(projectId, versionNumber) as Parameters<typeof rowToVersion>[0] | undefined;
  return row ? rowToVersion(row) : undefined;
}

export function getLatestVersion(projectId: string): VersionRecord | undefined {
  const d = getDb();
  const row = d
    .prepare(
      'SELECT * FROM versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1',
    )
    .get(projectId) as Parameters<typeof rowToVersion>[0] | undefined;
  return row ? rowToVersion(row) : undefined;
}

export function deleteProject(projectId: string): boolean {
  const d = getDb();
  const info = d.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  return info.changes > 0;
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
 * Relatorio de uso/custo: agrega tokens por modelo em todas as versoes geradas
 * por IA (as 'frozen' nao tem tokens) e estima o custo em USD. Custo e
 * ESTIMATIVA baseada em precos de lista (ver pricing.ts).
 */
export function getUsageReport(): UsageReport {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT model,
              COUNT(*)              AS calls,
              SUM(input_tokens)     AS input_tokens,
              SUM(output_tokens)    AS output_tokens
       FROM versions
       WHERE input_tokens IS NOT NULL AND model IS NOT NULL
       GROUP BY model`,
    )
    .all() as Array<{
    model: string;
    calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
  }>;

  const perModel: UsagePerModel[] = rows.map((r) => {
    const inputTokens = r.input_tokens ?? 0;
    const outputTokens = r.output_tokens ?? 0;
    const cost = estimateCost(r.model, inputTokens, outputTokens);
    return {
      model: r.model,
      label: priceLabel(r.model),
      calls: r.calls,
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
