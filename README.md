# bpmn-pipeline

Pipeline **LLM → BPMN**: recebe um documento de processo (ata de reuniao,
descricao de procedimento) e produz um diagrama **BPMN 2.0** valido.

A ideia central: a LLM **nunca** gera XML. Ela extrai um modelo intermediario
rastreavel — o **`ProcessSpec`** (JSON com evidencia de origem e perguntas de
esclarecimento) — e um compilador **deterministico** transforma isso em BPMN.
Isso separa a interpretacao probabilistica da geracao, permitindo validar,
testar, auditar e trocar de modelo sem refazer a geometria.

Estado atual: **Fase 2** — sobre o MVP da Fase 1, agora com ingestao de
`.pdf`/`.docx`, validacao com `bpmnlint` no pipeline, harness de avaliacao,
**persistencia de projetos e versoes** (SQLite), **edicao no bpmn-js Modeler**
com "congelar versao", e **raias/pools desenhados**. A visao completa (API
Python, servico BPMN separado, fila, OCR, banco vetorial, infra GCP) esta em
`docs/architecture.md`.

> **Fonte da verdade (Opcao A):** o `ProcessSpec` e a unica fonte da verdade. A
> edicao pelo especialista e estrutural (muta o ProcessSpec → recompila,
> preservando evidencia e o loop de esclarecimento). A edicao livre de geometria
> no Modeler vira um snapshot ao **congelar uma versao** — que nao e mais
> re-layoutada ao reabrir.

## Pipeline

```
documento (.txt/.md/.pdf/.docx)
   → extracao factual pela LLM        (src/extractProcessSpec.ts)
   → ProcessSpec JSON com evidencias  (schemas/process-spec.schema.json)
   → validacao (schema + semantica)   (src/validate.ts)          [nivel 1]
   → compilador deterministico        (src/compiler.ts  ->  bpmn-moddle)
   → layout automatico                (src/layout.ts / src/laneLayout.ts)
   → bpmnlint                         (src/lintBpmn.ts)          [nivel 2]
   → .bpmn pronto para o bpmn-js
```

## Requisitos

- Node.js >= 20
- Uma chave de API Anthropic (`ANTHROPIC_API_KEY`)

## Setup

```bash
npm install
cp .env.example .env      # e preencha ANTHROPIC_API_KEY
```

O modelo padrao e `claude-sonnet-5` (melhor custo/qualidade para extracao
estruturada). Para comparar, troque `ANTHROPIC_MODEL` no `.env` por
`claude-fable-5` ou `claude-opus-4-8`.

## Uso

```bash
npm run dev -- test-documents/exemplo-solicitacao-compra.md
```

Isso gera, em `output/`:

