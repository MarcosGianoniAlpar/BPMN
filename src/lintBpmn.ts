import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import BpmnModdle from 'bpmn-moddle';
import { Linter } from 'bpmnlint';
// O node-resolver e CJS; sob NodeNext o default vem no .default em runtime.
import NodeResolverDefault from 'bpmnlint/lib/resolver/node-resolver.js';

const NodeResolver = NodeResolverDefault as unknown as new () => unknown;

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

let cachedLinter: Linter | undefined;

function getLinter(): Linter {
  if (cachedLinter) return cachedLinter;
  const config = JSON.parse(readFileSync(rcPath, 'utf-8'));
  cachedLinter = new Linter({ config, resolver: new NodeResolver() });
  return cachedLinter;
}

/**
 * Nivel 2 de validacao: roda o bpmnlint (regras do .bpmnlintrc, que estende
 * bpmnlint:recommended) sobre o BPMN final. Diferente da validacao nivel 1
 * (validate.ts, que decide se a pipeline segue), o lint aqui e diagnostico:
 * o diagrama ja e estruturalmente valido, entao reportamos os achados sem
 * derrubar a geracao. Um 'error' de lint aqui normalmente indica bug no
 * compilador, e vale ser visto.
 */
export async function lintBpmn(xml: string): Promise<LintResult> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const reports = (await getLinter().lint(rootElement)) as Record<string, RawReport[]>;

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
}
