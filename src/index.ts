#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadConfig, type AppConfig } from './config.js';
import { descreverThinking } from './aiThinking.js';
import { loadDocumentText } from './documentLoader.js';
import { looksLikeTranscript } from './textCleanup.js';
import { estimateOutput, outputWarning } from './sizing.js';
import {
  runPipeline,
  runMinutesFromTranscript,
  ProcessSpecValidationError,
} from './orchestrator.js';

interface CliArgs {
  input: string;
  outDir: string;
  /** Trata o arquivo como transcricao: gera a ata estruturada antes do diagrama. */
  transcript: boolean;
  /** Para depois da ata (uma chamada de IA em vez de duas). */
  minutesOnly: boolean;
  /** Pula a confirmacao do documento (para script/CI). */
  yes: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let input: string | undefined;
  let outDir = 'output';
  let transcript = false;
  let minutesOnly = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--out' || a === '-o') {
      outDir = args[++i] ?? outDir;
    } else if (a === '--transcricao' || a === '--transcript') {
      transcript = true;
    } else if (a === '--so-ata' || a === '--minutes-only') {
      transcript = true;
      minutesOnly = true;
    } else if (a === '--sim' || a === '--yes' || a === '-y') {
      yes = true;
    } else if (!a.startsWith('-')) {
      input = a;
    }
  }

  if (!input) {
    throw new Error(
      'Uso: npm run dev -- <caminho-do-documento> [--out <pasta>] [--transcricao] [--so-ata] [-y]\n' +
        '  -y / --sim  pula a confirmacao do documento (cuidado: gasta direto)\n' +
        'Ex.:  npm run dev -- test-documents/ata.md\n' +
        '      npm run dev -- test-documents/reuniao.txt --transcricao  (transcricao -> ata -> diagrama)\n' +
        '      npm run dev -- test-documents/reuniao.txt --so-ata       (para na ata; 1 chamada de IA)',
    );
  }
  return { input, outDir, transcript, minutesOnly, yes };
}

/**
 * Pre-voo: mostra o que vai ser enviado e pergunta. Tudo deterministico — a
 * estimativa de tokens e uma regra de bolso (~3,5 chars/token em pt/en), boa o
 * bastante para pegar o caso que importa: escolher o arquivo errado.
 */
async function confirmarDocumento(
  input: string,
  texto: string,
  transcript: boolean,
  minutesOnly: boolean,
  config: AppConfig,
): Promise<boolean> {
  const estimativa = estimateOutput(texto, config.maxOutputTokens);
  const aviso = outputWarning(estimativa);
  const chamadas = transcript && !minutesOnly ? 2 : 1;
  const linhas = texto.split('\n').filter((l) => l.trim());

  console.log('\n--- Confirme o documento ------------------------------------');
  console.log(`  Arquivo   : ${resolve(input)}`);
  console.log(
    `  Tamanho   : ${texto.length} chars · ~${estimativa.documentTokens} tokens de entrada`,
  );
  console.log(`  Modo      : ${transcript ? 'transcricao -> ata' : 'documento -> diagrama'}`);
  console.log(`  Chamadas  : ${chamadas} chamada(s) de IA — ISTO GASTA A KEY DA EMPRESA`);
  // O modo de raciocinio muda custo E comportamento; sem ele a vista, uma rodada
  // de teste pode acontecer no modo errado e ninguem descobre pelo resultado.
  console.log(`  Raciocinio: ${descreverThinking(config)}`);
  if (aviso) console.log(`  ${estimativa.exceeds ? '!!!' : ' ! '} ${aviso}`);
  if (looksLikeTranscript(texto) !== transcript) {
    console.log(
      `  ATENCAO   : o texto ${looksLikeTranscript(texto) ? 'PARECE' : 'NAO parece'} uma ` +
        `transcricao, mas voce ${transcript ? 'usou' : 'nao usou'} --transcricao.`,
    );
  }
  console.log('  Comeco    :');
  for (const linha of linhas.slice(0, 3)) console.log(`    | ${linha.slice(0, 70)}`);
  console.log('  Fim       :');
  for (const linha of linhas.slice(-2)) console.log(`    | ${linha.slice(0, 70)}`);
  console.log('-------------------------------------------------------------');

  const resposta = await new Promise<string>((resolvePromise) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question('Enviar para a IA? [s/N] ', (r) => {
      rl.close();
      resolvePromise(r);
    });
  });
  return /^(s|sim|y|yes)$/i.test(resposta.trim());
}

