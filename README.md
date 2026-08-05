# bpmn-pipeline

Pipeline **LLM → BPMN**: recebe um documento de processo (ata de reuniao,
descricao de procedimento, transcricao de reuniao) e produz um diagrama
**BPMN 2.0** valido.

A ideia central: a LLM **nunca** gera XML. Ela extrai um modelo intermediario
rastreavel — o **`ProcessSpec`** (JSON com evidencia de origem e perguntas de
esclarecimento) — e um compilador **deterministico** transforma isso em BPMN.
Isso separa a interpretacao probabilistica da geracao, permitindo validar,
testar, auditar e trocar de modelo sem refazer a geometria.

> **Fonte da verdade (Opcao A):** o `ProcessSpec` e a unica fonte da verdade. A
> edicao pelo especialista e estrutural (muta o ProcessSpec → recompila,
> preservando evidencia e o loop de esclarecimento). A edicao livre de geometria
> no Modeler vira um snapshot ao **congelar uma versao** — que nao e mais
> re-layoutada ao reabrir.

## Pipeline

```
documento (.txt/.md/.pdf/.docx)
   → [modo transcricao] transcricao crua → ata estruturada  (src/transcriptToMinutes.ts)
   →                    ata estruturada  → Markdown         (src/minutesMarkdown.ts)
   → extracao factual pela LLM        (src/extractProcessSpec.ts)
   → ProcessSpec JSON com evidencias  (schemas/process-spec.schema.json)
   → validacao (schema + semantica)   (src/validate.ts)          [nivel 1]
   → compilador deterministico        (src/compiler.ts / src/laneLayout.ts)
   → layout automatico                (src/layout.ts / src/laneLayout.ts)
   → colorizacao (paleta Alpar)       (src/bpmnColor.ts)
   → bpmnlint                         (src/lintBpmn.ts)          [nivel 2]
   → .bpmn pronto para o bpmn-js
```

**Dois caminhos de layout.** Com raias, o `src/laneLayout.ts` gera a geometria
propria (pool, faixas, rotulos de aresta). Sem raias, `src/compiler.ts` +
`bpmn-auto-layout`. O orquestrador escolhe por `hasLanes`.

## Requisitos

- Node.js >= 22.5
- Uma chave de API Anthropic (`ANTHROPIC_API_KEY`)
- Um Postgres (Supabase) em `DATABASE_URL` — so para a interface web

## Setup

```bash
npm install
cp .env.example .env      # e preencha ANTHROPIC_API_KEY (e DATABASE_URL)
```

O modelo padrao e `claude-sonnet-5`. Todos os parametros ajustaveis (modelo,
teto de tokens, limites de uso, banco) estao comentados no `.env.example`.

## Interface web

```bash
npm run web    # http://localhost:3000
```

Duas portas de entrada, em abas:

1. **Ata ou documento → diagrama** — arraste um `.txt`/`.md`/`.pdf`/`.docx`.
2. **Transcricao → ata → diagrama** — para transcricao de reuniao (fala solta,
   ruido, encoding ruim). A IA produz uma **ata estruturada**, o especialista
   **revisa na tela**, e so entao o diagrama e gerado.

A tela do diagrama:

- renderiza o **BPMN** com o `bpmn-js` **Modeler** (zoom/pan e **edicao**);
- lista cada **elemento com a evidencia** (o trecho do documento que o originou)
  — clicar destaca o elemento no diagrama, e vice-versa;
- mostra a **validacao BPMN** (avisos/erros do `bpmnlint`);
- mostra as **perguntas de esclarecimento** que a IA nao resolveu sozinha — e
  permite **responde-las na propria tela**: as respostas voltam para a IA, que
  revisa o `ProcessSpec` e o diagrama e recompilado (loop de esclarecimento);
- **salva automaticamente** cada geracao/revisao como uma **versao** do projeto;
- permite **"Congelar versao"** (snapshot com as edicoes manuais de geometria,
  que nao e mais re-layoutado);
