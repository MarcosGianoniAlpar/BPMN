import type { ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { extractTextFromBuffer } from './documentLoader.js';
import {
  runPipeline,
  runRefinement,
  runMinutesFromTranscript,
  ProcessSpecValidationError,
  type PipelineResult,
  type ProgressFn,
} from './orchestrator.js';
import { minutesFilename } from './minutesMarkdown.js';
import { logApi, timed } from './log.js';
import { AiCallError } from './aiError.js';
import {
  createProjectWithVersion,
  addVersion,
  listProjects,
  getProjectDetail,
  getVersion,
  deleteProject,
  getUsageReport,
  recordAiCall,
  type AiCallKind,
} from './store.js';

/**
 * Nucleo compartilhado dos handlers HTTP. Nao le o `req` cru: recebe os dados ja
 * parseados + um `ServerResponse` (que tanto o servidor http nativo do dev local
 * quanto as funcoes Node do Vercel implementam). Assim a mesma logica de negocio
 * serve o `src/server.ts` (dev) e as funcoes `api/*` (Vercel) sem duplicacao.
 */

// ---- Respostas ----

/**
 * Decodifica o nome do arquivo vindo do header `x-filename`. O cliente usa
 * `encodeURIComponent` porque headers HTTP so aceitam ISO-8859-1 (acentos e
 * espacos quebrariam o fetch). Se nao estiver codificado, devolve como veio.
 */
export function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

/**
 * Recusa uma requisicao malformada (payload vazio, JSON invalido, tipo de
 * arquivo errado) respondendo e logando na mesma linha. Existe porque essa
 * validacao mora na BORDA — `server.ts` e cada `api/*.ts` — e nao passaria pelo
 * log do nucleo; sem isto, uma rota rejeitando tudo seria invisivel no log.
 */
export function rejectRequest(
  res: ServerResponse,
  method: string,
  route: string,
  status: number,
  error: string,
): void {
  logApi({ method, route, status, startedAt: Date.now(), detail: error });
  sendJson(res, status, { error });
}

/**
 * Tokens de uma chamada de IA, para o log. Sao eles — nao o tamanho do texto —
 * que a Anthropic cobra, entao e o numero que precisa aparecer.
 */
function tokensOf(source: { usage?: { inputTokens: number; outputTokens: number } }): string {
  const usage = source.usage;
  if (!usage) return 'tokens ?';
  return `${usage.inputTokens}+${usage.outputTokens} tokens`;
}

const STAGE_LABEL: Record<string, string> = {
  minutes: 'Estruturando a ata (IA)',
  render: 'Montando a ata em Markdown',
  extract: 'Extraindo o processo (IA)',
  validate: 'Validando ProcessSpec',
  compile: 'Compilando BPMN',
  layout: 'Aplicando layout',
  lint: 'Checando com bpmnlint',
};

/**
 * Roda uma etapa que gasta IA (geracao, revisao ou ata) transmitindo o progresso
 * como NDJSON: uma linha por etapa + linha final de resultado ou de erro.
 *
 * `toPayload` monta o que sempre vai para o cliente; `persist` grava no banco e
 * pode acrescentar campos — se falhar, o resultado ainda chega ao usuario.
 */
async function streamRun<T>(
  res: ServerResponse,
  config: AppConfig,
  title: string,
  // Rota + volume de entrada, so para o log (nunca o conteudo).
  log: { route: string; inputChars: number },
  run: (onProgress: ProgressFn) => Promise<T>,
  toPayload: (result: T) => Record<string, unknown>,
  persist?: (result: T) => Promise<Record<string, unknown>>,
  // Tipo desta chamada, para contabilizar o custo quando ela FALHA (a IA cobra
  // pelos tokens gerados mesmo quando a resposta e inutilizavel).
  kind?: AiCallKind,
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
    const payload = toPayload(result);
    write({
      type: 'result',
      ...payload,
      model: config.model,
      ...persisted,
    });
    logApi({
      method: 'POST',
      route: log.route,
      status: 'ok',
      startedAt: t0,
      detail: `entrada ${log.inputChars} chars · ${tokensOf(payload)} · modelo ${config.model}`,
    });
  } catch (err) {
    // A chamada falhou para o usuario, mas a IA cobrou pelos tokens gerados.
    // Registra o gasto antes de mais nada — best-effort, nunca mascara o erro.
    if (err instanceof AiCallError && kind) {
      try {
        await recordAiCall({
          kind,
          model: config.model,
          usage: err.usage,
          failed: true,
        });
      } catch (dbErr) {
        console.log(
          `  AVISO: falha ao registrar o custo da chamada que falhou: ` +
            `${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      }
    }

    let motivo: string;
    if (err instanceof ProcessSpecValidationError) {
      console.log(`  ERRO de validacao (${err.issues.length} problema(s)).\n`);
      write({ type: 'error', error: 'ProcessSpec invalido.', issues: err.issues });
      motivo = `ProcessSpec invalido (${err.issues.length} problema(s))`;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ERRO: ${message}\n`);
      write({ type: 'error', error: message });
      motivo = message;
    }
    logApi({
      method: 'POST',
      route: log.route,
      status: 'erro',
      startedAt: t0,
      // Falha de IA tambem custou: mostra os tokens que foram cobrados.
      detail:
        `entrada ${log.inputChars} chars` +
        (err instanceof AiCallError ? ` · ${tokensOf({ usage: err.usage })} COBRADOS` : '') +
        ` · ${motivo}`,
    });
  } finally {
    res.end();
  }
}

/** Campos que todo resultado de pipeline (geracao/revisao) devolve ao cliente. */
function pipelinePayload(result: PipelineResult): Record<string, unknown> {
  return {
    spec: result.spec,
    bpmnXml: result.layoutXml,
    layoutWarnings: result.layoutWarnings.length,
    lint: result.lint,
    usage: result.usage,
  };
}

// ---- Modo transcricao: transcricao -> ata estruturada ----

/**
 * Passo 1 do modo transcricao. Devolve a ata (JSON + Markdown) SEM gerar o
 * diagrama: o especialista revisa o texto e so entao dispara `/api/generate`
 * sobre a ata. Duas chamadas de IA, uma por requisicao — tambem por causa do
 * teto de 60s do Vercel Hobby.
 */
export async function runMinutes(
  res: ServerResponse,
  config: AppConfig,
  transcript: string,
  filename: string,
): Promise<void> {
  await streamRun(
    res,
    config,
    `Ata a partir de transcricao (${filename})`,
    { route: '/api/minutes', inputChars: transcript.length },
    (onProgress) => runMinutesFromTranscript(transcript, config, onProgress),
    (result) => ({
      minutes: result.minutes,
      markdown: result.markdown,
      suggestedFilename: minutesFilename(result.minutes, filename.replace(/\.[^.]+$/, '')),
      usage: result.usage,
    }),
    // A ata nao vira projeto (o projeto nasce quando o diagrama e gerado), mas o
    // custo precisa entrar na conta da empresa.
    async (result) => {
      await recordAiCall({
        kind: 'minutes',
        model: config.model,
        usage: result.usage,
        sourceFilename: filename,
      });
      return {};
    },
    'minutes',
  );
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
    { route: '/api/generate', inputChars: text.length },
    (onProgress) => runPipeline(text, config, onProgress),
    pipelinePayload,
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
    'generate',
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
    { route: '/api/refine', inputChars: input.text.length },
    (onProgress) =>
      runRefinement(
        input.text,
        input.spec as Parameters<typeof runRefinement>[1],
        input.answers,
        config,
        onProgress,
      ),
    pipelinePayload,
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
    'refine',
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
  const log = timed('POST', '/api/extract-text');
  const entrada = `${buffer.length} bytes`;
  try {
    const text = await extractTextFromBuffer(buffer, filename);
    if (!text.trim()) {
      log.done(422, `${entrada} · sem texto extraivel`);
      return sendJson(res, 422, {
        error: 'O documento nao contem texto extraivel (pode ser um PDF escaneado; precisaria de OCR).',
      });
    }
    log.done(200, `${entrada} -> ${text.length} chars`);
    return sendJson(res, 200, { text, filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao extrair texto do documento.';
    log.done(422, `${entrada} · ${message}`);
    return sendJson(res, 422, { error: message });
  }
}

// ---- Relatorio de uso/custo ----

export async function sendUsage(res: ServerResponse): Promise<void> {
  const log = timed('GET', '/api/usage');
  const report = await getUsageReport();
  log.done(200, `${report.totalCalls} chamada(s) · US$ ${report.totalCostUsd.toFixed(2)}`);
  sendJson(res, 200, report);
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
  const log = timed(method, '/' + segments.join('/'));

  if (method === 'GET' && segments.length === 2) {
    const projects = await listProjects();
    log.done(200, `${projects.length} projeto(s)`);
    sendJson(res, 200, { projects });
    return true;
  }

  if (method === 'GET' && segments.length === 3 && id) {
    const detail = await getProjectDetail(id);
    if (!detail) {
      log.done(404);
      sendJson(res, 404, { error: 'Projeto nao encontrado.' });
    } else {
      log.done(200, `${detail.versionCount} versao(oes)`);
      sendJson(res, 200, detail);
    }
    return true;
  }

  if (method === 'GET' && segments.length === 5 && id && segments[3] === 'versions') {
    const n = Number(segments[4]);
    const version = Number.isInteger(n) ? await getVersion(id, n) : undefined;
    if (!version) {
      log.done(404);
      sendJson(res, 404, { error: 'Versao nao encontrada.' });
    } else {
      log.done(200, `v${version.versionNumber} (${version.kind}) · ${version.bpmnXml.length} chars de BPMN`);
      sendJson(res, 200, version);
    }
    return true;
  }

  if (method === 'DELETE' && segments.length === 3 && id) {
    const ok = await deleteProject(id);
    log.done(ok ? 200 : 404);
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
  const log = timed('POST', `/api/projects/${projectId}/freeze`);
  const bpmnXml = typeof payload.bpmnXml === 'string' ? payload.bpmnXml : '';
  if (!bpmnXml.trim() || !payload.spec) {
    log.done(400, 'faltam bpmnXml ou spec');
    return sendJson(res, 400, { error: 'Faltam bpmnXml ou spec para congelar.' });
  }

  try {
    const { versionNumber } = await addVersion(projectId, {
      kind: 'frozen',
      spec: payload.spec as Parameters<typeof addVersion>[1]['spec'],
      bpmnXml,
      note: typeof payload.note === 'string' && payload.note ? payload.note : 'Edição manual congelada',
    });
    log.done(200, `v${versionNumber} congelada · ${bpmnXml.length} chars de BPMN`);
    return sendJson(res, 200, { projectId, versionNumber, kind: 'frozen' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao congelar.';
    log.done(404, message);
    return sendJson(res, 404, { error: message });
  }
}
