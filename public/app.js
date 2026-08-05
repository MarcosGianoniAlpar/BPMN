/* global BpmnJS */
'use strict';

const $ = (sel) => document.querySelector(sel);

const home = $('#home');
const workspace = $('#workspace');
const minutesView = $('#minutes-view');
const loading = $('#loading');
const stepsEl = $('#steps');
const toast = $('#toast');
const newBtn = $('#new-btn');
const dlBpmnBtn = $('#dl-bpmn');
const dlSvgBtn = $('#dl-svg');
const dlPngBtn = $('#dl-png');
const freezeBtn = $('#freeze-btn');
const pipelineLog = $('#pipeline-log');
const pipelineSteps = $('#pipeline-steps');
const applyBtn = $('#apply-answers');

// Modeler completo (edição): mantém o nome `viewer` por herança, mas agora
// permite arrastar, renomear, adicionar e conectar elementos. As edições
// manuais só são preservadas ao "Congelar versão" (Opção A da arquitetura).
const viewer = new BpmnJS({ container: '#canvas' });
let activeItem = null;
const state = {
  bpmnXml: null,
  filename: 'processo',
  documentText: '',
  spec: null,
  projectId: null,
  versionNumber: null,
  versionKind: null,
  // 'doc'        = documento já organizado -> diagrama.
  // 'transcript' = transcrição -> ata estruturada. A ata É a entrega; virar
  //                diagrama depois é opcional (e custa outra chamada de IA).
  mode: 'doc',
  minutes: null,
  minutesFilename: 'ata.md',
  // Id da ata salva no banco. Serve para gravar as correções e para marcar, no
  // projeto gerado, de qual ata o diagrama nasceu.
  minutesId: null,
};

// Etapas exibidas no overlay de progresso, por tipo de execução.
const MINUTES_STAGES = ['minutes', 'render'];
const DIAGRAM_STAGES = ['extract', 'validate', 'compile', 'layout', 'lint'];

const projectsList = $('#projects-list');
const projectsEmpty = $('#projects-empty');
const minutesList = $('#minutes-list');
const minutesEmpty = $('#minutes-empty');
const historyError = $('#history-error');
const minutesSaveBtn = $('#minutes-save');
const minutesSaved = $('#minutes-saved');
const usageSection = $('#usage-section');
const costBadge = $('#cost-badge');
const costBadgeValue = $('#cost-badge-value');
const versionBadge = $('#version-badge');

const KIND_LABEL = { generated: 'gerada', refined: 'revisada', frozen: 'congelada' };

// ---- Gaveta de histórico ----
const history = $('#history');
const historyBackdrop = $('#history-backdrop');
const historyCount = $('#history-count');

function openHistory() {
  history.classList.add('open');
  historyBackdrop.classList.add('open');
  history.setAttribute('aria-hidden', 'false');
  loadHistory(); // reabre sempre com a lista atual
}

function closeHistory() {
  history.classList.remove('open');
  historyBackdrop.classList.remove('open');
  history.setAttribute('aria-hidden', 'true');
}

function toggleHistory() {
  if (history.classList.contains('open')) closeHistory();
  else openHistory();
}

$('#history-btn').addEventListener('click', toggleHistory);
// O badge é o atalho para o detalhe: abre o histórico já no painel de uso.
costBadge.addEventListener('click', () => {
  openHistory();
  usageSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
$('#history-close').addEventListener('click', closeHistory);
historyBackdrop.addEventListener('click', closeHistory);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHistory();
});

// ---- Portas de entrada: cada card tem seu upload e define o modo ----
// Não há "modo ativo" guardado na tela: o modo é simplesmente o card em que o
// arquivo entrou, então não dá para arrastar na porta errada sem perceber.
const entryCards = document.querySelectorAll('.entry-card');
const entryInputs = document.querySelectorAll('.entry-input');

entryCards.forEach((card) => {
  const mode = card.dataset.mode;
  const input = card.querySelector('.entry-input');

  input.addEventListener('change', () => {
    if (input.files.length) start(mode, input.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    card.addEventListener(evt, (e) => {
      e.preventDefault();
      card.classList.add('dragging');
    }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    card.addEventListener(evt, (e) => {
      e.preventDefault();
      card.classList.remove('dragging');
    }),
  );
  card.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) start(mode, file);
  });
});

function start(mode, file) {
  state.mode = mode;
  readAndRun(file);
}

newBtn.addEventListener('click', goHome);

function goHome() {
  workspace.hidden = true;
  minutesView.hidden = true;
  home.hidden = false;
  newBtn.hidden = true;
  dlBpmnBtn.hidden = true;
  dlSvgBtn.hidden = true;
  dlPngBtn.hidden = true;
  freezeBtn.hidden = true;
  entryInputs.forEach((input) => (input.value = ''));
  state.projectId = null;
  state.versionNumber = null;
  state.minutesId = null;
  loadHistory();
}

