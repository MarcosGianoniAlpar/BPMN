import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, looksLikeTranscript } from '../src/textCleanup.js';

const chr = (code: number): string => String.fromCharCode(code);

describe('cleanText — mojibake', () => {
  test('conserta UTF-8 lido como Latin-1', () => {
    // "Reunião" com os bytes UTF-8 interpretados um a um como Latin-1.
    const quebrado = 'ReuniÃ£o de planejamento';
    assert.equal(cleanText(quebrado), 'Reunião de planejamento');
  });

  test('nao mexe em texto que ja esta correto', () => {
    const ok = 'Reunião de planejamento com ações e decisões';
    assert.equal(cleanText(ok), ok);
  });

  test('desiste quando o texto tem caractere fora de um byte', () => {
    // O par de mojibake existe, mas ha tambem um caractere acima de 0xFF: os
    // bytes nao representam mais o texto inteiro, e reler tudo destruiria o
    // resto. Na duvida, nao mexer.
    const misto = `Reuni${chr(0xc3)}${chr(0xa3)}o — pauta`;
    assert.equal(cleanText(misto), misto);
  });

  test('desiste quando a releitura pioraria o texto', () => {
    // Aqui tudo cabe em bytes, mas a releitura como UTF-8 produziria U+FFFD
    // (a acentuacao ja correta de "informação" nao e sequencia UTF-8 valida).
    const misto = `Reuni${chr(0xc3)}${chr(0xa3)}o e informação`;
    assert.equal(cleanText(misto), misto);
  });
});

describe('cleanText — caracteres invisiveis e tipograficos', () => {
  test('troca espaco nao separavel por espaco comum', () => {
    assert.equal(cleanText(`Prazo${chr(0xa0)}de${chr(0xa0)}entrega`), 'Prazo de entrega');
  });

  test('remove hifen condicional e zero-width space', () => {
    assert.equal(cleanText(`pro${chr(0xad)}cesso${chr(0x200b)} novo`), 'processo novo');
  });

  test('normaliza aspas tipograficas e en dash', () => {
    assert.equal(cleanText('“aspas” e ‘simples’ – traco'), '"aspas" e \'simples\' - traco');
  });

  test('desfaz ligaduras fi/fl', () => {
    assert.equal(cleanText('conﬁrmar o ﬂuxo'), 'confirmar o fluxo');
  });
});

describe('cleanText — replacement chars', () => {
  test('blocos de 3+ viram um espaco', () => {
    assert.equal(cleanText('Ata de����Reuniao'), 'Ata de Reuniao');
  });

  test('ocorrencias isoladas sobrevivem (a IA reconstroi pelo contexto)', () => {
    // Deliberado: apagar aqui perderia informacao que o modelo consegue inferir.
    assert.equal(cleanText('Reuni�o'), 'Reuni�o');
  });
});

describe('cleanText — espacos e quebras', () => {
  test('normaliza CRLF, colapsa linhas em branco e apara as pontas', () => {
    const entrada = '\r\n\r\nPrimeira linha   \r\n\r\n\r\n\r\nSegunda linha\r\n  \r\n';
    assert.equal(cleanText(entrada), 'Primeira linha\n\nSegunda linha');
  });

  test('preserva uma linha em branco entre paragrafos', () => {
    assert.equal(cleanText('a\n\nb'), 'a\n\nb');
  });
});

describe('looksLikeTranscript', () => {
  test('reconhece marcas de tempo no inicio das linhas', () => {
    const transcricao = [
      '00:01 Bom dia a todos',
      '00:15 Vamos comecar',
      '01:02 O processo hoje e manual',
      '01:44 Precisamos automatizar',
      '02:10 Concordo',
    ].join('\n');
    assert.equal(looksLikeTranscript(transcricao), true);
  });

  test('reconhece rotulos de speaker', () => {
    const transcricao = [
      'Speaker 1: bom dia',
      'Speaker 2: bom dia',
      'Speaker 1: vamos ao processo',
      'Speaker 3: eu envio o pedido',
      'Speaker 2: e eu aprovo',
    ].join('\n');
    assert.equal(looksLikeTranscript(transcricao), true);
  });

  test('nao confunde uma ata escrita com uma transcricao', () => {
    const ata = [
      '# Ata de Reuniao',
      '',
      'Data: 24/07/2026 as 14:30',
      '',
      'O solicitante preenche o formulario e envia para a gerencia.',
      'A gerencia analisa e aprova ou reprova.',
    ].join('\n');
    assert.equal(looksLikeTranscript(ata), false);
  });
});
