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
// Guardamos uma FABRICA, nao um Linter — ver o porque logo abaixo.
let cachedFactory: (() => Linter) | null | undefined;

/**
 * Carrega o bpmnlint sob demanda (import dinamico) e tolera falha de carga.
 * Motivo: o bpmnlint (CommonJS) faz `require()` do `min-dash`, hoje um pacote
 * so-ESM. O Node local (v22+) suporta `require(esm)`, mas o runtime serverless
 * do Vercel NAO — la o import quebraria. Como o lint e diagnostico e nao
 * bloqueia a geracao, se ele nao carregar seguimos sem lint.
 *
 * O QUE FICA EM CACHE E O MODULO, NAO O LINTER. Reusar uma instancia de `Linter`
 * entre chamadas contamina o relatorio: lintando o MESMO XML quatro vezes com o
 * mesmo Linter saem 0, 6, 2 e 2 achados de `no-duplicate-sequence-flows`, todos
 * de categoria `error`, sobre um diagrama de 2 fluxos. Com um Linter novo por
 * chamada saem 0 nas quatro. O estado vive na instancia (as regras do bpmnlint
 * sao criadas uma vez por Linter e algumas acumulam em closure), e o moddle nao
 * tem nada com isso — testado separando os dois.
 *
 * Por que isso importava de verdade: o CLI faz um lint por processo e escapava,
 * mas `npm run web` e um processo longo e a lambda do Vercel fica quente. Da
 * SEGUNDA geracao em diante o app acusava fluxos duplicados que nao existem — e
 * como um `error` de lint aqui costuma significar bug no compilador, o aviso
 * mandava caçar um defeito inexistente. Criar o Linter e barato: o custo real
 * (resolver e carregar os modulos das regras) fica no cache do `require` do Node.
 */
async function getLinterFactory(): Promise<(() => Linter) | null> {
  if (cachedFactory !== undefined) return cachedFactory;
  try {
    const { Linter } = await import('bpmnlint');
    // O node-resolver e CJS; sob NodeNext o default vem no .default em runtime.
    const resolverMod = await import('bpmnlint/lib/resolver/node-resolver.js');
    const NodeResolver = ((resolverMod as { default?: unknown }).default ??
      resolverMod) as new () => unknown;
    const rc = readFileSync(rcPath, 'utf-8');
    // `config` reparseado a cada chamada: um Linter limpo com uma config que
    // outra instancia possa ter mutado nao resolveria nada.
    cachedFactory = () => new Linter({ config: JSON.parse(rc), resolver: new NodeResolver() });
  } catch (err) {
    console.log(
      `  AVISO: bpmnlint indisponivel neste runtime, pulando o lint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedFactory = null;
  }
  return cachedFactory;
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
  const criarLinter = await getLinterFactory();
  if (!criarLinter) return EMPTY;

  try {
    const linter = criarLinter();
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
