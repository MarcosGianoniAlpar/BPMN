import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMinutesMarkdown, minutesFilename } from '../src/minutesMarkdown.js';
import type { MeetingMinutes } from '../src/types/meeting-minutes.js';

function ata(patch: Partial<MeetingMinutes> = {}): MeetingMinutes {
  return {
    meeting: { title: 'Reunião semanal de operações', date: '24/07/2026' },
    participants: [
      { name: 'Marcos', role: 'Gerência' },
      { name: 'Speaker 2' },
    ],
    topics: [
      {
        title: 'Mudanças emergenciais',
        summary: 'O time revisou como uma mudança urgente entra em produção.',
        evidence: ['hoje é tudo no grito — Speaker 2, 00:04:11'],
      },
    ],
    process_flow: {
      name: 'Mudança emergencial',
      trigger: 'Incidente aberto',
      outcome: 'Mudança publicada',
      steps: [
        {
          actor: 'Analista',
          action: 'Abrir o chamado de emergência',
          evidence: ['a gente abre o chamado — Marcos, 00:06:02'],
        },
        {
          actor: 'Gerência',
          action: 'Avaliar o risco',
          condition: 'Chamado classificado como crítico',
          outcomes: ['Se aprovado então publicar', 'Se reprovado então agendar'],
        },
        { actor: 'Esteira de deploy', action: 'Publicar em produção', actor_type: 'sistema' },
      ],
    },
    ...patch,
  };
}

