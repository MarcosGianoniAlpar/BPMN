import type { AppConfig } from './config.js';
import type { ProcessSpec } from './types/process-spec.js';
import { extractProcessSpec } from './extractProcessSpec.js';
import { refineProcessSpec, type ClarificationAnswer } from './refineProcessSpec.js';
import { validateProcessSpec, type ValidationIssue } from './validate.js';
import { compileToBpmn } from './compiler.js';
import { applyLayout } from './layout.js';
import { compileAndLayoutWithLanes } from './laneLayout.js';
import { lintBpmn, type LintResult } from './lintBpmn.js';

export class ProcessSpecValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      `ProcessSpec invalido (${issues.length} problema(s)):\n` +
        issues.map((i) => `  - [${i.code}] ${i.message}`).join('\n'),
    );
    this.name = 'ProcessSpecValidationError';
  }
}

export interface PipelineResult {
  spec: ProcessSpec;
  semanticXml: string;
  layoutXml: string;
  layoutWarnings: unknown[];
  lint: LintResult;
  usage: { inputTokens: number; outputTokens: number };
}

export type PipelineStage = 'extract' | 'validate' | 'compile' | 'layout' | 'lint';

export interface ProgressUpdate {
  stage: PipelineStage;
  status: 'start' | 'done';
  detail?: string;
}

export type ProgressFn = (update: ProgressUpdate) => void;

type Usage = { inputTokens: number; outputTokens: number };

/**
 * Parte deterministica compartilhada: valida o ProcessSpec (venha da extracao
 * ou da revisao), compila para BPMN e aplica o layout. Nenhuma IA aqui.
 */
async function buildDiagram(
  raw: unknown,
  usage: Usage,
  onProgress: ProgressFn,
): Promise<PipelineResult> {
  // Validacao (schema + semantica) ANTES de gerar qualquer XML
  onProgress({ stage: 'validate', status: 'start' });
  const validation = validateProcessSpec(raw);
  if (!validation.valid) {
    throw new ProcessSpecValidationError(validation.errors);
  }
  const spec = raw as ProcessSpec;
  onProgress({
    stage: 'validate',
    status: 'done',
    detail: `${spec.nodes.length} nós, ${spec.flows.length} fluxos (saída da IA)`,
  });

  // Duas rotas: com raias, geramos geometria ciente de lanes/pools (o
  // bpmn-auto-layout nao desenha faixas); sem raias, seguimos o caminho
  // provado compiler + bpmn-auto-layout.
  const hasLanes = (spec.lanes?.length ?? 0) > 0;

  onProgress({ stage: 'compile', status: 'start' });
  const semanticXml = await compileToBpmn(spec);
  onProgress({
    stage: 'compile',
    status: 'done',
    detail: `${spec.nodes.length + spec.flows.length} elementos BPMN gerados por código`,
  });

  onProgress({ stage: 'layout', status: 'start' });
  let layoutXml: string;
  const layoutWarnings: unknown[] = [];
  if (hasLanes) {
    layoutXml = await compileAndLayoutWithLanes(spec);
  } else {
    layoutXml = await applyLayout(semanticXml).then((r) => r.xml);
  }
  const shapes = (layoutXml.match(/<bpmndi:BPMNShape/g) ?? []).length;
  const edges = (layoutXml.match(/<bpmndi:BPMNEdge/g) ?? []).length;
  onProgress({
    stage: 'layout',
    status: 'done',
    detail:
      `${shapes} formas + ${edges} conexões posicionadas por código` +
      (hasLanes ? ` (com ${spec.lanes!.length} raia(s))` : ''),
  });

  // Nivel 2: bpmnlint sobre o BPMN final (diagnostico, nao bloqueia).
  onProgress({ stage: 'lint', status: 'start' });
  const lint = await lintBpmn(layoutXml);
  onProgress({
    stage: 'lint',
    status: 'done',
    detail:
      lint.issues.length === 0
        ? 'sem avisos do bpmnlint'
        : `${lint.errors} erro(s), ${lint.warnings} aviso(s)`,
  });

  return { spec, semanticXml, layoutXml, layoutWarnings, lint, usage };
}

/**
 * Pipeline da Fase 1: texto -> extracao (IA) -> validacao -> compilacao -> layout.
 */
export async function runPipeline(
  documentText: string,
  config: AppConfig,
  onProgress: ProgressFn = () => {},
): Promise<PipelineResult> {
  onProgress({ stage: 'extract', status: 'start' });
  const { raw, usage } = await extractProcessSpec(documentText, config);
  onProgress({
    stage: 'extract',
    status: 'done',
    detail: `${usage.inputTokens}+${usage.outputTokens} tokens`,
  });
  return buildDiagram(raw, usage, onProgress);
}

/**
 * Loop de esclarecimento: recebe respostas do especialista, pede a IA um
 * ProcessSpec revisado e recompila o diagrama ja com os caminhos resolvidos.
 */
export async function runRefinement(
  documentText: string,
  currentSpec: ProcessSpec,
  answers: ClarificationAnswer[],
  config: AppConfig,
  onProgress: ProgressFn = () => {},
): Promise<PipelineResult> {
  onProgress({ stage: 'extract', status: 'start' });
  const { raw, usage } = await refineProcessSpec(documentText, currentSpec, answers, config);
  onProgress({
    stage: 'extract',
    status: 'done',
    detail: `${usage.inputTokens}+${usage.outputTokens} tokens (revisão com ${answers.length} resposta(s))`,
  });
  return buildDiagram(raw, usage, onProgress);
}