/** fetch + JSON que FALA quando dá errado (usa a mensagem do servidor). */
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ---- Histórico: atas, processos e custo ----
/**
 * As três consultas são independentes e cada uma pode falhar sozinha.
 *
 * O `catch` daqui NÃO pode ser silencioso: antes, banco fora do ar ficava
 * idêntico a "nada salvo ainda" — a gaveta afirmava que não havia nada, quando
 * na verdade não tinha conseguido perguntar. `null` significa "não consegui
 * carregar" e é diferente de lista vazia.
 */
async function loadHistory() {
  const falhas = [];
  const pegar = (url, rotulo) =>
    fetchJson(url).catch((err) => {
      falhas.push(`${rotulo}: ${err.message}`);
      return null;
    });

  const [projects, minutes, usage] = await Promise.all([
    pegar('/api/projects', 'processos salvos'),
    pegar('/api/minutes', 'atas salvas'),
    pegar('/api/usage', 'uso & custo'),
  ]);

  renderProjects(projects && projects.projects);
  renderMinutesList(minutes && minutes.minutes);
  renderUsage(usage);

  historyError.hidden = falhas.length === 0;
  historyError.textContent = falhas.length
    ? 'Não consegui falar com o banco — ' +
      falhas.join(' · ') +
      '. O que está salvo não foi perdido; a lista é que não pôde ser carregada.'
    : '';
}

// ---- Uso & custo ----
async function loadUsage() {
  renderUsage(await fetchJson('/api/usage').catch(() => null));
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}
function fmtUsd(n) {
  return 'US$ ' + Number(n || 0).toFixed(2);
}

// Custo de UMA chamada: centavos. Com 2 casas quase tudo viraria "US$ 0.01" ou
// "US$ 0.00" (que leria como "de graça"), então aqui vão 3 casas.
function fmtUsdCall(n) {
  const v = Number(n || 0);
  if (v > 0 && v < 0.001) return '< US$ 0.001';
  return 'US$ ' + v.toFixed(3);
}

/**
 * Custo + tokens de UMA chamada, para mostrar junto do resultado.
 * Devolve null quando não há tokens: um projeto reaberto do histórico foi gerado
 * em outra sessão, e mostrar "US$ 0.00" ali leria como "esta geração foi de
 * graça" — melhor um "—" honesto.
 */
function callCost(data) {
  const usage = data.usage || {};
  const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (!tokens) return null;
  const cost = data.costUsd === undefined ? '' : fmtUsdCall(data.costUsd) + ' · ';
  return cost + fmtInt(tokens) + ' tokens';
}

