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
import { estimateCost } from './pricing.js';
import {
  createProjectWithVersion,
  addVersion,
  listProjects,
  getProjectDetail,
  getVersion,
  deleteProject,
  getUsageReport,
  recordAiCall,
  reserveAiCall,
  saveMinutes,
  listMinutes,
  getMinutesDoc,
  updateMinutesMarkdown,
  deleteMinutesDoc,
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

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Custo estimado desta chamada, para o cliente mostrar junto do resultado.
 *
 * Calculado AQUI e nao no frontend de proposito: a tabela de precos e uma so
 * (`pricing.ts`), e duplica-la em JS garantiria que uma das duas ficasse velha.
 * `costUsd` fica ausente (nao zero) quando o modelo nao esta na tabela — zero
 * pareceria "de graca", que e a leitura errada quando a key e da empresa.
 */
function costOf(model: string, usage: unknown): { costUsd?: number } {
  if (!usage) return {};
  const { inputTokens, outputTokens } = usage as TokenUsage;
  const cost = estimateCost(model, inputTokens, outputTokens);
  return cost.known ? { costUsd: cost.totalCost } : {};
}

/** Custo em USD para o log do servidor (4 casas: uma chamada custa centavos). */
function usdOf(cost: { costUsd?: number }): string {
  return cost.costUsd === undefined ? 'custo ?' : `US$ ${cost.costUsd.toFixed(4)}`;
}

/**
 * IP do visitante. Atras do proxy da Vercel o socket e sempre o da propria
 * infraestrutura, entao o endereco real vem no `x-forwarded-for` (o primeiro da
 * lista e o cliente; os seguintes sao proxies).
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress?: string,
): string {
  const xff = headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const primeiro = raw?.split(',')[0]?.trim();
  return primeiro || socketAddress || 'desconhecido';
}

/**
 * Barra a chamada se o teto de uso ja foi atingido. Responde 429 e devolve
 * false; quem chama so precisa parar.
 *
 * Falha FECHADA: se o contador (banco) estiver fora do ar, a chamada e negada.
 * Um limite que evapora justamente quando nao da para contar nao limita nada — e
 * o proposito aqui e nao deixar a verba da empresa exposta. Para desligar o
 * limite de proposito, use RATE_LIMIT_PER_IP_HOUR=0 e RATE_LIMIT_GLOBAL_PER_DAY=0.
 */
async function allowAiCall(
  res: ServerResponse,
  config: AppConfig,
  route: string,
  ip: string,
): Promise<boolean> {
  const semLimite = config.rateLimit.perIpPerHour <= 0 && config.rateLimit.globalPerDay <= 0;
  if (semLimite) return true;

  let verdict;
  try {
    verdict = await reserveAiCall(ip, config.rateLimit);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    logApi({ method: 'POST', route, status: 503, startedAt: Date.now(), detail: `contador indisponivel: ${motivo}` });
    sendJson(res, 503, {
      error:
        'Não consegui verificar o limite de uso agora (banco indisponível), ' +
        'então a chamada foi bloqueada por precaução. Tente de novo em instantes.',
    });
    return false;
  }

  if (verdict.allowed) return true;

  const minutos = Math.ceil((verdict.retryAfterSeconds ?? 60) / 60);
  const mensagem =
    verdict.scope === 'ip'
      ? `Você atingiu o limite de ${verdict.limit} gerações por hora. ` +
        `Tente de novo em ~${minutos} min.`
      : `A aplicação atingiu o limite de ${verdict.limit} chamadas de IA no dia ` +
        `(teto de custo da empresa). Volta a liberar em ~${Math.ceil(minutos / 60)} h.`;

  logApi({
    method: 'POST',
    route,
    status: 429,
    startedAt: Date.now(),
    detail: `limite ${verdict.scope} atingido: ${verdict.hits}/${verdict.limit} · ip ${ip}`,
  });
  res.setHeader('retry-after', String(verdict.retryAfterSeconds ?? 60));
  sendJson(res, 429, { error: mensagem });
  return false;
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
  // Rota + volume de entrada (so para o log, nunca o conteudo) + IP, para o teto de uso.
  log: { route: string; inputChars: number; ip: string },
  run: (onProgress: ProgressFn) => Promise<T>,
  toPayload: (result: T) => Record<string, unknown>,
  persist?: (result: T) => Promise<Record<string, unknown>>,
  // Tipo desta chamada, para contabilizar o custo quando ela FALHA (a IA cobra
  // pelos tokens gerados mesmo quando a resposta e inutilizavel).
  kind?: AiCallKind,
): Promise<void> {
  // Antes de qualquer coisa — inclusive antes de abrir o streaming, que ja fixa
  // o status 200 e impediria responder 429.
  if (!(await allowAiCall(res, config, log.route, log.ip))) return;

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
    const cost = costOf(config.model, payload.usage);
    write({
      type: 'result',
      ...payload,
      model: config.model,
      ...cost,
      ...persisted,
    });
    logApi({
      method: 'POST',
      route: log.route,
      status: 'ok',
      startedAt: t0,
      detail:
        `entrada ${log.inputChars} chars · ${tokensOf(payload)} · ` +
        `${usdOf(cost)} · modelo ${config.model}`,
    });
  } catch (err) {
    // A chamada falhou para o usuario, mas a IA cobrou pelos tokens gerados.
    // Registra o gasto antes de mais nada — best-effort, nunca mascara o erro.
    //
    // Vale para os DOIS jeitos de queimar dinheiro sem entregar diagrama: a
    // chamada que quebrou na propria IA (AiCallError) e a que respondeu, foi
    // cobrada, e so entao reprovou na validacao do ProcessSpec.
    const usageDaFalha =
      err instanceof AiCallError || err instanceof ProcessSpecValidationError
        ? err.usage
        : undefined;
    if (usageDaFalha && kind) {
      try {
        await recordAiCall({
          kind,
          model: config.model,
          usage: usageDaFalha,
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
      // Lista os problemas: sem eles o log diz que falhou, mas nao o que houve —
      // e a geracao ja foi paga, entao repetir so para descobrir custa de novo.
      const detalhes = err.issues.map((i) => `[${i.code}] ${i.message}`);
      console.log(`  ERRO de validacao (${err.issues.length} problema(s)):`);
      for (const d of detalhes) console.log(`    - ${d}`);
      console.log('');
      write({ type: 'error', error: 'ProcessSpec invalido.', issues: err.issues });
      motivo = `ProcessSpec invalido: ${detalhes.join(' · ')}`;
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
      // Falha de IA tambem custou: mostra os tokens e o valor que foram cobrados.
      detail:
        `entrada ${log.inputChars} chars` +
        (err instanceof AiCallError
          ? ` · ${tokensOf({ usage: err.usage })} (${usdOf(costOf(config.model, err.usage))}) COBRADOS`
          : '') +
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
    // Vai inteiro (codigo + mensagem), nao so a contagem: o valor do aviso esta
    // em dizer QUAL trecho conferir.
    specWarnings: result.specWarnings,
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
  input: { transcript: string; filename: string; ip: string },
): Promise<void> {
  const { transcript, filename, ip } = input;
  await streamRun(
    res,
    config,
    `Ata a partir de transcricao (${filename})`,
    { route: '/api/minutes', inputChars: transcript.length, ip },
    (onProgress) => runMinutesFromTranscript(transcript, config, onProgress),
    (result) => ({
      minutes: result.minutes,
      markdown: result.markdown,
      suggestedFilename: minutesFilename(result.minutes, filename.replace(/\.[^.]+$/, '')),
      usage: result.usage,
    }),
    // A ata nao vira projeto (o projeto so nasce se o diagrama for gerado), mas
    // ela e uma entrega: fica salva na tabela `minutes` para o especialista
    // reabrir depois. O custo entra na conta da empresa por `ai_calls` — a
    // tabela `minutes` NAO guarda tokens de proposito, para nao existirem duas
    // contagens do mesmo gasto (o relatorio de uso soma versions + ai_calls).
    async (result) => {
      await recordAiCall({
        kind: 'minutes',
        model: config.model,
        usage: result.usage,
        sourceFilename: filename,
      });
      const { minutesId } = await saveMinutes({
        title: minutesTitle(result.minutes, filename),
        sourceFilename: filename,
        transcript,
        minutes: result.minutes,
        markdown: result.markdown,
      });
      return { minutesId };
    },
    'minutes',
  );
}

/** Titulo da ata para a lista do historico: o da reuniao, ou o nome do arquivo. */
function minutesTitle(minutes: { meeting?: { title?: string } }, filename: string): string {
  const title = minutes.meeting?.title?.trim();
  return title || filename.replace(/\.[^.]+$/, '') || 'Ata sem título';
}

/**
 * Rotas de leitura/exclusao das atas salvas.
 *   GET    /api/minutes        -> lista resumida
 *   GET    /api/minutes/{id}   -> ata completa (JSON + Markdown + transcricao)
 *   DELETE /api/minutes/{id}   -> apaga a ata
 * O POST (gerar ata) e o PUT (salvar correcoes) tem handlers proprios, porque
 * precisam do corpo da requisicao ja parseado.
 */
export async function handleMinutesApi(
  method: string,
  segments: string[],
  res: ServerResponse,
): Promise<boolean> {
  if (segments[0] !== 'api' || segments[1] !== 'minutes') return false;

  const id = segments[2];
  const log = timed(method, '/' + segments.join('/'));

  if (method === 'GET' && segments.length === 2) {
    const minutes = await listMinutes();
    log.done(200, `${minutes.length} ata(s)`);
    sendJson(res, 200, { minutes });
    return true;
  }

  if (method === 'GET' && segments.length === 3 && id) {
    const doc = await getMinutesDoc(id);
    if (!doc) {
      log.done(404);
      sendJson(res, 404, { error: 'Ata nao encontrada.' });
    } else {
      log.done(200, `${doc.markdown.length} chars de Markdown`);
      sendJson(res, 200, doc);
    }
    return true;
  }

  if (method === 'DELETE' && segments.length === 3 && id) {
    const ok = await deleteMinutesDoc(id);
    log.done(ok ? 200 : 404);
    if (!ok) sendJson(res, 404, { error: 'Ata nao encontrada.' });
    else sendJson(res, 200, { deleted: true });
    return true;
  }

  return false;
}

/** PUT /api/minutes/{id}: salva o texto revisado pelo especialista. */
export async function runUpdateMinutes(
  res: ServerResponse,
  minutesId: string,
  payload: { markdown?: string },
): Promise<void> {
  const log = timed('PUT', `/api/minutes/${minutesId}`);
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
  if (!markdown.trim()) {
    log.done(400, 'ata vazia');
    sendJson(res, 400, { error: 'A ata esta vazia — nada a salvar.' });
    return;
  }
  const ok = await updateMinutesMarkdown(minutesId, markdown);
  log.done(ok ? 200 : 404, `${markdown.length} chars`);
  if (!ok) sendJson(res, 404, { error: 'Ata nao encontrada.' });
  else sendJson(res, 200, { saved: true });
}

// ---- Geracao ----

/**
 * Gera o diagrama a partir do texto e persiste como projeto novo.
 * `minutesId` chega quando o texto e uma ata do modo transcricao — e o que liga
 * o diagrama a ata de origem no banco.
 */
export async function runGenerate(
  res: ServerResponse,
  config: AppConfig,
  input: { text: string; filename: string; minutesId?: string | null; ip: string },
): Promise<void> {
  const { text, filename, minutesId, ip } = input;
  await streamRun(
    res,
    config,
    `Geracao (${filename})`,
    { route: '/api/generate', inputChars: text.length, ip },
    (onProgress) => runPipeline(text, config, onProgress),
    pipelinePayload,
    async (result) => {
      const { projectId, versionNumber } = await createProjectWithVersion({
        name: result.spec.process.name || result.spec.process.id,
        sourceFilename: filename,
        sourceText: text,
        minutesId: minutesId ?? null,
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
  ip: string;
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
    { route: '/api/refine', inputChars: input.text.length, ip: input.ip },
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
