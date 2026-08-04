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

// ---- Idioma ----

/**
 * Os titulos das secoes sao escritos por codigo, nao pela IA. Como a ata sai no
 * mesmo idioma da transcricao (ver prompts/transcript-to-minutes.md), sem isto
 * um documento em ingles renderizaria com conteudo ingles sob titulos em
 * portugues.
 *
 * Idioma desconhecido cai em portugues, que e o caso comum aqui — e o schema
 * promete exatamente esse fallback.
 */
interface Strings {
  minutesOf: string;
  meetingFallback: string;
  date: string;
  objective: string;
  source: string;
  sourceValue: string;
  context: string;
  participants: string;
  participant: string;
  role: string;
  discussion: string;
  decisions: string;
  owner: string;
  rationale: string;
  processFlow: string;
  process: string;
  trigger: string;
  outcome: string;
  condition: string;
  actionItems: string;
  action: string;
  due: string;
  openQuestions: string;
  openQuestionsNote: string;
  actorSystem: string;
  actorExternal: string;
}

const PT: Strings = {
  minutesOf: 'Ata de Reunião —',
  meetingFallback: 'Reunião',
  date: 'Data',
  objective: 'Objetivo',
  source: 'Origem',
  sourceValue: 'transcrição da reunião, estruturada automaticamente',
  context: 'Contexto',
  participants: 'Participantes',
  participant: 'Participante',
  role: 'Papel',
  discussion: 'Discussão',
  decisions: 'Decisões',
  owner: 'Responsável',
  rationale: 'Motivo',
  processFlow: 'Fluxo do processo acordado',
  process: 'Processo',
  trigger: 'Início (o que dispara)',
  outcome: 'Fim (resultado)',
  condition: 'Condição',
  actionItems: 'Ações combinadas',
  action: 'Ação',
  due: 'Prazo',
  openQuestions: 'Pontos em aberto',
  openQuestionsNote: 'Não foram definidos na reunião — não devem ser assumidos no diagrama.',
  actorSystem: 'executado por sistema',
  actorExternal: 'organização externa',
};

const EN: Strings = {
  minutesOf: 'Meeting Minutes —',
  meetingFallback: 'Meeting',
  date: 'Date',
  objective: 'Objective',
  source: 'Source',
  sourceValue: 'meeting transcript, structured automatically',
  context: 'Context',
  participants: 'Participants',
  participant: 'Participant',
  role: 'Role',
  discussion: 'Discussion',
  decisions: 'Decisions',
  owner: 'Owner',
  rationale: 'Rationale',
  processFlow: 'Agreed process flow',
  process: 'Process',
  trigger: 'Start (trigger)',
  outcome: 'End (outcome)',
  condition: 'Condition',
  actionItems: 'Action items',
  action: 'Action',
  due: 'Due',
  openQuestions: 'Open questions',
  openQuestionsNote: 'Not settled in the meeting — must not be assumed in the diagram.',
  actorSystem: 'performed by a system',
  actorExternal: 'external organization',
};

const STRINGS: Record<string, Strings> = { pt: PT, en: EN };

function stringsFor(language: string | undefined): Strings {
  const code = text(language).slice(0, 2).toLowerCase();
  return STRINGS[code] ?? PT;
}

/** Etiqueta do executor que ajuda o extrator a montar raias e pools. */
function actorLabel(s: Strings, actorType: string | undefined): string | undefined {
  if (actorType === 'sistema') return s.actorSystem;
  if (actorType === 'externo') return s.actorExternal;
  return undefined;
}

// ---- Render ----

export function renderMinutesMarkdown(minutes: MeetingMinutes): string {
  const lines: string[] = [];

  // Cabecalho. A IA costuma ja devolver um titulo do tipo "Reuniao semanal —
  // ..."; so prefixamos "Ata de Reuniao" quando o titulo nao se anuncia sozinho.
  const meeting = minutes.meeting ?? { title: '' };
  const s = stringsFor(meeting.language);
  const title = text(meeting.title) || s.meetingFallback;
  const selfTitled = /\b(ata|reuni[aã]o|meeting|minutes)\b/i.test(title);
  lines.push(`# ${selfTitled ? title : `${s.minutesOf} ${title}`}`, '');

  const header: string[] = [];
  if (text(meeting.date)) header.push(`- **${s.date}:** ${text(meeting.date)}`);
  if (text(meeting.objective)) header.push(`- **${s.objective}:** ${text(meeting.objective)}`);
  header.push(`- **${s.source}:** ${s.sourceValue}`);
  lines.push(...header, '');

  if (text(meeting.context)) {
    lines.push(`## ${s.context}`, '', text(meeting.context), '');
  }

  // Participantes
  const participants = minutes.participants ?? [];
  if (participants.length) {
    lines.push(
      ...section(s.participants, [
        `| ${s.participant} | ${s.role} |`,
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
    lines.push(...section(s.discussion, body));
  }

  // Decisoes
  const decisions = minutes.decisions ?? [];
  if (decisions.length) {
    const body: string[] = [];
    decisions.forEach((d, i) => {
      body.push(`### D${i + 1}. ${text(d.description)}`, '');
      if (text(d.owner)) body.push(`- **${s.owner}:** ${text(d.owner)}`);
      if (text(d.rationale)) body.push(`- **${s.rationale}:** ${text(d.rationale)}`);
      if (text(d.owner) || text(d.rationale)) body.push('');
      const quotes = quoteLines(d.evidence);
      if (quotes.length) body.push(...quotes, '');
    });
    lines.push(...section(s.decisions, body));
  }

  // Fluxo do processo — a secao que alimenta o diagrama BPMN
  lines.push(...renderProcessFlow(minutes, s));

  // Acoes combinadas
  const actions = minutes.action_items ?? [];
  if (actions.length) {
    lines.push(
      ...section(s.actionItems, [
        `| # | ${s.action} | ${s.owner} | ${s.due} |`,
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
      ...section(s.openQuestions, [
        `_${s.openQuestionsNote}_`,
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

function renderProcessFlow(minutes: MeetingMinutes, s: Strings): string[] {
  const flow = minutes.process_flow;
  const steps = flow?.steps ?? [];
  if (!flow || !steps.length) return [];

  const body: string[] = [];
  if (text(flow.name)) body.push(`**${s.process}:** ${text(flow.name)}`, '');
  if (text(flow.objective)) body.push(`**${s.objective}:** ${text(flow.objective)}`, '');
  if (text(flow.trigger)) body.push(`**${s.trigger}:** ${text(flow.trigger)}`, '');
  if (text(flow.outcome)) body.push(`**${s.outcome}:** ${text(flow.outcome)}`, '');

  steps.forEach((step, i) => {
    const label = actorLabel(s, step.actor_type);
    const suffix = label ? ` _(${label})_` : '';
    body.push(`${i + 1}. **${text(step.actor)}**${suffix} — ${text(step.action)}`);
    if (text(step.condition)) body.push(`   - ${s.condition}: ${text(step.condition)}`);
    for (const outcome of step.outcomes ?? []) {
      if (text(outcome)) body.push(`   - ${text(outcome)}`);
    }
    body.push(...quoteLines(step.evidence, '   '));
    body.push('');
  });

  return section(s.processFlow, body);
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
