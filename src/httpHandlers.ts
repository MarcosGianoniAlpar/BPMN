import type { ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { extractTextFromBuffer } from './documentLoader.js';
import {
  runPipeline,
  runRefinement,
  ProcessSpecValidationError,
  type PipelineResult,
  type ProgressFn,
} from './orchestrator.js';
import {
  createProjectWithVersion,
  addVersion,
  listProjects,
  getProjectDetail,
  getVersion,
  deleteProject,
  getUsageReport,
} from './store.js';

/**
 * Nucleo compartilhado dos handlers HTTP. Nao le o `req` cru: recebe os dados ja
 * parseados + um `ServerResponse` (que tanto o servidor http nativo do dev local
 * quanto as funcoes Node do Vercel implementam). Assim a mesma logica de negocio
 * serve o `src/server.ts` (dev) e as funcoes `api/*` (Vercel) sem duplicacao.
 */

// ---- Respostas ----

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

const STAGE_LABEL: Record<string, string> = {
  extract: 'Extraindo o processo (IA)',
  validate: 'Validando ProcessSpec',
  compile: 'Compilando BPMN',
  layout: 'Aplicando layout',
  lint: 'Checando com bpmnlint',
};

/**
 * Roda uma etapa de pipeline (geracao ou revisao) transmitindo o progresso
 * como NDJSON: uma linha por etapa + linha final de resultado ou de erro.
 */
async function streamRun(
  res: ServerResponse,
  config: AppConfig,
  title: string,
  run: (onProgress: ProgressFn) => Promise<PipelineResult>,
  // Persiste o resultado e devolve campos extras (ex.: projectId) para o cliente.
  persist?: (result: PipelineResult) => Promise<Record<string, unknown>>,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
  });
  const write = (obj: unknown): void => void res.write(JSON.stringify(obj) + '\n');
  const t0 = Date.now();
  const elapsed = (): number => Number(((Date.now() - t0) / 1000).toFixed(1));

  console.log(`\n> ${title} — modelo ${config.model}`);

  try {
    const result = await run((u) => {
      const label = STAGE_LABEL[u.stage] ?? u.stage;
      if (u.status === 'start') {
        console.log(`  [${elapsed()}s] ${label}...`);
      } else {
        console.log(`  [${elapsed()}s] ${label} OK${u.detail ? ` (${u.detail})` : ''}`);
      }
      write({ type: 'progress', stage: u.stage, status: u.status, detail: u.detail, elapsed: elapsed() });
    });
    console.log(`  [${elapsed()}s] Concluido.\n`);
    // Persistencia e best-effort: se falhar, o diagrama ainda vai pro cliente.
    let persisted: Record<string, unknown> = {};
    if (persist) {
      try {
        persisted = await persist(result);
      } catch (err) {
        console.log(`  AVISO: falha ao salvar no banco: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    write({
      type: 'result',
      spec: result.spec,
      bpmnXml: result.layoutXml,
      layoutWarnings: result.layoutWarnings.length,
      lint: result.lint,
      usage: result.usage,
      model: config.model,
      ...persisted,
    });
  } catch (err) {
    if (err instanceof ProcessSpecValidationError) {
      console.log(`  ERRO de validacao (${err.issues.length} problema(s)).\n`);
      write({ type: 'error', error: 'ProcessSpec invalido.', issues: err.issues });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ERRO: ${message}\n`);
      write({ type: 'error', error: message });
    }
  } finally {
    res.end();
  }
}

// ---- Geracao ----

/** Gera o diagrama a partir do texto e persiste como projeto novo. */
export async function runGenerate(
  res: ServerResponse,
  config: AppConfig,
  text: string,
  filename: string,
): Promise<void> {
  await streamRun(
    res,
    config,
    `Geracao (${filename})`,
    (onProgress) => runPipeline(text, config, onProgress),
    async (result) => {
      const { projectId, versionNumber } = await createProjectWithVersion({
        name: result.spec.process.name || result.spec.process.id,
        sourceFilename: filename,
        sourceText: text,
        first: {
          kind: 'generated',
          spec: result.spec,
          bpmnXml: result.layoutXml,
          lint: result.lint,
          usage: result.usage,
          model: config.model,
        },
      });
      return { projectId, versionNumber };
    },
  );
}

export interface RefineInput {
  text: string;
  filename?: string;
  projectId?: string;
  spec: unknown;
  answers: { question_id: string; question: string; answer: string }[];
}