function renderUsage(u) {
  if (!u || !u.perModel || u.perModel.length === 0) {
    usageSection.hidden = true;
    costBadge.hidden = true;
    return;
  }
  // Badge do header: só o total, visível em todas as telas.
  costBadge.hidden = false;
  costBadgeValue.textContent = fmtUsd(u.totalCostUsd);
  costBadge.title =
    `Custo estimado acumulado: ${fmtUsd(u.totalCostUsd)} em ${fmtInt(u.totalCalls)} chamada(s) de IA` +
    (u.costComplete ? '' : ' (há modelo sem preço na tabela — total subestimado)') +
    '. Preços de lista. Clique para ver o detalhe por modelo.';
  costBadge.classList.toggle('incomplete', !u.costComplete);

  usageSection.hidden = false;
  $('#usage-totals').innerHTML = [
    { k: 'Chamadas de IA', v: fmtInt(u.totalCalls) },
    { k: 'Tokens (entrada)', v: fmtInt(u.totalInputTokens) },
    { k: 'Tokens (saída)', v: fmtInt(u.totalOutputTokens) },
    { k: 'Custo estimado', v: fmtUsd(u.totalCostUsd) },
  ]
    .map((c) => `<div class="usage-cell"><div class="uv">${c.v}</div><div class="uk">${c.k}</div></div>`)
    .join('');

  const rows = u.perModel
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.label)}</td>
        <td class="num">${fmtInt(m.calls)}</td>
        <td class="num">${fmtInt(m.inputTokens)}</td>
        <td class="num">${fmtInt(m.outputTokens)}</td>
        <td class="num">${m.costKnown ? fmtUsd(m.costUsd) : '—'}</td>
      </tr>`,
    )
    .join('');
  $('#usage-table').innerHTML =
    `<thead><tr><th>Modelo</th><th class="num">Chamadas</th><th class="num">Entrada</th><th class="num">Saída</th><th class="num">Custo est.</th></tr></thead>` +
    `<tbody>${rows}</tbody>`;
}

function renderProjects(projects) {
  // null = a consulta falhou. Nesse caso não afirma "nenhum processo salvo";
  // quem explica o que houve é a faixa de erro da gaveta.
  if (!projects) {
    projectsList.innerHTML = '';
    projectsEmpty.hidden = true;
    historyCount.hidden = true;
    return;
  }
  historyCount.hidden = projects.length === 0;
  historyCount.textContent = projects.length;
  projectsEmpty.hidden = projects.length > 0;

  if (!projects.length) {
    projectsList.innerHTML = '';
    return;
  }
  projectsList.innerHTML = projects
    .map(
      (p) => `<li class="project-item" data-id="${escapeHtml(p.id)}">
        <div class="project-main">
          <span class="project-name">${escapeHtml(p.name)}</span>
          <span class="project-meta">${p.nodeCount} nós · v${p.latestVersionNumber} (${KIND_LABEL[p.latestKind] || p.latestKind}) · ${formatDate(p.updatedAt)}</span>
        </div>
        <button class="project-del" title="Excluir" data-id="${escapeHtml(p.id)}">✕</button>
      </li>`,
    )
    .join('');
  projectsList.querySelectorAll('.project-item').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.project-del')) return;
      openProject(li.dataset.id);
    });
  });
  projectsList.querySelectorAll('.project-del').forEach((btn) => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.id));
  });
}

async function openProject(id) {
  loading.hidden = true;
  try {
    const detailRes = await fetch(`/api/projects/${id}`);
    if (!detailRes.ok) return showToast('Não consegui abrir o processo.');
    const detail = await detailRes.json();
    const verRes = await fetch(`/api/projects/${id}/versions/${detail.latestVersionNumber}`);
    if (!verRes.ok) return showToast('Não consegui carregar a versão.');
    const version = await verRes.json();

    state.documentText = detail.sourceText || '';
    state.filename = (detail.sourceFilename || detail.name || 'processo').replace(/\.[^.]+$/, '');
    state.projectId = id;

    await render({
      spec: version.spec,
      bpmnXml: version.bpmnXml,
      lint: version.lint,
      usage: { inputTokens: 0, outputTokens: 0 },
      projectId: id,
      versionNumber: version.versionNumber,
      versionKind: version.kind,
    });
  } catch (err) {
    showToast('Falha ao abrir o processo: ' + err.message);
  }
}

async function deleteProject(id) {
  if (!confirm('Excluir este processo e todas as suas versões?')) return;
  try {
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (res.ok) loadHistory();
    else showToast('Não consegui excluir.');
  } catch (err) {
    showToast('Falha ao excluir: ' + err.message);
  }
}

// ---- Atas salvas ----
function renderMinutesList(minutes) {
  if (!minutes) {
    minutesList.innerHTML = '';
    minutesEmpty.hidden = true;
    return;
  }
  minutesEmpty.hidden = minutes.length > 0;
  if (!minutes.length) {
    minutesList.innerHTML = '';
    return;
  }
  minutesList.innerHTML = minutes
    .map((m) => {
      const etapas = `${m.stepCount} etapa${m.stepCount === 1 ? '' : 's'} de fluxo`;
      const diagramas = m.projectCount
        ? ` · ${m.projectCount} diagrama${m.projectCount === 1 ? '' : 's'}`
        : '';
      return `<li class="project-item" data-id="${escapeHtml(m.id)}">
        <div class="project-main">
          <span class="project-name">${escapeHtml(m.title)}</span>
          <span class="project-meta">${etapas}${diagramas} · ${formatDate(m.updatedAt)}</span>
        </div>
        <button class="project-del" title="Excluir" data-id="${escapeHtml(m.id)}">✕</button>
      </li>`;
    })
    .join('');
  minutesList.querySelectorAll('.project-item').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.project-del')) return;
      openMinutes(li.dataset.id);
    });
  });
  minutesList.querySelectorAll('.project-del').forEach((btn) => {
    btn.addEventListener('click', () => deleteMinutes(btn.dataset.id));
  });
}

async function openMinutes(id) {
  try {
    const doc = await fetchJson(`/api/minutes/${id}`);
    showMinutes(
      {
        minutes: doc.minutes,
        markdown: doc.markdown,
        minutesId: doc.id,
        // Sem `usage`: a chamada de IA foi em outra sessão. O gasto dela continua
        // no painel de custo; repeti-lo aqui seria cobrar duas vezes na leitura.
        suggestedFilename:
          (doc.sourceFilename || doc.title || 'ata').replace(/\.[^.]+$/, '') + '.md',
      },
      doc.title,
    );
  } catch (err) {
    showToast('Não consegui abrir a ata: ' + err.message);
  }
}

async function deleteMinutes(id) {
  if (!confirm('Excluir esta ata? Os diagramas gerados a partir dela continuam salvos.')) return;
  try {
    await fetchJson(`/api/minutes/${id}`, { method: 'DELETE' });
    loadHistory();
  } catch (err) {
    showToast('Falha ao excluir a ata: ' + err.message);
  }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ---- Download ----
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

dlBpmnBtn.addEventListener('click', async () => {
  try {
    // Exporta o estado ATUAL do modeler (inclui edições manuais).
    const { xml } = await viewer.saveXML({ format: true });
    downloadBlob(state.filename + '.bpmn', xml, 'application/xml');
  } catch (err) {
    showToast('Falha ao exportar .bpmn: ' + err.message);
  }
});

dlSvgBtn.addEventListener('click', async () => {
  try {
    const { svg } = await viewer.saveSVG();
    downloadBlob(state.filename + '.svg', svg, 'image/svg+xml');
  } catch (err) {
    showToast('Falha ao exportar SVG: ' + err.message);
  }
});

dlPngBtn.addEventListener('click', async () => {
  try {
    const { svg } = await viewer.saveSVG();
    const png = await svgToPngBlob(svg);
    const url = URL.createObjectURL(png);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.filename + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('Falha ao exportar PNG: ' + err.message);
  }
});

// Converte o SVG do diagrama em PNG via canvas (2x para nitidez).
function svgToPngBlob(svg) {
  return new Promise((resolve, reject) => {
    const scale = 2;
    const sizeMatch = svg.match(/width="(\d+)"[\s\S]*?height="(\d+)"/);
    const w = sizeMatch ? Number(sizeMatch[1]) : 1200;
    const h = sizeMatch ? Number(sizeMatch[2]) : 800;
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas vazio'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('não consegui rasterizar o SVG'));
    };
    img.src = url;
  });
}

// ---- Congelar versão (captura edições manuais) ----
freezeBtn.addEventListener('click', async () => {
  if (!state.projectId) {
    showToast('Este processo ainda não foi salvo.');
    return;
  }
  try {
    const { xml } = await viewer.saveXML({ format: true });
    const res = await fetch(`/api/projects/${state.projectId}/freeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpmnXml: xml, spec: state.spec }),
    });
    const data = await res.json().catch(() => ({ error: 'Resposta inválida.' }));
    if (!res.ok) {
      showToast(data.error || 'Falha ao congelar.');
      return;
    }
    state.bpmnXml = xml;
    state.versionNumber = data.versionNumber;
    state.versionKind = 'frozen';
    renderVersionBadge({});
    try {
      viewer.get('commandStack').clear(); // zera o "dirty": o estado atual agora está salvo
    } catch {
      /* modeler pode não expor clear em versões antigas */
    }
    showToast(`Versão v${data.versionNumber} congelada.`);
  } catch (err) {
    showToast('Falha ao congelar: ' + err.message);
  }
});

