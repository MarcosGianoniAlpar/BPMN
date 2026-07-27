import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import BpmnModdle from 'bpmn-moddle';
import type { Linter } from 'bpmnlint';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rcPath = resolve(__dirname, '../.bpmnlintrc');

export interface LintIssue {
  rule: string;
  id?: string;
  message: string;
  category: 'error' | 'warn' | 'info';
}

export interface LintResult {
  issues: LintIssue[];
  errors: number;
  warnings: number;
}

// Formato bruto do relatorio do bpmnlint: { [rule]: [{ id, message, category }] }.
interface RawReport {
  id?: string;
  message: string;
  category: 'error' | 'warn' | 'info';
}

const EMPTY: LintResult = { issues: [], errors: 0, warnings: 0 };

// undefined = ainda nao tentou; null = tentou e falhou (nao tenta de novo).
let cachedLinter: Linter | null | undefined;

/**
 * Carrega o bpmnlint sob demanda (import dinamico) e tolera falha de carga.
 * Motivo: o bpmnlint (CommonJS) faz `require()` do `min-dash`, hoje um pacote
 * so-ESM. O Node local (v22+) suporta `require(esm)`, mas o runtime serverless
 * do Vercel NAO — la o import quebraria. Como o lint e diagnostico e nao
 * bloqueia a geracao, se ele nao carregar seguimos sem lint.
 */
async function getLinter(): Promise<Linter | null> {
  if (cachedLinter !== undefined) return cachedLinter;
  try {
    const { Linter } = await import('bpmnlint');
    // O node-resolver e CJS; sob NodeNext o default vem no .default em runtime.
    const resolverMod = await import('bpmnlint/lib/resolver/node-resolver.js');
    const NodeResolver = ((resolverMod as { default?: unknown }).default ??
      resolverMod) as new () => unknown;
    const config = JSON.parse(readFileSync(rcPath, 'utf-8'));
    cachedLinter = new Linter({ config, resolver: new NodeResolver() });
  } catch (err) {
    console.log(
      `  AVISO: bpmnlint indisponivel neste runtime, pulando o lint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedLinter = null;
  }
  return cachedLinter;
}

/**
 * Nivel 2 de validacao: roda o bpmnlint (regras do .bpmnlintrc, que estende
 * bpmnlint:recommended) sobre o BPMN final. Diferente da validacao nivel 1
 * (validate.ts, que decide se a pipeline segue), o lint aqui e diagnostico:
 * o diagrama ja e estruturalmente valido, entao reportamos os achados sem
 * derrubar a geracao. Um 'error' de lint aqui normalmente indica bug no
 * compilador, e vale ser visto. Best-effort: qualquer falha devolve vazio.
 */
export async function lintBpmn(xml: string): Promise<LintResult> {
  const linter = await getLinter();
  if (!linter) return EMPTY;

  try {
    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(xml);
    const reports = (await linter.lint(rootElement)) as Record<string, RawReport[]>;

    const issues: LintIssue[] = [];
    for (const [rule, ruleReports] of Object.entries(reports)) {
      for (const r of ruleReports) {
        issues.push({ rule, id: r.id, message: r.message, category: r.category });
      }
    }

    // Erros antes de warnings, para leitura rapida.
    const order = { error: 0, warn: 1, info: 2 } as const;
    issues.sort((a, b) => order[a.category] - order[b.category]);

    return {
      issues,
      errors: issues.filter((i) => i.category === 'error').length,
      warnings: issues.filter((i) => i.category === 'warn').length,
    };
  } catch (err) {
    console.log(
      `  AVISO: falha ao rodar o bpmnlint, seguindo sem lint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return EMPTY;
  }
}