/** Revisa o ProcessSpec com as respostas e grava uma nova versao (se houver id). */
export async function runRefine(
  res: ServerResponse,
  config: AppConfig,
  input: RefineInput,
): Promise<void> {
  const answeredCount = input.answers.length;
  await streamRun(
    res,
    config,
    `Revisao (${input.filename ?? 'documento'})`,
    (onProgress) =>
      runRefinement(
        input.text,
        input.spec as Parameters<typeof runRefinement>[1],
        input.answers,
        config,
        onProgress,
      ),
    // Refinamento vira uma nova versao do projeto existente (se houver id).
    async (result) => {
      if (!input.projectId) return {};
      const { versionNumber } = await addVersion(input.projectId, {
        kind: 'refined',
        spec: result.spec,
        bpmnXml: result.layoutXml,
        lint: result.lint,
        usage: result.usage,
        model: config.model,
        note: `Revisão com ${answeredCount} resposta(s)`,
      });
      return { projectId: input.projectId, versionNumber };
    },
  );
}

// ---- Extracao de texto (upload .pdf/.docx/.txt/.md) ----

/**
 * Recebe os bytes crus de um documento ja lidos + o nome do arquivo (validado),
 * extrai o texto (parsing de PDF/DOCX no Node) e responde JSON.
 */
export async function runExtractText(
  res: ServerResponse,
  buffer: Buffer,
  filename: string,
): Promise<void> {
  try {
    const text = await extractTextFromBuffer(buffer, filename);
    if (!text.trim()) {
      return sendJson(res, 422, {
        error: 'O documento nao contem texto extraivel (pode ser um PDF escaneado; precisaria de OCR).',
      });
    }
    return sendJson(res, 200, { text, filename });
  } catch (err) {
    return sendJson(res, 422, {
      error: err instanceof Error ? err.message : 'Falha ao extrair texto do documento.',
    });
  }
}

// ---- Relatorio de uso/custo ----

export async function sendUsage(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await getUsageReport());
}

// ---- API de projetos salvos (GET/DELETE) ----

/**
 * Roteamento simples baseado em segmentos de path.
 * Rotas:
 *   GET    /api/projects                       -> lista resumida
 *   GET    /api/projects/{id}                  -> projeto + metadados das versoes
 *   GET    /api/projects/{id}/versions/{n}     -> versao completa (spec + bpmn)
 *   DELETE /api/projects/{id}                  -> apaga o projeto
 */
export async function handleProjectsApi(
  method: string,
  segments: string[],
  res: ServerResponse,
): Promise<boolean> {
  // segments = ['api','projects', ...]
  if (segments[0] !== 'api' || segments[1] !== 'projects') return false;

  const id = segments[2];

  if (method === 'GET' && segments.length === 2) {
    sendJson(res, 200, { projects: await listProjects() });
    return true;
  }

  if (method === 'GET' && segments.length === 3 && id) {
    const detail = await getProjectDetail(id);
    if (!detail) sendJson(res, 404, { error: 'Projeto nao encontrado.' });
    else sendJson(res, 200, detail);
    return true;
  }

  if (method === 'GET' && segments.length === 5 && id && segments[3] === 'versions') {
    const n = Number(segments[4]);
    const version = Number.isInteger(n) ? await getVersion(id, n) : undefined;
    if (!version) sendJson(res, 404, { error: 'Versao nao encontrada.' });
    else sendJson(res, 200, version);
    return true;
  }

  if (method === 'DELETE' && segments.length === 3 && id) {
    const ok = await deleteProject(id);
    if (!ok) sendJson(res, 404, { error: 'Projeto nao encontrado.' });
    else sendJson(res, 200, { deleted: true });
    return true;
  }

  return false;
}

// ---- Congelar versao ----

export interface FreezeInput {
  bpmnXml?: string;
  spec?: unknown;
  note?: string;
}

/**
 * Congela o estado atual do diagrama (com edicoes manuais feitas no Modeler)
 * como uma nova versao 'frozen'. Coerente com a Opcao A: a edicao livre de
 * geometria vira um snapshot que NAO sera re-layoutado ao reabrir.
 */
export async function runFreeze(
  res: ServerResponse,
  projectId: string,
  payload: FreezeInput,
): Promise<void> {
  const bpmnXml = typeof payload.bpmnXml === 'string' ? payload.bpmnXml : '';
  if (!bpmnXml.trim() || !payload.spec) {
    return sendJson(res, 400, { error: 'Faltam bpmnXml ou spec para congelar.' });
  }

  try {
    const { versionNumber } = await addVersion(projectId, {
      kind: 'frozen',
      spec: payload.spec as Parameters<typeof addVersion>[1]['spec'],
      bpmnXml,
      note: typeof payload.note === 'string' && payload.note ? payload.note : 'Edição manual congelada',
    });
    return sendJson(res, 200, { projectId, versionNumber, kind: 'frozen' });
  } catch (err) {
    return sendJson(res, 404, { error: err instanceof Error ? err.message : 'Falha ao congelar.' });
  }
}