// ---- Ler o arquivo e chamar a API ----

/** Despacha o texto lido conforme o modo escolhido na home. */
function runWithText(text, filename) {
  return state.mode === 'transcript' ? makeMinutes(text, filename) : generate(text, filename);
}

async function readAndRun(file) {
  const name = file.name.toLowerCase();
  if (!/\.(txt|md|markdown|pdf|docx)$/.test(name)) {
    showToast('Formato não suportado. Use .txt, .md, .pdf ou .docx.');
    return;
  }

  // .txt/.md sao texto: leem no navegador (rapido, sem round-trip).
  if (/\.(txt|md|markdown)$/.test(name)) {
    const reader = new FileReader();
    reader.onload = () => runWithText(reader.result, file.name);
    reader.onerror = () => showToast('Não consegui ler o arquivo.');
    reader.readAsText(file, 'utf-8');
    return;
  }

  // .pdf/.docx: o servidor extrai o texto (parsing binario roda no Node).
  loading.hidden = false;
  try {
    const res = await fetch('/api/extract-text', {
      method: 'POST',
      // Headers HTTP so aceitam ISO-8859-1: codifica o nome (acentos, espacos)
      // e o servidor decodifica com decodeURIComponent.
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: 'Resposta inválida do servidor.' }));
    if (!res.ok) {
      showToast(data.error || 'Falha ao ler o documento.');
      return;
    }
    await runWithText(data.text, file.name);
  } catch (err) {
    showToast('Falha ao enviar o documento: ' + err.message);
  } finally {
    loading.hidden = true;
  }
}

// Mostra só as etapas da execução em curso (ata x diagrama).
function resetSteps(stages) {
  stepsEl.querySelectorAll('li').forEach((li) => {
    li.hidden = !stages.includes(li.dataset.stage);
    li.classList.remove('active', 'done');
    li.querySelector('.t').textContent = '';
  });
}

function updateStep(msg) {
  const li = stepsEl.querySelector(`li[data-stage="${msg.stage}"]`);
  if (!li) return;
  if (msg.status === 'start') {
    li.classList.add('active');
  } else {
    li.classList.remove('active');
    li.classList.add('done');
    li.querySelector('.t').textContent =
      (msg.detail ? msg.detail + ' · ' : '') + msg.elapsed + 's';
  }
}

