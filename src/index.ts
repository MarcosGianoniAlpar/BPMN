#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { loadDocumentText } from './documentLoader.js';
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
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let input: string | undefined;
  let outDir = 'output';
  let transcript = false;
  let minutesOnly = false;

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
    } else if (!a.startsWith('-')) {
      input = a;
    }
  }

  if (!input) {
    throw new Error(
      'Uso: npm run dev -- <caminho-do-documento> [--out <pasta>] [--transcricao] [--so-ata]\n' +
        'Ex.:  npm run dev -- test-documents/ata.md\n' +
        '      npm run dev -- test-documents/reuniao.txt --transcricao  (transcricao -> ata -> diagrama)\n' +
        '      npm run dev -- test-documents/reuniao.txt --so-ata       (para na ata; 1 chamada de IA)',
    );
  }
  return { input, outDir, transcript, minutesOnly };
}

async function main(): Promise<void> {
  const { input, outDir, transcript, minutesOnly } = parseArgs(process.argv);
  const config = loadConfig();

  console.log(`> Lendo documento: ${input}`);
  let documentText = await loadDocumentText(input);

  console.log(`> Modelo: ${config.model}`);
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
  } else {
    console.error(`\nErro: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