describe('renderMinutesMarkdown — cabecalho', () => {
  test('nao duplica "Ata de Reunião" quando o titulo ja se anuncia', async () => {
    const md = renderMinutesMarkdown(ata());
    assert.match(md, /^# Reunião semanal de operações/);
    assert.ok(!md.includes('Ata de Reunião — Reunião'));
  });

  test('prefixa quando o titulo nao se anuncia sozinho', () => {
    const md = renderMinutesMarkdown(ata({ meeting: { title: 'Mudanças emergenciais' } }));
    assert.match(md, /^# Ata de Reunião — Mudanças emergenciais/);
  });

  test('registra a origem automatica do documento', () => {
    // Honestidade sobre a procedencia: quem le a ata precisa saber que ela foi
    // estruturada por maquina a partir de uma transcricao.
    assert.match(renderMinutesMarkdown(ata()), /\*\*Origem:\*\*.*transcrição/);
  });
});

describe('renderMinutesMarkdown — idioma', () => {
  // A ata sai no idioma da transcricao (ver prompts/transcript-to-minutes.md),
  // mas os TITULOS das secoes sao escritos por codigo. Sem `meeting.language`,
  // uma reuniao em ingles renderizava conteudo ingles sob titulos portugueses.
  const emIngles = (patch: Partial<MeetingMinutes> = {}) =>
    ata({
      meeting: { title: 'Emergency change process', language: 'en' },
      ...patch,
    });

  test('titulos em ingles quando a ata declara language: "en"', () => {
    const md = renderMinutesMarkdown(emIngles());
    assert.match(md, /^# Meeting Minutes — Emergency change process/);
    assert.match(md, /## Participants/);
    assert.match(md, /## Agreed process flow/);
    assert.match(md, /\*\*Source:\*\*/);
    assert.ok(!md.includes('## Participantes'), 'nao deve sobrar titulo em portugues');
    assert.ok(!md.includes('Fluxo do processo acordado'));
  });

  test('a etiqueta de ator tambem acompanha o idioma', () => {
    // "Esteira de deploy (executado por sistema)" nao pode aparecer numa ata em
    // ingles: e o extrator que le essa etiqueta para montar as raias.
    const md = renderMinutesMarkdown(emIngles());
    assert.match(md, /performed by a system/);
    assert.ok(!md.includes('executado por sistema'));
  });

  test('idioma ausente ou desconhecido cai em portugues', () => {
    // O fallback que o schema promete. Ata antiga, salva antes deste campo
    // existir, tem de continuar renderizando igual.
    for (const language of [undefined, '', 'tlh']) {
      const md = renderMinutesMarkdown(
        ata({ meeting: { title: 'Mudanças emergenciais', language } }),
      );
      assert.match(md, /## Participantes/, `language=${String(language)}`);
    }
  });
});

describe('renderMinutesMarkdown — secoes', () => {
  test('monta a tabela de participantes', () => {
    const md = renderMinutesMarkdown(ata());
    assert.match(md, /## Participantes/);
    assert.match(md, /\| Marcos \| Gerência \|/);
  });

  test('participante sem papel usa travessao em vez de celula vazia', () => {
    assert.match(renderMinutesMarkdown(ata()), /\| Speaker 2 \| — \|/);
  });

  test('escapa a barra vertical que quebraria a tabela', () => {
    const md = renderMinutesMarkdown(
      ata({ participants: [{ name: 'Compras | Suprimentos', role: 'Área' }] }),
    );
    assert.match(md, /Compras \\\| Suprimentos/);
  });

  test('omite secoes vazias em vez de deixar titulo orfao', () => {
    const md = renderMinutesMarkdown(ata({ topics: [], decisions: [], action_items: [] }));
    assert.ok(!md.includes('## Discussão'));
    assert.ok(!md.includes('## Decisões'));
    assert.ok(!md.includes('## Ações combinadas'));
  });

  test('avisa que pontos em aberto nao devem virar suposicao no diagrama', () => {
    const md = renderMinutesMarkdown(
      ata({ open_questions: [{ question: 'Quem aprova acima de 50 mil?', reason: 'não definido' }] }),
    );
    assert.match(md, /## Pontos em aberto/);
    assert.match(md, /não devem ser assumidos no diagrama/i);
    assert.match(md, /Quem aprova acima de 50 mil\?/);
  });
});

describe('renderMinutesMarkdown — fluxo do processo', () => {
  test('numera as etapas com ator e acao', () => {
    const md = renderMinutesMarkdown(ata());
    assert.match(md, /## Fluxo do processo acordado/);
    assert.match(md, /1\. \*\*Analista\*\* — Abrir o chamado de emergência/);
  });

  test('marca o executor que e sistema (vira raia no diagrama)', () => {
    assert.match(renderMinutesMarkdown(ata()), /\*\*Esteira de deploy\*\* _\(executado por sistema\)_/);
  });

  test('escreve condicao e bifurcacoes como sub-itens', () => {
    const md = renderMinutesMarkdown(ata());
    assert.match(md, /- Condição: Chamado classificado como crítico/);
    assert.match(md, /- Se aprovado então publicar/);
    assert.match(md, /- Se reprovado então agendar/);
  });

  test('leva as citacoes junto de cada etapa', () => {
    // E isso que faz a `evidence` do ProcessSpec continuar apontando para a fala
    // real, mesmo com a ata no meio do caminho.
    assert.match(renderMinutesMarkdown(ata()), />\s*a gente abre o chamado — Marcos, 00:06:02/);
  });

  test('some com a secao quando nao ha etapa', () => {
    const md = renderMinutesMarkdown(ata({ process_flow: { name: 'Nada', steps: [] } }));
    assert.ok(!md.includes('## Fluxo do processo acordado'));
  });
});

describe('renderMinutesMarkdown — formato', () => {
  test('nunca deixa 3+ quebras seguidas e termina com uma newline', () => {
    const md = renderMinutesMarkdown(ata());
    assert.ok(!md.includes('\n\n\n'));
    assert.ok(md.endsWith('\n'));
    assert.ok(!md.endsWith('\n\n'));
  });
});

describe('minutesFilename', () => {
  test('gera slug sem acento nem caractere problematico', () => {
    assert.equal(minutesFilename(ata()), 'reuniao-semanal-de-operacoes.ata.md');
  });

  test('cai no fallback quando o titulo nao produz slug', () => {
    assert.equal(minutesFilename(ata({ meeting: { title: '???' } })), 'ata.ata.md');
  });

  test('trunca titulos muito longos', () => {
    const longo = minutesFilename(ata({ meeting: { title: 'palavra '.repeat(30) } }));
    assert.ok(longo.replace('.ata.md', '').length <= 60);
  });
});