// Executa uma etapa em streaming (ata, geração ou revisão) e entrega o
// resultado a `onResult`. `stages`/`title` só controlam o overlay de progresso.
async function runStream(url, body, { stages = DIAGRAM_STAGES, title = 'Gerando o diagrama', onResult } = {}) {
  resetSteps(stages);
  $('#loading-title').textContent = title;
  loading.hidden = false;
  const progressDone = [];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Erros de requisição (400) vêm como JSON simples, não streaming.
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Erro inesperado.' }));
      showToast(formatError(data));
      return;
    }

    // Resposta em streaming NDJSON: uma linha por etapa + linha final.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let error = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          updateStep(msg);
          if (msg.status === 'done') progressDone.push(msg);
        } else if (msg.type === 'result') {
          result = msg;
        } else if (msg.type === 'error') {
          error = msg;
        }
      }
    }

    if (error) {
      showToast(formatError(error));
      return;
    }
    if (result) {
      await (onResult ? onResult(result, progressDone) : render(result));
    } else {
      showToast('Resposta incompleta do servidor.');
    }
  } catch (err) {
    showToast('Falha de rede: ' + err.message);
  } finally {
    loading.hidden = true;
    // Atualiza o badge de custo depois de QUALQUER tentativa, inclusive as que
    // falharam: a IA cobra pelos tokens gerados mesmo quando a resposta é
    // inutilizável, e esse gasto tem que aparecer.
    void loadUsage();
  }
}

// Resultado de uma execução que produz diagrama (geração ou revisão).
const diagramOptions = {
  stages: DIAGRAM_STAGES,
  title: 'Gerando o diagrama',
  onResult: async (result, progressDone) => {
    await render(result);
    renderPipelineLog(progressDone);
  },
};

/**
 * Pré-voo: confirma o documento ANTES de gastar. O erro caro não é o documento
 * difícil — é o documento errado, que só se descobre depois de pagar a chamada.
 * Mostra começo e fim (o fim denuncia arquivo truncado na extração).
 */
// Espelha src/sizing.ts. Estourar o teto de saída é a falha mais cara: a chamada
// é cobrada inteira e não devolve nada, porque o JSON vem cortado no meio.
const CHARS_POR_TOKEN = 3.5;
const SAIDA_POR_TOKEN_DE_DOCUMENTO = 4;
const MAX_OUTPUT_TOKENS = 64000;

function confirmarDocumento(text, filename, modo) {
  const linhas = text.split('\n').filter((l) => l.trim());
  const amostra = (ls) => ls.map((l) => '  | ' + l.slice(0, 70)).join('\n');
  const tokens = Math.round(text.length / CHARS_POR_TOKEN);
  const saida = tokens * SAIDA_POR_TOKEN_DE_DOCUMENTO;

  let aviso = '';
  if (saida > MAX_OUTPUT_TOKENS) {
    aviso =
      `\n⚠ RISCO ALTO de estourar o limite de saída (~${saida} estimados, teto ${MAX_OUTPUT_TOKENS}).\n` +
      `Se estourar, a chamada é COBRADA e não devolve nada.\n` +
      `Considere dividir o documento por processo.\n`;
  } else if (saida > MAX_OUTPUT_TOKENS * 0.8) {
    aviso = `\n⚠ Margem apertada: ~${saida} tokens de resposta para um teto de ${MAX_OUTPUT_TOKENS}.\n`;
  }

  return confirm(
    `Enviar este documento para a IA?\n\n` +
      `Arquivo: ${filename || '(sem nome)'}\n` +
      `Tamanho: ${text.length} chars · ~${tokens} tokens\n` +
      `Modo: ${modo}\n` +
      aviso +
      `\nComeço:\n${amostra(linhas.slice(0, 3))}\n\n` +
      `Fim:\n${amostra(linhas.slice(-2))}\n\n` +
      `Isto gasta a API da empresa.`,
  );
}

async function generate(text, filename, minutesId) {
  // minutesId: veio da ata já revisada na tela, então o conteúdo já foi visto.
  if (!minutesId && !confirmarDocumento(text, filename, 'documento → diagrama')) return;
  state.documentText = text;
  state.filename = (filename || 'processo').replace(/\.[^.]+$/, '');
  await runStream('/api/generate', { text, filename, minutesId }, diagramOptions);
}

// ---- Modo transcrição: a transcrição vira a ata estruturada (a entrega) ----
async function makeMinutes(text, filename) {
  if (!confirmarDocumento(text, filename, 'transcrição → ata')) return;
  await runStream('/api/minutes', { text, filename }, {
    stages: MINUTES_STAGES,
    title: 'Estruturando a ata',
    onResult: (result) => showMinutes(result, filename),
  });
}

function showMinutes(data, sourceFilename) {
  state.minutes = data.minutes || null;
  state.minutesFilename = data.suggestedFilename || 'ata.md';
  state.minutesId = data.minutesId || null;
  // Sem id (falha ao salvar no banco) não há o que atualizar: o botão some em vez
  // de prometer um "salvar" que não teria onde gravar.
  minutesSaveBtn.hidden = !state.minutesId;
  minutesSaved.hidden = true;
  home.hidden = true;
  workspace.hidden = true;
  closeHistory();
  minutesView.hidden = false;
  newBtn.hidden = false;

  $('#minutes-md').value = data.markdown || '';
  const title = (data.minutes && data.minutes.meeting && data.minutes.meeting.title) || sourceFilename;
  $('#minutes-title').textContent = 'Ata estruturada — ' + title;

  $('#minutes-usage').textContent = 'esta ata: ' + (callCost(data) || '—');

  renderMinutesCards(data.minutes || {});
}

