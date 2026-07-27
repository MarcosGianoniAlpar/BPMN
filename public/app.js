/* global BpmnJS */
'use strict';

const $ = (sel) => document.querySelector(sel);

const dropzone = $('#dropzone');
const workspace = $('#workspace');
const fileInput = $('#file-input');
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
};

const projectsPanel = $('#projects-panel');
const projectsList = $('#projects-list');
const usagePanel = $('#usage-panel');
const versionBadge = $('#version-badge');

const KIND_LABEL = { generated: 'gerada', refined: 'revisada', frozen: 'congelada' };

// ---- Upload: clique e drag-and-drop ----
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) readAndGenerate(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  }),
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
  }),
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) readAndGenerate(file);
});

newBtn.addEventListener('click', goHome);

function goHome() {
  workspace.hidden = true;
  dropzone.hidden = false;
  newBtn.hidden = true;
  dlBpmnBtn.hidden = true;
  dlSvgBtn.hidden = true;
  dlPngBtn.hidden = true;
  freezeBtn.hidden = true;
  fileInput.value = '';
  state.projectId = null;
  state.versionNumber = null;
  loadProjects();
}

// ---- Processos salvos ----
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) return;
    const { projects } = await res.json();
    renderProjects(projects || []);
  } catch {
    /* home ainda funciona sem a lista */
  }
  loadUsage();
}

// ---- Uso & custo ----
async function loadUsage() {
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) return;
    renderUsage(await res.json());
  } catch {
    /* opcional */
  }
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}
function fmtUsd(n) {
  return 'US$ ' + Number(n || 0).toFixed(2);
}

function renderUsage(u) {
  if (!u || !u.perModel || u.perModel.length === 0) {
    usagePanel.hidden = true;
    return;
  }
  usagePanel.hidden = false;
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
  if (!projects.length) {
    projectsPanel.hidden = true;
    projectsList.innerHTML = '';
    return;
  }
  projectsPanel.hidden = false;
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
    if (res.ok) loadProjects();
    else showToast('Não consegui excluir.');
  } catch (err) {
    showToast('Falha ao excluir: ' + err.message);
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
async function readAndGenerate(file) {
  const name = file.name.toLowerCase();
  if (!/\.(txt|md|markdown|pdf|docx)$/.test(name)) {
    showToast('Formato não suportado. Use .txt, .md, .pdf ou .docx.');
    return;
  }

  // .txt/.md sao texto: leem no navegador (rapido, sem round-trip).
  if (/\.(txt|md|markdown)$/.test(name)) {
    const reader = new FileReader();
    reader.onload = () => generate(reader.result, file.name);
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
    await generate(data.text, file.name);
  } catch (err) {
    showToast('Falha ao enviar o documento: ' + err.message);
  } finally {
    loading.hidden = true;
  }
}

function resetSteps() {
  stepsEl.querySelectorAll('li').forEach((li) => {
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

// Executa uma etapa em streaming (geração ou revisão) e renderiza o resultado.
async function runStream(url, body) {
  resetSteps();
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
      await render(result);
      renderPipelineLog(progressDone);
    } else {
      showToast('Resposta incompleta do servidor.');
    }
  } catch (err) {
    showToast('Falha de rede: ' + err.message);
  } finally {
    loading.hidden = true;
  }
}

async function generate(text, filename) {
  state.documentText = text;
  state.filename = (filename || 'processo').replace(/\.[^.]+$/, '');
  await runStream('/api/generate', { text, filename });
}

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
  await runStream('/api/refine', {
    text: state.documentText,
    spec: state.spec,
    answers,
    filename: state.filename,
    projectId: state.projectId,
  });
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
  dropzone.hidden = true;
  projectsPanel.hidden = true;
  usagePanel.hidden = true;
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
  renderLint(data.lint);
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
  const cells = [
    { k: 'Nós', v: (spec.nodes || []).length },
    { k: 'Fluxos', v: (spec.flows || []).length },
    { k: 'Perguntas', v: (spec.unresolved_questions || []).length },
    { k: 'Tokens', v: (data.usage.inputTokens + data.usage.outputTokens).toLocaleString('pt-BR') },
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

function renderLint(lint) {
  const box = $('#lint');
  const list = $('#lint-list');
  const count = $('#lint-count');
  if (!lint || !lint.issues || lint.issues.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  count.textContent = `${lint.errors} erro(s) · ${lint.warnings} aviso(s)`;
  list.innerHTML = lint.issues
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
};

function renderNodes(nodes) {
  $('#nodes-count').textContent = nodes.length;
  const list = $('#nodes-list');
  list.innerHTML = '';
  nodes.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'node-item';
    li.dataset.id = n.id;
    const ev = (n.evidence && n.evidence[0] && n.evidence[0].quote) || '';
    li.innerHTML = `
      <div class="node-top">
        <span class="node-type ${n.type}">${TYPE_LABEL[n.type] || n.type}</span>
        <span class="node-name">${escapeHtml(n.name || n.id)}</span>
        ${n.confidence ? `<span class="node-conf">${n.confidence}</span>` : ''}
      </div>
      ${ev ? `<div class="node-ev">“${escapeHtml(ev)}”</div>` : ''}`;
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

// ---- Carrega os processos salvos ao abrir ----
loadProjects();

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