| Arquivo | Conteudo |
|---|---|
| `*.process-spec.json` | o modelo intermediario extraido (olhe este primeiro) |
| `*.semantic.bpmn` | BPMN sem geometria (so estrutura) |
| `*.bpmn` | BPMN com layout automatico — abra no [bpmn.io](https://demo.bpmn.io) ou no bpmn-js |

E imprime no terminal: contagem de nos/flows, tokens usados, warnings de layout
e as **perguntas de esclarecimento** que a IA nao resolveu sozinha.

> Dica de fluxo: valide o `*.process-spec.json` a olho **antes** de se importar
> com o diagrama. E na extracao que moram os erros, e e mais barato corrigi-los
> ali do que depois de virar XML.

## Interface visual (MVP para demonstrar)

Uma interface web que renderiza o diagrama, as evidências e as perguntas —
ideal para mostrar como MVP.

```bash
npm run web
```

Abra `http://localhost:3000`, arraste uma ata `.txt`/`.md`/`.pdf`/`.docx` e ela:

- roda o mesmo pipeline (extração → validação → compilação → layout → bpmnlint);
- renderiza o **BPMN** com o `bpmn-js` **Modeler** (zoom/pan e **edição**);
- lista cada **elemento com a evidência** (o trecho da ata que o originou) —
  clicar destaca o elemento no diagrama, e vice-versa;
- mostra a **validação BPMN** (avisos/erros do `bpmnlint`);
- mostra as **perguntas de esclarecimento** que a IA não resolveu sozinha —
  e permite **respondê-las na própria tela**: ao clicar em "Aplicar respostas
  e recompilar", as respostas voltam para a IA, que revisa o `ProcessSpec`
  (cria as ramificações que faltavam, remove as perguntas respondidas) e o
  diagrama é recompilado já completo (loop de esclarecimento);
- **salva automaticamente** cada geração/revisão como uma **versão** do projeto;
  a home lista os **processos salvos** para reabrir/excluir;
- permite **editar o diagrama** e **"Congelar versão"** (snapshot com as edições
  manuais, que não é mais re-layoutado);
- exporta **.bpmn / SVG / PNG**;
- exibe métricas (nós, fluxos, perguntas, tokens).

Servida localmente (Node + `bpmn-js` do `node_modules`) — sem CDN, funciona
offline. Persiste em `data/bpmn.db` (SQLite nativo do Node ≥ 22.5). Precisa da
`ANTHROPIC_API_KEY` no `.env`, como o CLI.

## Scripts

```bash
npm run dev -- <arquivo>   # roda o pipeline (CLI) — aceita .txt/.md/.pdf/.docx
npm run web                # sobe a interface visual em http://localhost:3000
npm run eval               # avalia a extração contra os gabaritos (evaluations/)
npm run eval -- --cached   # avalia sem chamar a IA (usa output/ já gerado)
npm run build              # compila TypeScript para dist/
npm run typecheck          # checagem de tipos sem emitir
npm run gen:types          # regenera src/types/process-spec.ts a partir do schema
npm run lint               # eslint
npm run lint:bpmn -- output/exemplo-solicitacao-compra.bpmn   # bpmnlint em um .bpmn
npm run format             # prettier
```

## Estrutura

```
bpmn-pipeline/
├── src/
│   ├── index.ts               # CLI
│   ├── server.ts              # servidor web + API (gerar/refinar/projetos/freeze)
│   ├── orchestrator.ts        # encadeia extracao -> validacao -> compilacao -> layout -> lint
│   ├── documentLoader.ts      # le/extrai texto (.txt/.md/.pdf/.docx)
│   ├── extractProcessSpec.ts  # chamada a LLM -> ProcessSpec bruto
│   ├── refineProcessSpec.ts   # segunda passada (loop de esclarecimento)
│   ├── validate.ts            # schema JSON + regras semanticas (nivel 1)
│   ├── compiler.ts            # ProcessSpec -> BPMN XML (bpmn-moddle), sem raias
│   ├── layout.ts              # bpmn-auto-layout (greenfield, processos planos)
│   ├── laneLayout.ts          # layout ciente de raias/pools (gera DI proprio)
│   ├── lintBpmn.ts            # bpmnlint programatico (nivel 2)
│   ├── store.ts               # persistencia SQLite (projetos + versoes)
│   ├── eval/                  # harness de avaliacao (runner + comparador)
│   ├── config.ts              # config via .env
│   └── types/process-spec.ts  # tipos gerados do schema
├── schemas/process-spec.schema.json   # fonte da verdade do modelo
├── prompts/                           # prompts de extracao e refinamento
├── public/                            # frontend (Modeler, evidencias, versoes)
├── evaluations/                       # gabaritos + relatorios de avaliacao
├── test-documents/                    # atas reais (nao versionadas)
├── data/                              # banco SQLite local (nao versionado)
├── output/                            # saidas geradas
└── docs/
```

## Escopo

Suportado: start/end event, user task, service task, exclusive gateway,
sequence flow, perguntas de esclarecimento, evidencia por elemento.

**Raias/pools desenhados:** quando o `ProcessSpec` tem `lanes`, o diagrama usa um
layout ciente de raias (`src/laneLayout.ts`) que gera a geometria (DI) das faixas
e do pool — X pela camada do fluxo, Y pela raia — em vez do `bpmn-auto-layout`
(que so posiciona o fluxo plano). Participantes externos viram pools caixa-preta.
Processos sem raias continuam pelo caminho `compiler.ts` + `bpmn-auto-layout`.

Fora do escopo (proximas fases): parallel/inclusive gateways, timers, boundary
events, **message flows entre pools**, subprocessos, multiplos documentos,
correcao automatica via JSON Patch, OCR de PDF escaneado.

## Proximos passos imediatos

- [ ] Rodar contra 3–5 documentos reais e revisar os `ProcessSpec` a mao,
      salvando os gabaritos em `evaluations/expected/`.
- [ ] Comparar qualidade Fable 5 × Sonnet com `npm run eval` e decidir o modelo.
- [ ] Message flows entre pools (interno ↔ externo) no layout de raias.