function card(title, bodyHtml, hint) {
  return `<h3>${escapeHtml(title)}</h3>${hint ? `<p class="card-hint">${escapeHtml(hint)}</p>` : ''}${bodyHtml}`;
}

function renderMinutesCards(minutes) {
  const flow = minutes.process_flow || {};
  const steps = flow.steps || [];
  const flowBox = $('#minutes-flow');
  if (steps.length) {
    const items = steps
      .map((s) => {
        const branches = (s.outcomes || [])
          .map((o) => `<li class="branch">${escapeHtml(o)}</li>`)
          .join('');
        return `<li>
          <span class="step-actor">${escapeHtml(s.actor || '—')}</span>
          <span class="step-action">${escapeHtml(s.action || '')}</span>
          ${branches ? `<ul class="branches">${branches}</ul>` : ''}
        </li>`;
      })
      .join('');
    flowBox.hidden = false;
    flowBox.innerHTML = card(
      `Fluxo detectado (${steps.length} etapa${steps.length > 1 ? 's' : ''})`,
      `<ol class="flow-steps">${items}</ol>`,
      'O trabalho que a reunião combinou, em ordem.',
    );
  } else {
    flowBox.hidden = false;
    flowBox.innerHTML = card(
      'Fluxo detectado',
      '<p class="empty">Nenhuma etapa de fluxo foi identificada — a reunião não descreveu um processo em ordem. A ata continua válida; só não há o que virar diagrama.</p>',
    );
  }

  const counts = [
    { k: 'Participantes', v: (minutes.participants || []).length },
    { k: 'Tópicos', v: (minutes.topics || []).length },
    { k: 'Decisões', v: (minutes.decisions || []).length },
    { k: 'Ações', v: (minutes.action_items || []).length },
  ];
  $('#minutes-summary').innerHTML = card(
    'Resumo da ata',
    `<div class="metrics">${counts
      .map((c) => `<div class="metric"><div class="v">${c.v}</div><div class="k">${c.k}</div></div>`)
      .join('')}</div>`,
  );

  const open = minutes.open_questions || [];
  const openBox = $('#minutes-open');
  openBox.hidden = open.length === 0;
  if (open.length) {
    openBox.innerHTML = card(
      `Pontos em aberto (${open.length})`,
      `<ul class="open-list">${open
        .map(
          (q) =>
            `<li>${escapeHtml(q.question)}${q.reason ? `<span class="why">${escapeHtml(q.reason)}</span>` : ''}</li>`,
        )
        .join('')}</ul>`,
      'Não foram definidos na reunião — o diagrama não vai inventá-los.',
    );
  }
}

$('#minutes-download').addEventListener('click', () => {
  downloadBlob(state.minutesFilename, $('#minutes-md').value, 'text/markdown;charset=utf-8');
});