async function main(): Promise<void> {
  const { input, outDir, transcript, minutesOnly, yes } = parseArgs(process.argv);
  const config = loadConfig();

  console.log(`> Lendo documento: ${input}`);
  let documentText = await loadDocumentText(input);

  // Antes de gastar: mostrar o que sera enviado. O erro caro nao e o documento
  // dificil — e o documento ERRADO, que so se descobre depois de pagar.
  if (!yes) {
    const seguir = await confirmarDocumento(
      input,
      documentText,
      transcript,
      minutesOnly,
      config,
    );
    if (!seguir) {
      console.log('Cancelado. Nenhuma chamada de IA foi feita.');
      return;
    }
  }

  console.log(`> Modelo: ${config.model} · ${descreverThinking(config)}`);
  const stageLabel: Record<string, string> = {
    minutes: 'Estruturando a ata (IA)',
    render: 'Montando a ata em Markdown',
    extract: 'Extraindo o processo (IA)',
    validate: 'Validando ProcessSpec',
    compile: 'Compilando BPMN',
    layout: 'Aplicando layout',
    lint: 'Checando com bpmnlint',
  };
  const onProgress = (u: { stage: string; status: string; detail?: string }): void => {
    const label = stageLabel[u.stage] ?? u.stage;
    if (u.status === 'start') console.log(`  ... ${label}`);
    else console.log(`  ok  ${label}${u.detail ? ` (${u.detail})` : ''}`);
  };

  await mkdir(outDir, { recursive: true });
  const stem = basename(input, extname(input));

  // Modo transcricao: primeiro a ata estruturada; ela e que vira o documento
  // de entrada do diagrama (e fica salva em disco para revisao).
  if (transcript) {
    const minutes = await runMinutesFromTranscript(documentText, config, onProgress);
    const ataPath = join(outDir, `${stem}.ata.md`);
    const ataJsonPath = join(outDir, `${stem}.ata.json`);
    await writeFile(ataPath, minutes.markdown, 'utf-8');
    await writeFile(ataJsonPath, JSON.stringify(minutes.minutes, null, 2), 'utf-8');
    console.log(`\nAta gerada:\n  ${resolve(ataPath)}\n  ${resolve(ataJsonPath)}`);
    console.log(
      `Tokens da ata: ${minutes.usage.inputTokens} entrada / ${minutes.usage.outputTokens} saida`,
    );
    if (minutesOnly) {
      console.log('\n(--so-ata) Parando aqui. Revise a ata e rode de novo sobre o .ata.md.');
      return;
    }
    documentText = minutes.markdown;
  }

  const result = await runPipeline(documentText, config, onProgress);

  // Escreve as tres saidas
  const specPath = join(outDir, `${stem}.process-spec.json`);
  const semanticPath = join(outDir, `${stem}.semantic.bpmn`);
  const bpmnPath = join(outDir, `${stem}.bpmn`);

  await writeFile(specPath, JSON.stringify(result.spec, null, 2), 'utf-8');
  await writeFile(semanticPath, result.semanticXml, 'utf-8');
  await writeFile(bpmnPath, result.layoutXml, 'utf-8');

  // Resumo
  console.log('\n=== Resultado ===');
  console.log(`Nos: ${result.spec.nodes.length} | Flows: ${result.spec.flows.length}`);
  console.log(
    `Tokens: ${result.usage.inputTokens} entrada / ${result.usage.outputTokens} saida`,
  );
  console.log(`Warnings de layout: ${result.layoutWarnings.length}`);
  if (result.specWarnings.length > 0) {
    console.log(`\n! ${result.specWarnings.length} defeito(s) consertados no ProcessSpec:`);
    for (const w of result.specWarnings) console.log(`  [${w.code}] ${w.message}`);
  }
  console.log(
    `bpmnlint: ${result.lint.errors} erro(s), ${result.lint.warnings} aviso(s)`,
  );
  if (result.lint.issues.length > 0) {
    for (const issue of result.lint.issues) {
      const tag = issue.category === 'error' ? 'ERRO ' : 'aviso';
      console.log(`  [${tag}] ${issue.rule}${issue.id ? ` (${issue.id})` : ''}: ${issue.message}`);
    }
  }

  const questions = result.spec.unresolved_questions ?? [];
  if (questions.length > 0) {
    console.log(`\n! ${questions.length} pergunta(s) de esclarecimento:`);
    questions.forEach((q, i) => {
      console.log(`  ${i + 1}. ${q.question}`);
      if (q.reason) console.log(`     motivo: ${q.reason}`);
    });
  }

  console.log('\nArquivos gerados:');
  console.log(`  ${resolve(specPath)}`);
  console.log(`  ${resolve(semanticPath)}  (sem geometria)`);
  console.log(`  ${resolve(bpmnPath)}      (com layout, abrir no bpmn-js)`);
}

main().catch((err: unknown) => {
  if (err instanceof ProcessSpecValidationError) {
    console.error(`\nFalha de validacao:\n${err.message}`);
    // A chamada foi COBRADA. Guardar o que veio transforma a proxima
    // investigacao numa leitura de arquivo, em vez de outra geracao paga.
    if (err.raw !== undefined) {
      const destino = join('output', 'ultima-falha.process-spec.json');
      void mkdir('output', { recursive: true })
        .then(() => writeFile(destino, JSON.stringify(err.raw, null, 2), 'utf-8'))
        .then(() => console.error(`\nResposta crua da IA salva em:\n  ${resolve(destino)}`))
        .catch(() => {});
    }
    if (err.usage) {
      console.error(
        `Tokens cobrados mesmo assim: ${err.usage.inputTokens} entrada / ` +
          `${err.usage.outputTokens} saida`,
      );
    }
  } else {
    console.error(`\nErro: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
