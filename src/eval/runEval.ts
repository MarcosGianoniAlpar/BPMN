#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { loadDocumentText, SUPPORTED_EXTENSIONS } from '../documentLoader.js';
import { runPipeline, ProcessSpecValidationError } from '../orchestrator.js';
import { validateProcessSpec } from '../validate.js';
import type { ProcessSpec } from '../types/process-spec.js';
import { compareSpecs, type SpecComparison } from './compareSpecs.js';

/**
 * Runner de avaliacao. Para cada gabarito em evaluations/expected/, encontra o
 * documento de origem em test-documents/, gera a predicao (via pipeline/IA ou,
 * com --cached, a partir de output/) e compara com o gabarito.
 *
 * Uso:
 *   npm run eval                 # roda a IA sobre cada doc e compara
 *   npm run eval -- --cached     # compara output/*.process-spec.json ja gerados (sem gastar IA)
 */

const ROOT = resolve(process.cwd());
const EXPECTED_DIR = join(ROOT, 'evaluations', 'expected');
const DOCS_DIR = join(ROOT, 'test-documents');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORT_DIR = join(ROOT, 'evaluations', 'reports');

interface DocCase {
  stem: string;
  goldenPath: string;
  docPath?: string;
}

interface CaseResult {
  stem: string;
  ok: boolean;
  error?: string;
  comparison?: SpecComparison;
  lint?: { errors: number; warnings: number };
}

async function findDocument(stem: string): Promise<string | undefined> {
  for (const ext of SUPPORTED_EXTENSIONS) {
    const p = join(DOCS_DIR, stem + ext);
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function discoverCases(): Promise<DocCase[]> {
  if (!existsSync(EXPECTED_DIR)) return [];
  const files = await readdir(EXPECTED_DIR);
  const cases: DocCase[] = [];
  for (const f of files) {
    if (!f.endsWith('.process-spec.json')) continue;
    const stem = basename(f, '.process-spec.json');
    cases.push({
      stem,
      goldenPath: join(EXPECTED_DIR, f),
      docPath: await findDocument(stem),
    });
  }
  return cases;
}

async function readSpec(path: string, label: string): Promise<ProcessSpec> {
  const raw = JSON.parse(await readFile(path, 'utf-8'));
  const validation = validateProcessSpec(raw);
  if (!validation.valid) {
    throw new Error(
      `${label} invalido (${path}): ` + validation.errors.map((e) => e.message).join('; '),
    );
  }
  return raw as ProcessSpec;
}

async function predictCached(stem: string): Promise<ProcessSpec> {
  const p = join(OUTPUT_DIR, `${stem}.process-spec.json`);
  if (!existsSync(p)) {
    throw new Error(`Sem predicao em cache (${p}). Rode sem --cached ou gere a saida antes.`);
  }
  return readSpec(p, 'Predicao (cache)');
}

async function runCase(c: DocCase, cached: boolean): Promise<CaseResult> {
  try {
    const expected = await readSpec(c.goldenPath, 'Gabarito');

    let predicted: ProcessSpec;
    let lint: { errors: number; warnings: number } | undefined;

    if (cached) {
      predicted = await predictCached(c.stem);
    } else {
      if (!c.docPath) {
        throw new Error(`Documento de origem nao encontrado em test-documents/ para "${c.stem}".`);
      }
      const config = loadConfig();
      const text = await loadDocumentText(c.docPath);
      const result = await runPipeline(text, config);
      predicted = result.spec;
      lint = { errors: result.lint.errors, warnings: result.lint.warnings };
    }

    return { stem: c.stem, ok: true, comparison: compareSpecs(predicted, expected), lint };
  } catch (err) {
    const message =
      err instanceof ProcessSpecValidationError
        ? `ProcessSpec invalido: ${err.issues.map((i) => i.message).join('; ')}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { stem: c.stem, ok: false, error: message };
  }
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

function printReport(results: CaseResult[], cached: boolean): void {
  console.log(`\n=== Avaliacao (${cached ? 'cache' : 'IA'}) — ${results.length} caso(s) ===\n`);

  for (const r of results) {
    if (!r.ok || !r.comparison) {
      console.log(`✗ ${r.stem}: ${r.error}`);
      continue;
    }
    const c = r.comparison;
    console.log(`• ${r.stem}  —  score ${pct(c.score)}`);
    console.log(
      `    nós:    ${c.nodes.matched}/${c.nodes.expected} casados` +
        `  (P ${pct(c.nodes.precision)} · R ${pct(c.nodes.recall)} · F1 ${pct(c.nodes.f1)})`,
    );
    console.log(
      `    fluxos: ${c.flows.matched}/${c.flows.expected} casados` +
        `  (P ${pct(c.flows.precision)} · R ${pct(c.flows.recall)} · F1 ${pct(c.flows.f1)})`,
    );
    console.log(
      `    perguntas: ${c.questions.predicted} previstas vs ${c.questions.expected} esperadas`,
    );
    if (r.lint) console.log(`    bpmnlint: ${r.lint.errors} erro(s), ${r.lint.warnings} aviso(s)`);
    if (c.missed.length) {
      console.log(`    faltou (${c.missed.length}): ${c.missed.map((m) => `${m.name} [${m.type}]`).join(', ')}`);
    }
    if (c.extra.length) {
      console.log(`    sobrou (${c.extra.length}): ${c.extra.map((m) => `${m.name} [${m.type}]`).join(', ')}`);
    }
    console.log('');
  }

  const scored = results.filter((r) => r.ok && r.comparison);
  if (scored.length) {
    const avg = scored.reduce((s, r) => s + r.comparison!.score, 0) / scored.length;
    const failed = results.length - scored.length;
    console.log(`Média de score: ${pct(avg)}  (${scored.length} avaliados, ${failed} falha(s))`);
  } else {
    console.log('Nenhum caso avaliado com sucesso.');
  }
}

async function main(): Promise<void> {
  const cached = process.argv.includes('--cached');
  const cases = await discoverCases();

  if (cases.length === 0) {
    console.log(
      'Nenhum gabarito encontrado em evaluations/expected/.\n' +
        'Crie <nome>.process-spec.json la (revisado a mao) e um test-documents/<nome>.(md|txt|pdf|docx).',
    );
    return;
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    if (!cached) console.log(`> Avaliando "${c.stem}" (chamando a IA)...`);
    results.push(await runCase(c, cached));
  }

  printReport(results, cached);

  // Persiste um relatorio versionavel para acompanhar a evolucao ao longo do tempo.
  await mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const config = cached ? { mode: 'cached' } : { mode: 'llm', model: loadConfig().model };
  const reportPath = join(REPORT_DIR, `eval-${stamp}.json`);
  await writeFile(
    reportPath,
    JSON.stringify({ timestamp: new Date().toISOString(), ...config, results }, null, 2),
    'utf-8',
  );
  console.log(`\nRelatório salvo em ${reportPath}`);
}

main().catch((err: unknown) => {
  console.error(`\nErro no runner de avaliacao: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
