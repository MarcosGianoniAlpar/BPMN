import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { extractTextFromBuffer, isSupportedFilename } from './documentLoader.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const publicDir = join(root, 'public');
const bpmnDist = join(root, 'node_modules', 'bpmn-js', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

/** Impede path traversal: resolve dentro de baseDir e recusa se escapar. */
function safeJoin(baseDir: string, urlPath: string): string | null {
  const target = normalize(join(baseDir, urlPath));
  return target.startsWith(baseDir) ? target : null;
}

async function readBody(req: IncomingMessage, limitBytes = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Corpo da requisicao muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readBodyBuffer(
  req: IncomingMessage,
  limitBytes = 25 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Arquivo muito grande (limite 25 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Recebe o upload de um documento (.pdf/.docx/.txt/.md) como bytes crus, com o
 * nome no header `x-filename`, e devolve o texto extraido. Assim o parsing de
 * PDF/DOCX acontece no servidor (Node), e o /api/generate continua recebendo
 * apenas texto — sem misturar upload binario com o streaming da pipeline.
 */
async function handleExtractText(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawName = req.headers['x-filename'];
  const filename = (Array.isArray(rawName) ? rawName[0] : rawName) ?? '';
  if (!filename || !isSupportedFilename(filename)) {
    return sendJson(res, 400, { error: 'Nome de arquivo ausente ou tipo nao suportado.' });
  }

  let buffer: Buffer;
  try {
    buffer = await readBodyBuffer(req);
  } catch (err) {
    return sendJson(res, 413, { error: err instanceof Error ? err.message : 'Upload invalido.' });
  }

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

async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  let payload: { text?: string; filename?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'JSON invalido.' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return sendJson(res, 400, { error: 'Documento vazio ou invalido.' });
  }

  const filename = payload.filename ?? 'documento';
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

async function handleRefine(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  let payload: {
    text?: string;
    filename?: string;
    projectId?: string;
    spec?: unknown;
    answers?: { question_id: string; question: string; answer: string }[];
  };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'JSON invalido.' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const spec = payload.spec;
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : undefined;
  if (!text || !spec || answers.length === 0) {
    return sendJson(res, 400, { error: 'Faltam texto, ProcessSpec ou respostas.' });
  }

  const answeredCount = answers.length;
  await streamRun(
    res,
    config,
    `Revisao (${payload.filename ?? 'documento'})`,
    (onProgress) =>
      runRefinement(
        text,
        spec as Parameters<typeof runRefinement>[1],
        answers,
        config,
        onProgress,
      ),
    // Refinamento vira uma nova versao do projeto existente (se houver id).
    async (result) => {
      if (!projectId) return {};
      const { versionNumber } = await addVersion(projectId, {
        kind: 'refined',
        spec: result.spec,
        bpmnXml: result.layoutXml,
        lint: result.lint,
        usage: result.usage,
        model: config.model,
        note: `Revisão com ${answeredCount} resposta(s)`,
      });
      return { projectId, versionNumber };
    },
  );
}

/**
 * API de projetos salvos (GET/DELETE). Roteamento simples baseado em segmentos
 * de path, ja que usamos o http nativo sem framework.
 * Rotas:
 *   GET    /api/projects                       -> lista resumida
 *   GET    /api/projects/{id}                  -> projeto + metadados das versoes
 *   GET    /api/projects/{id}/versions/{n}     -> versao completa (spec + bpmn)
 *   DELETE /api/projects/{id}                  -> apaga o projeto
 */
async function handleProjectsApi(
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

  if (
    method === 'GET' &&
    segments.length === 5 &&
    id &&
    segments[3] === 'versions'
  ) {
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

/**
 * Congela o estado atual do diagrama (com edicoes manuais feitas no Modeler)
 * como uma nova versao 'frozen'. Coerente com a Opcao A: a edicao livre de
 * geometria vira um snapshot que NAO sera re-layoutado ao reabrir. O
 * ProcessSpec anexado permanece o ultimo conhecido (a geometria mora no BPMN).
 */
async function handleFreeze(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  let payload: { bpmnXml?: string; spec?: unknown; note?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'JSON invalido.' });
  }

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

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';
  const segments = url.split('/').filter(Boolean);

  // Nunca deixa uma requisicao ruim derrubar o processo.
  const guard = (p: Promise<void>): void => {
    p.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: message });
    });
  };

  if (method === 'POST' && url === '/api/extract-text') {
    guard(handleExtractText(req, res));
    return;
  }
  if (method === 'POST' && url === '/api/generate') {
    guard(handleGenerate(req, res));
    return;
  }
  if (method === 'POST' && url === '/api/refine') {
    guard(handleRefine(req, res));
    return;
  }
  // POST /api/projects/{id}/freeze
  if (
    method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[2] &&
    segments[3] === 'freeze' &&
    segments.length === 4
  ) {
    guard(handleFreeze(req, res, segments[2]));
    return;
  }

  // Relatorio de uso/custo
  if (method === 'GET' && url === '/api/usage') {
    guard((async () => sendJson(res, 200, await getUsageReport()))());
    return;
  }

  // API de projetos salvos (GET/DELETE)
  if ((method === 'GET' || method === 'DELETE') && segments[0] === 'api' && segments[1] === 'projects') {
    guard(
      (async () => {
        if (!(await handleProjectsApi(method, segments, res)) && !res.headersSent) {
          sendJson(res, 404, { error: 'Rota de projeto nao encontrada.' });
        }
      })(),
    );
    return;
  }

  if (method !== 'GET') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // Assets do bpmn-js servidos direto do node_modules
  if (url === '/vendor/bpmn-modeler.js') {
    void sendFile(res, join(bpmnDist, 'bpmn-modeler.production.min.js'));
    return;
  }
  if (url.startsWith('/vendor/assets/')) {
    const target = safeJoin(join(bpmnDist, 'assets'), url.slice('/vendor/assets/'.length));
    if (target) void sendFile(res, target);
    else res.writeHead(403).end('Forbidden');
    return;
  }

  // Frontend estatico
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const target = safeJoin(publicDir, rel);
  if (target) void sendFile(res, target);
  else res.writeHead(403).end('Forbidden');
});

const PORT = Number(process.env.PORT ?? '3000');
// Valida a config (ANTHROPIC_API_KEY) ja na subida, com erro claro.
loadConfig();
server.listen(PORT, () => {
  console.log(`\n  BPMN Pipeline rodando em  http://localhost:${PORT}\n`);
  console.log('  Abra no navegador, arraste uma ata .txt/.md e gere o diagrama.\n');
});