/** Grava o texto revisado da ata. Devolve true se salvou. */
async function saveMinutesEdits(markdown) {
  if (!state.minutesId) return false;
  try {
    await fetchJson(`/api/minutes/${state.minutesId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown }),
    });
    return true;
  } catch (err) {
    showToast('Não consegui salvar a ata: ' + err.message);
    return false;
  }
}

minutesSaveBtn.addEventListener('click', async () => {
  const markdown = $('#minutes-md').value.trim();
  if (!markdown) {
    showToast('A ata está vazia.');
    return;
  }
  if (await saveMinutesEdits(markdown)) {
    minutesSaved.textContent = 'salvo';
    minutesSaved.hidden = false;
    clearTimeout(minutesSaved._t);
    minutesSaved._t = setTimeout(() => (minutesSaved.hidden = true), 3000);
  }
});

// Passo opcional: o texto da ata (já com as correções) vira o diagrama.
$('#minutes-generate').addEventListener('click', async () => {
  const markdown = $('#minutes-md').value.trim();
  if (!markdown) {
    showToast('A ata está vazia.');
    return;
  }
  // Grava as correções antes de gerar: assim a ata salva é exatamente o texto
  // que originou o diagrama. Se falhar, o diagrama sai do mesmo jeito.
  await saveMinutesEdits(markdown);
  await generate(markdown, state.minutesFilename, state.minutesId);
});

async function applyAnswers() {
  const answers = [];
  document.querySelectorAll('.q-answer').forEach((ta) => {
    const answer = ta.value.trim();
    if (!answer) return;
    const q = (state.spec.unresolved_questions || []).find((x) => x.id === ta.dataset.qid);
    answers.push({ question_id: ta.dataset.qid, question: q ? q.question : '', answer });
  });
  if (!answers.length) {
    showToast('Responda pelo menos uma pergunta antes de recompilar.');
    return;
  }
  // Recompilar regera o diagrama a partir do ProcessSpec: edições manuais não
  // congeladas seriam perdidas. Avisa antes (Opção A).
  if (hasManualEdits() && !confirm(
    'Você fez edições manuais no diagrama. Recompilar vai regerá-lo e essas ' +
    'edições serão perdidas (a menos que você "Congele" antes). Continuar?',
  )) {
    return;
  }
  await runStream(
    '/api/refine',
    {
      text: state.documentText,
      spec: state.spec,
      answers,
      filename: state.filename,
      projectId: state.projectId,
    },
    { ...diagramOptions, title: 'Recompilando o diagrama' },
  );
}

// true se houver alterações no modeler desde a última carga/congelamento.
function hasManualEdits() {
  try {
    return viewer.get('commandStack').canUndo();
  } catch {
    return false;
  }
}

function formatError(data) {
  if (data.issues && data.issues.length) {
    return 'ProcessSpec inválido: ' + data.issues.map((i) => i.message).join(' · ');
  }
  return data.error || 'Erro inesperado.';
}

// ---- Renderizar resultado ----
async function render(data) {
  home.hidden = true;
  minutesView.hidden = true;
  closeHistory();
  workspace.hidden = false;
  newBtn.hidden = false;
  dlBpmnBtn.hidden = false;
  dlSvgBtn.hidden = false;
  dlPngBtn.hidden = false;
  state.bpmnXml = data.bpmnXml;
  state.spec = data.spec;
  if (data.projectId) state.projectId = data.projectId;
  freezeBtn.hidden = !(data.projectId || state.projectId);
  if (data.versionNumber) state.versionNumber = data.versionNumber;
  if (data.versionKind) state.versionKind = data.versionKind;

  const spec = data.spec;
  $('#proc-name').textContent = spec.process.name || spec.process.id;
  $('#proc-desc').textContent = spec.process.description || '';
  renderVersionBadge(data);

  renderMetrics(spec, data);
  renderQuestions(spec.unresolved_questions || []);
  renderLint(data.lint, data.specWarnings);
  renderNodes(spec.nodes || []);

  try {
    await viewer.importXML(data.bpmnXml);
    viewer.get('canvas').zoom('fit-viewport');
    wireCanvasClicks();
  } catch (err) {
    showToast('Diagrama gerado, mas falhou ao renderizar: ' + err.message);
  }
}

function renderVersionBadge(data) {
  const n = data.versionNumber ?? state.versionNumber;
  const kind = data.versionKind ?? state.versionKind;
  if (!n) {
    versionBadge.hidden = true;
    return;
  }
  versionBadge.hidden = false;
  versionBadge.textContent = `v${n} · ${KIND_LABEL[kind] || 'salva'}`;
}

function renderMetrics(spec, data) {
  const usage = data.usage || {};
  const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  const cells = [
    { k: 'Nós', v: (spec.nodes || []).length },
    { k: 'Fluxos', v: (spec.flows || []).length },
    { k: 'Perguntas', v: (spec.unresolved_questions || []).length },
    // No lugar do contador de tokens cru: os tokens seguem no rótulo, mas o
    // número em destaque é o que a empresa paga por esta geração.
    {
      k: tokens ? `custo · ${fmtInt(tokens)} tokens` : 'custo desta geração',
      v: tokens && data.costUsd !== undefined ? fmtUsdCall(data.costUsd) : '—',
    },
  ];
  $('#metrics').innerHTML = cells
    .map((c) => `<div class="metric"><div class="v">${c.v}</div><div class="k">${c.k}</div></div>`)
    .join('');
}

const STAGE_TITLE = {
  extract: 'Extração (IA)',
  validate: 'Validação',
  compile: 'Compilação BPMN',
  layout: 'Layout',
};

function renderPipelineLog(events) {
  if (!events.length) {
    pipelineLog.hidden = true;
    return;
  }
  pipelineLog.hidden = false;
  pipelineSteps.innerHTML = events
    .map(
      (e, i) => `<li>
        <span class="pl-stage">${i + 1}. ${STAGE_TITLE[e.stage] || e.stage}</span>
        <span class="pl-detail">${e.detail ? escapeHtml(e.detail) : ''}</span>
        <span class="pl-time">${e.elapsed}s</span>
      </li>`,
    )
    .join('');
}

function renderQuestions(questions) {
  const box = $('#questions');
  const list = $('#questions-list');
  if (!questions.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  list.innerHTML = questions
    .map(
      (q) => `<li>
        <div class="q-text">${escapeHtml(q.question)}</div>
        ${q.reason ? `<div class="why">${escapeHtml(q.reason)}</div>` : ''}
        <textarea class="q-answer" data-qid="${escapeHtml(q.id)}" rows="2"
          placeholder="Sua resposta (opcional)"></textarea>
      </li>`,
    )
    .join('');
}

// `specWarnings` sao defeitos que a validacao CONSERTOU para o diagrama poder
// sair (ex.: um fluxo apontando para um no que a IA nao declarou, descartado).
// Entram na mesma caixa do bpmnlint de proposito: para o especialista e a mesma
// pergunta — "o que eu preciso conferir neste desenho?". Consertar em silencio
// seria pior que abortar: o desenho pareceria fiel ao documento.
function renderLint(lint, specWarnings) {
  const box = $('#lint');
  const list = $('#lint-list');
  const count = $('#lint-count');
  const doSpec = (specWarnings || []).map((w) => ({
    category: 'warning',
    rule: w.code,
    message: w.message,
  }));
  const issues = [...doSpec, ...((lint && lint.issues) || [])];
  if (issues.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const erros = (lint && lint.errors) || 0;
  const avisos = ((lint && lint.warnings) || 0) + doSpec.length;
  count.textContent = `${erros} erro(s) · ${avisos} aviso(s)`;
  list.innerHTML = issues
    .map(
      (i) => `<li class="lint-item ${i.category}" ${i.id ? `data-id="${escapeHtml(i.id)}"` : ''}>
        <span class="lint-cat ${i.category}">${i.category === 'error' ? 'erro' : 'aviso'}</span>
        <span class="lint-msg">${escapeHtml(i.message)}</span>
        <span class="lint-rule">${escapeHtml(i.rule)}</span>
      </li>`,
    )
    .join('');
  // Clicar num aviso com elemento associado destaca no diagrama.
  list.querySelectorAll('.lint-item[data-id]').forEach((li) => {
    li.addEventListener('click', () => selectNode(li.dataset.id, li));
  });
}

const TYPE_LABEL = {
  start_event: 'início',
  end_event: 'fim',
  user_task: 'tarefa',
  service_task: 'serviço',
  exclusive_gateway: 'decisão',
  parallel_gateway: 'paralelo',
  timer_event: 'espera',
  message_event: 'mensagem',
};

function renderNodes(nodes) {
  $('#nodes-count').textContent = nodes.length;
  const list = $('#nodes-list');
  list.innerHTML = '';
  nodes.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'node-item';
    li.dataset.id = n.id;
    // O diagrama mostra so o `name` (rotulo curto); e aqui que o especialista le
    // a tarefa por extenso e a base dela. Todas as citacoes, nao so a primeira:
    // e delas que sai o "quem disse isso, em que momento".
    const quotes = (n.evidence || []).map((e) => e && e.quote).filter(Boolean);
    li.innerHTML = `
      <div class="node-top">
        <span class="node-type ${n.type}">${TYPE_LABEL[n.type] || n.type}</span>
        <span class="node-name">${escapeHtml(n.name || n.id)}</span>
        ${n.confidence ? `<span class="node-conf">${n.confidence}</span>` : ''}
      </div>
      ${n.detail ? `<div class="node-detail">${escapeHtml(n.detail)}</div>` : ''}
      ${quotes.map((q) => `<div class="node-ev">“${escapeHtml(q)}”</div>`).join('')}`;
    li.addEventListener('click', () => selectNode(n.id, li));
    list.appendChild(li);
  });
}

// ---- Destaque cruzado lista <-> diagrama ----
function selectNode(id, li) {
  const canvas = viewer.get('canvas');
  if (activeItem) {
    activeItem.classList.remove('active');
    if (activeItem.dataset.id) canvas.removeMarker(activeItem.dataset.id, 'highlight');
  }
  if (activeItem === li) {
    activeItem = null;
    return;
  }
  li.classList.add('active');
  try {
    canvas.addMarker(id, 'highlight');
    const el = viewer.get('elementRegistry').get(id);
    if (el) canvas.scrollToElement(el);
  } catch {
    /* elemento pode não existir no diagrama (ex.: lane) */
  }
  activeItem = li;
}

function wireCanvasClicks() {
  viewer.get('eventBus').on('element.click', (e) => {
    const li = document.querySelector(`.node-item[data-id="${e.element.id}"]`);
    if (li) {
      selectNode(e.element.id, li);
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

// ---- Loop de esclarecimento ----
applyBtn.addEventListener('click', applyAnswers);

// ---- Carrega atas, processos salvos e custo ao abrir ----
loadHistory();

// ---- Toolbar de zoom ----
$('#zoom-fit').addEventListener('click', () => viewer.get('canvas').zoom('fit-viewport'));
$('#zoom-in').addEventListener('click', () => viewer.get('canvas').zoom(viewer.get('canvas').zoom() * 1.2));
$('#zoom-out').addEventListener('click', () => viewer.get('canvas').zoom(viewer.get('canvas').zoom() / 1.2));

// ---- Utils ----
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.hidden = true), 6000);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