- exporta **.bpmn / SVG / PNG** (com as cores da paleta);
- exibe o **custo** da geracao e o acumulado (painel "Uso & custo").

## CLI

```bash
npm run dev -- <arquivo>                # documento -> diagrama
npm run dev -- <arquivo> --transcricao  # transcricao -> ata -> diagrama (2 chamadas)
npm run dev -- <arquivo> --so-ata       # para na ata (1 chamada)
```

Gera, em `output/`:

| Arquivo | Conteudo |
|---|---|
| `*.process-spec.json` | o modelo intermediario extraido (olhe este primeiro) |
| `*.semantic.bpmn` | BPMN sem geometria (so estrutura) |
| `*.bpmn` | BPMN com layout — abra no [bpmn.io](https://demo.bpmn.io) ou no bpmn-js |
| `*.ata.md` / `*.ata.json` | a ata estruturada (modo transcricao) |

> Dica de fluxo: valide o `*.process-spec.json` a olho **antes** de se importar
> com o diagrama. E na extracao que moram os erros, e e mais barato corrigi-los
> ali do que depois de virar XML.

## Custo e limites de uso

A chave da API e da empresa e **a aplicacao no ar e publica**. Duas defesas, as
duas configuraveis no `.env`:

- **`RATE_LIMIT_PER_IP_HOUR`** — contem o abuso de um visitante.
- **`RATE_LIMIT_GLOBAL_PER_DAY`** — e este que poe teto na **fatura**; trocar de
  IP e trivial, entao o limite por IP sozinho nao limita gasto nenhum.

O contador vive numa tabela do Postgres (`rate_limit`), nao em memoria: em
serverless nao ha processo de longa duracao para guardar estado. O consumo
acumulado fica em `GET /api/usage` e no painel "Uso & custo" da home.

**Ao desenvolver:** `npm run dev`, `npm run eval` e as rotas `/api/generate`,
`/api/minutes` e `/api/refine` gastam dinheiro real. Testes deterministicos
(`npm test`, typecheck, lint, build) **nao gastam nada**.

## Scripts

```bash
npm run web                  # interface web em http://localhost:3000
npm run dev -- <arquivo>     # pipeline pela CLI — GASTA API
npm run eval                 # avalia a extracao contra os gabaritos — GASTA API
npm test                     # suite deterministica (node:test) — nao gasta API
npm run test:watch           # a suite em modo watch
npm run typecheck            # tipos de src/
npm run typecheck:test       # tipos de test/
npm run typecheck:vercel     # compila e checa as funcoes serverless de api/
npm run lint                 # eslint
npm run lint:bpmn -- output/exemplo.bpmn   # bpmnlint em um .bpmn
npm run format               # prettier
npm run gen:types            # regenera os tipos a partir dos schemas
npm run backup               # dump do Postgres em backups/ (precisa de pg_dump)
```

## Testes

A suite cobre a **metade deterministica** do pipeline — que e o ponto da
arquitetura: se a LLM so produz o `ProcessSpec`, tudo depois dele e testavel sem
gastar um centavo de API.

```bash
npm test
```

Coberto hoje: validacao (schema + regras semanticas), os dois compiladores
(com e sem raias), geometria do layout de raias (posicao por camada/faixa,
voltas roteadas por baixo, rotulos fora da linha), colorizacao, render da ata em
Markdown, limpeza de texto e estimativa de custo. Os testes usam `ProcessSpec`
sinteticos de `test/fixtures.ts` — **nenhum chama a IA**.

O CI (`.github/workflows/ci.yml`) roda typecheck, lint, a suite e o build a cada
push e em todo PR para `main`.

## Estrutura

```
bpmn-pipeline/
├── src/
│   ├── index.ts               # CLI
│   ├── server.ts              # servidor do dev local (npm run web)
│   ├── httpHandlers.ts        # nucleo HTTP compartilhado (dev local + Vercel)
│   ├── orchestrator.ts        # extracao -> validacao -> compilacao -> layout -> cor -> lint
│   ├── documentLoader.ts      # le/extrai texto (.txt/.md/.pdf/.docx)
│   ├── textCleanup.ts         # mojibake e caracteres invisiveis (antes de gastar tokens)
│   ├── transcriptToMinutes.ts # transcricao crua -> ata estruturada (IA, tool use)
│   ├── minutesMarkdown.ts     # ata estruturada -> Markdown (deterministico)
│   ├── extractProcessSpec.ts  # chamada a LLM -> ProcessSpec (tool use forcado)
│   ├── refineProcessSpec.ts   # segunda passada (loop de esclarecimento)
│   ├── validate.ts            # schema JSON + regras semanticas (nivel 1)
│   ├── compiler.ts            # ProcessSpec -> BPMN XML, sem raias
│   ├── layout.ts              # bpmn-auto-layout (processos planos)
│   ├── laneLayout.ts          # layout ciente de raias/pools (gera DI proprio)
│   ├── bpmnNodes.ts           # traducao tipo do spec -> elemento BPMN (um lugar so)
│   ├── bpmnColor.ts           # colorizacao da DI com a paleta Alpar
│   ├── lintBpmn.ts            # bpmnlint programatico (nivel 2)
│   ├── store.ts               # persistencia Postgres (projetos, versoes, uso, rate limit)
│   ├── pricing.ts             # tabela de precos -> custo estimado
│   ├── eval/                  # harness de avaliacao (runner + comparador)
│   └── types/                 # tipos gerados dos schemas
├── api/                       # funcoes serverless do Vercel (importam de dist/)
├── test/                      # suite deterministica + fixtures
├── schemas/                   # process-spec e meeting-minutes (fonte da verdade)
├── prompts/                   # prompts de extracao, refino e ata
├── public/                    # frontend (Modeler, evidencias, versoes)
├── scripts/                   # copy-vendor, backup-db
├── evaluations/               # gabaritos + relatorios
├── test-documents/            # documentos reais (nao versionados)
└── docs/                      # arquitetura, regras de mapeamento, proximos passos
```

## Deploy

Vercel: estatico (`public/`) + funcoes serverless (`api/`), com `framework: null`
e `outputDirectory: public`. Persistencia em Supabase/Postgres pelo pooler de
transacao (6543). O `includeFiles` do `vercel.json` empacota o que o tracer nao
detecta (`@napi-rs/canvas`, build legacy do `pdfjs`, `schemas/`, `prompts/`).

**Branches:** `dev` gera Preview; `main` e **producao** (deploy automatico). Ver
`CLAUDE.md` para as regras de trabalho.

> **Teto de 60s.** No plano Hobby cada funcao morre em 60s (o `maxDuration=300`
> do codigo e capado). Por isso o modo transcricao e **duas chamadas separadas**:
> encadear ata + diagrama numa requisicao so estouraria o limite.

## Backup

O plano free do Supabase **nao faz backup automatico**.

```bash
npm run backup             # dump completo em backups/
npm run backup -- --so-dados
```

Precisa do `pg_dump` no PATH. O script troca a porta 6543 (pooler de transacao,
onde o `pg_dump` nao opera) por 5432 automaticamente. A pasta `backups/` esta no
`.gitignore`: **guarde uma copia fora do Supabase**.

## Escopo

Suportado: start/end event, user task, service task, **exclusive gateway**,
**parallel gateway**, **evento intermediario de timer e de mensagem**, sequence
flow, **raias e pools desenhados** (participante externo vira pool caixa-preta),
perguntas de esclarecimento e evidencia por elemento.

Fora do escopo (proximas fases): **message flows entre pools**, inclusive
gateways, boundary events, subprocessos, multiplos documentos, correcao
automatica via JSON Patch, OCR de PDF escaneado.

A visao completa (API Python, servico BPMN separado, fila, banco vetorial, infra
GCP) esta em `docs/architecture.md`; o que vem a seguir, em
`docs/proximos-passos-amanha.md`.
