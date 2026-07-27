# Handoff — continuar o BPMN Pipeline (colar no chat de amanhã)

> Cole este documento inteiro no início da conversa de amanhã. Ele dá o contexto
> pra retomar sem reler tudo.

## Contexto rápido

Projeto em `c:\Users\Micro\Documents\Alpar projetos\BPMN` (`bpmn-pipeline`):
pipeline que extrai um `ProcessSpec` (JSON com evidência) de documentos via LLM e
compila **BPMN 2.0** de forma determinística. Node/TypeScript, um único runtime.
Tem CLI (`npm run dev -- <arquivo>`) e interface web (`npm run web`,
http://localhost:3000). **Fonte da verdade = `ProcessSpec`** (Opção A): edição é
estrutural; edição livre de geometria só ao "Congelar versão".

## O que já está pronto (Fase 2 completa + extras)

Tudo com `typecheck`/`lint`/`build` limpos.

- Ingestão `.pdf`/`.docx` (`src/documentLoader.ts`) + upload no servidor.
- `bpmnlint` no pipeline (`src/lintBpmn.ts`).
- Harness de avaliação (`src/eval/`, `npm run eval [-- --cached]`).
- Persistência SQLite (`src/store.ts`, `node:sqlite`): projetos → versões
  (generated/refined/frozen). Banco em `data/bpmn.db`.
- Edição no bpmn-js **Modeler** + "Congelar versão" + export `.bpmn`/SVG/PNG.
- **Raias/pools desenhados** (`src/laneLayout.ts`) — gera a geometria (DI) própria
  quando o `ProcessSpec` tem lanes.
- **Relatório de uso/custo** (`src/pricing.ts` + painel "Uso & custo" na home):
  tokens e custo estimado (US$) por modelo.
- **Docker** escrito (`Dockerfile`, `docker-compose.yml`, `.dockerignore`) — mas
  a imagem **ainda não foi buildada** (validei só o `node dist/server.js`, que é
  o que o container roda).

## Tarefas de amanhã, em ordem

### 1. Validar o visual no navegador (FAZER PRIMEIRO)

```bash
npm run web
```
Abrir http://localhost:3000, gerar um processo e conferir:
- **Raias/pools**: gerar um processo com departamentos (ex.: Solicitante / Gestor
  / Financeiro) e ver se as faixas saem limpas, nós na raia certa, fluxo da
  esquerda pra direita. Se destoar, ajustar constantes em `src/laneLayout.ts`
  (`COL_W`, `LANE_H`, etc.).
- **Edição + Congelar**: mexer no diagrama no Modeler → "Congelar versão" →
  "Novo documento" → reabrir o processo salvo e confirmar que voltou igual.
- **Export**: baixar `.bpmn`, SVG e PNG e conferir.

### 2. NOVA TAREFA — colorir o BPMN (hoje sai preto e branco)

**Objetivo:** o diagrama gerado deve sair **colorido por tipo de elemento**, com
uma paleta alinhada à marca Alpar (o app já usa azul `#124e80`, teal `#17a99b`,
amber `#b7791f` no CSS — ver `public/styles.css`).

**Onde a cor precisa entrar (decidir a abordagem no início):**
- **Preferência: colorir na DI gerada no servidor** — assim o `.bpmn` exportado já
  sai colorido (importante pro Marcos abrir em outro lugar) e persiste no banco.
  bpmn-js lê cores da DI via atributos `bioc:fill` / `bioc:stroke` (namespace
  bpmn.io) OU `color:background-color` / `color:border-color` (extensão OMG) nos
  `<bpmndi:BPMNShape>` / `<bpmndi:BPMNEdge>`.
  - Caminho **com raias**: adicionar fill/stroke por tipo ao criar cada
    `bpmndi:BPMNShape` em `src/laneLayout.ts`.
  - Caminho **sem raias** (`bpmn-auto-layout`): o layout gera a DI sem cor —
    fazer um pós-processamento que percorre o XML/moddle e injeta a cor por
    elemento (dá pra mapear o tipo via `spec.nodes`). Ver `src/layout.ts` /
    `src/orchestrator.ts`.
- **Alternativa mais simples (mas não persiste no export):** colorir no cliente
  após `importXML`, usando `modeling.setColor(elements, { fill, stroke })` do
  bpmn-js Modeler, percorrendo o `elementRegistry` por tipo. Funciona no viewer e
  no modeler, mas o `.bpmn` baixado sai sem cor a menos que se re-exporte depois
  de colorir. Se for por esse caminho, colorir ANTES de `saveXML`.

**Paleta sugerida (ajustar ao gosto):**
| Elemento | Preenchimento | Borda |
|---|---|---|
| start_event | verde claro | verde |
| end_event | vermelho claro | vermelho |
| user_task | azul claro (`#e7eff5`) | `#124e80` |
| service_task | teal claro (`#e3f4f1`) | `#17a99b` |
| exclusive_gateway | amarelo claro (`#fdf6e3`) | `#b7791f` |
| lanes / pool | tons bem claros, alternados | cinza |

**Cuidado:** manter o resultado válido pro `bpmnlint` e pro bpmn-js (a cor é só
DI, não muda a semântica). Testar nos dois caminhos (com e sem raias) e conferir
que o export continua abrindo em https://demo.bpmn.io.

### 3. Subir o Docker (validar o container)

```bash
docker compose up -d --build
```
Abrir http://localhost:3000, gerar um processo, e testar persistência:
```bash
docker compose down && docker compose up -d
```
Se os "Processos salvos" e o "Uso & custo" continuarem lá, o volume `./data`
está certo. Se a imagem não buildar, quase sempre é `node:sqlite` (a base tem que
ser Node ≥ 22.5 — está em `node:24-*`).

### 4. Evals com documentos reais do Marcos

Pegar 3–5 `.pdf`/`.docx` reais, gerar, revisar os `ProcessSpec`, salvar os
gabaritos em `evaluations/expected/`, e rodar `npm run eval`. Cruzar com o painel
de custo pra decidir **Fable × Sonnet** de produção com dado, não achismo.

### 5. (Depois) Message flows entre pools

Único pedaço de raias/pools que ficou pra depois: desenhar as setas ligando o
pool interno aos externos (caixa-preta) em `src/laneLayout.ts`.

## Comandos úteis

```bash
npm run web                 # interface visual (validação)
npm run dev -- <arquivo>    # pipeline via CLI (.txt/.md/.pdf/.docx)
npm run eval [-- --cached]  # avaliação de qualidade
npm run typecheck && npm run lint && npm run build
docker compose up -d --build   # sobe o container
```

## Mapa dos arquivos-chave

- `src/orchestrator.ts` — encadeia extração → validação → compilação → layout → lint
- `src/laneLayout.ts` — **layout com raias/pools (onde colorir com raias)**
- `src/layout.ts` — bpmn-auto-layout (caminho sem raias)
- `src/compiler.ts` — ProcessSpec → BPMN (sem raias)
- `src/store.ts` — persistência (projetos/versões/uso)
- `src/pricing.ts` — preços por modelo (custo)
- `public/app.js` / `index.html` / `styles.css` — frontend (Modeler, cores no cliente ficariam aqui)
- `Dockerfile` / `docker-compose.yml` — container

## Lembrete

- Rotacionar a `ANTHROPIC_API_KEY` se ela já circulou em chat.
- Não migrar pra Supabase agora — só quando precisar de login/multiusuário.
