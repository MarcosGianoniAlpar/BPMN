import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOutput, outputWarning } from '../src/sizing.js';

/** Documento sintetico do tamanho pedido, em caracteres. */
const doc = (chars: number): string => 'a'.repeat(chars);

describe('estimateOutput', () => {
  test('a ata de PO real cai na faixa de RISCO ALTO', () => {
    // O caso que motivou o modulo: 22965 chars, rodada real cortada em 20000
    // tokens de saida (US$ 0,34 cobrados, nada aproveitado). O aviso tem de
    // disparar ANTES da chamada.
    const e = estimateOutput(doc(22965), 20000);
    assert.equal(e.exceeds, true, `estimou ${e.estimatedOutputTokens} para um teto de 20000`);
    assert.match(outputWarning(e) ?? '', /RISCO ALTO/);
  });

  test('documento pequeno nao gera aviso', () => {
    const e = estimateOutput(doc(3000), 20000);
    assert.equal(e.exceeds, false);
    assert.equal(e.tight, false);
    assert.equal(outputWarning(e), undefined);
  });

  test('a faixa entre 80% e 100% do teto avisa sem alarmar', () => {
    // ~3430 tokens de documento -> ~13700 de saida, 69% de 20000: ainda folgado.
    assert.equal(outputWarning(estimateOutput(doc(12000), 20000)), undefined);
    // ~4570 -> ~18300, acima de 80%: margem apertada, mas nao "risco alto".
    const apertado = estimateOutput(doc(16000), 20000);
    assert.equal(apertado.tight, true);
    assert.equal(apertado.exceeds, false);
    assert.match(outputWarning(apertado) ?? '', /Margem apertada/);
  });

  test('subir o teto tira o aviso do mesmo documento', () => {
    // Confere que o teto e mesmo parametro, e nao constante escondida.
    assert.equal(estimateOutput(doc(22965), 20000).exceeds, true);
    assert.equal(estimateOutput(doc(22965), 60000).exceeds, false);
  });
});
