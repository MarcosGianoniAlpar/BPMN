import type { MeetingMinutes } from './types/meeting-minutes.js';

/**
 * Renderiza a `MeetingMinutes` como Markdown — a "ata configurada".
 *
 * 100% deterministico: nenhuma IA aqui. O documento gerado tem dois publicos ao
 * mesmo tempo:
 *   1. **pessoas** — e uma ata de verdade, para ler, revisar e arquivar;
 *   2. **o pipeline de BPMN** — a secao "Fluxo do processo acordado" e escrita no
 *      formato que o `prompts/extract-process.md` le melhor (uma etapa por item,
 *      com ator, acao, condicao e bifurcacoes explicitas), e as citacoes literais
 *      da transcricao ficam junto de cada etapa para virarem `evidence` no
 *      ProcessSpec — assim a rastreabilidade sobrevive ao passo intermediario.
 */

// ---- Helpers ----

/** Escapa o que quebraria uma celula de tabela Markdown. */
function cell(value: string | undefined): string {
  return (value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || '—';
}

function text(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Cada citacao vira um blockquote. Ja vem pronta da IA ("trecho — Speaker, hh:mm"). */
function quoteLines(evidence: string[] | undefined, indent = ''): string[] {
  return (evidence ?? [])
    .filter((e) => text(e))
    .map((e) => `${indent}> ${text(e).replace(/\s*\n\s*/g, ' ')}`);
}

function section(title: string, body: string[]): string[] {
  if (!body.length) return [];
  return [`## ${title}`, '', ...body, ''];
}

/** Etiqueta do executor que ajuda o extrator a montar raias e pools. */
const ACTOR_LABEL: Record<string, string> = {
  sistema: 'executado por sistema',
  externo: 'organização externa',
};

// ---- Render ----

export function renderMinutesMarkdown(minutes: MeetingMinutes): string {
  const lines: string[] = [];

  // Cabecalho. A IA costuma ja devolver um titulo do tipo "Reuniao semanal —
  // ..."; so prefixamos "Ata de Reuniao" quando o titulo nao se anuncia sozinho.
  const meeting = minutes.meeting ?? { title: 'Reunião' };
  const title = text(meeting.title) || 'Reunião';
  const selfTitled = /\b(ata|reuni[aã]o|meeting)\b/i.test(title);
  lines.push(`# ${selfTitled ? title : `Ata de Reunião — ${title}`}`, '');

  const header: string[] = [];
  if (text(meeting.date)) header.push(`- **Data:** ${text(meeting.date)}`);
  if (text(meeting.objective)) header.push(`- **Objetivo:** ${text(meeting.objective)}`);
  header.push('- **Origem:** transcrição da reunião, estruturada automaticamente');
  lines.push(...header, '');

  if (text(meeting.context)) {
    lines.push('## Contexto', '', text(meeting.context), '');
  }

  // Participantes
  const participants = minutes.participants ?? [];
  if (participants.length) {
    lines.push(
      ...section('Participantes', [
        '| Participante | Papel |',
        '| --- | --- |',
        ...participants.map((p) => `| ${cell(p.name)} | ${cell(p.role)} |`),
      ]),
    );
  }

  // Discussao por topico
  const topics = minutes.topics ?? [];
  if (topics.length) {
    const body: string[] = [];
    topics.forEach((t, i) => {
      body.push(`### ${i + 1}. ${text(t.title)}`, '');
      if (text(t.summary)) body.push(text(t.summary), '');
      const quotes = quoteLines(t.evidence);
      if (quotes.length) body.push(...quotes, '');
    });
    lines.push(...section('Discussão', body));
  }

  // Decisoes
  const decisions = minutes.decisions ?? [];
  if (decisions.length) {
    const body: string[] = [];
    decisions.forEach((d, i) => {
      body.push(`### D${i + 1}. ${text(d.description)}`, '');
      if (text(d.owner)) body.push(`- **Responsável:** ${text(d.owner)}`);
      if (text(d.rationale)) body.push(`- **Motivo:** ${text(d.rationale)}`);
      if (text(d.owner) || text(d.rationale)) body.push('');
      const quotes = quoteLines(d.evidence);
      if (quotes.length) body.push(...quotes, '');
    });
    lines.push(...section('Decisões', body));
  }

  // Fluxo do processo — a secao que alimenta o diagrama BPMN
  lines.push(...renderProcessFlow(minutes));

  // Acoes combinadas
  const actions = minutes.action_items ?? [];
  if (actions.length) {
    lines.push(
      ...section('Ações combinadas', [
        '| # | Ação | Responsável | Prazo |',
        '| --- | --- | --- | --- |',
        ...actions.map(
          (a, i) => `| ${i + 1} | ${cell(a.description)} | ${cell(a.owner)} | ${cell(a.due)} |`,
        ),
      ]),
    );
  }

  // Pontos em aberto
  const open = minutes.open_questions ?? [];
  if (open.length) {
    lines.push(
      ...section('Pontos em aberto', [
        '_Não foram definidos na reunião — não devem ser assumidos no diagrama._',
        '',
        ...open.map(
          (q, i) =>
            `${i + 1}. ${text(q.question)}${text(q.reason) ? ` — _${text(q.reason)}_` : ''}`,
        ),
      ]),
    );
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderProcessFlow(minutes: MeetingMinutes): string[] {
  const flow = minutes.process_flow;
  const steps = flow?.steps ?? [];
  if (!flow || !steps.length) return [];

  const body: string[] = [];
  if (text(flow.name)) body.push(`**Processo:** ${text(flow.name)}`, '');
  if (text(flow.objective)) body.push(`**Objetivo:** ${text(flow.objective)}`, '');
  if (text(flow.trigger)) body.push(`**Início (o que dispara):** ${text(flow.trigger)}`, '');
  if (text(flow.outcome)) body.push(`**Fim (resultado):** ${text(flow.outcome)}`, '');

  steps.forEach((step, i) => {
    const label = step.actor_type ? ACTOR_LABEL[step.actor_type] : undefined;
    const suffix = label ? ` _(${label})_` : '';
    body.push(`${i + 1}. **${text(step.actor)}**${suffix} — ${text(step.action)}`);
    if (text(step.condition)) body.push(`   - Condição: ${text(step.condition)}`);
    for (const outcome of step.outcomes ?? []) {
      if (text(outcome)) body.push(`   - ${text(outcome)}`);
    }
    body.push(...quoteLines(step.evidence, '   '));
    body.push('');
  });

  return section('Fluxo do processo acordado', body);
}

/**
 * Nome de arquivo sugerido para a ata (usado no download e como `filename` da
 * geracao do diagrama). Sem acentos nem caracteres problematicos.
 */
export function minutesFilename(minutes: MeetingMinutes, fallback = 'ata'): string {
  const base = text(minutes.meeting?.title) || fallback;
  const slug = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return `${slug || 'ata'}.ata.md`;
}
