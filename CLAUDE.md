# CLAUDE.md — Instruções do projeto

Convenções e acordos de trabalho para o **BPMN Pipeline** (Alpar). Este arquivo é
carregado automaticamente como contexto; siga-o.

## Regras de trabalho (importante)

### 1. Fluxo git: `dev` (Preview) → `main` (PROD)
- **Nunca commitar/pushar direto no `main`.** No Vercel, `main` é a branch de
  **Produção** (deploy automático) — o chefe vê o que está em PROD.
- Trabalhar sempre no branch **`dev`**. Push no `dev` gera um **Preview** no Vercel
  (URL separada), para validar sem afetar PROD.
- **Ir para PROD (merge `dev` → `main`) somente com aprovação explícita** do dono.

### 2. Mostrar antes de commitar
- Apresentar um **resumo/diff das mudanças ao usuário antes de commitar**. Só
  commitar (no `dev`) após o ok.

### 3. Consultar antes de gastar a API (key da empresa)
- O projeto usa a **`ANTHROPIC_API_KEY` da empresa**. Cada geração/refino chama a IA
  e **custa dinheiro da empresa**.
- **Consultar o usuário ANTES** de rodar qualquer coisa que gaste API:
  `npm run dev -- <arquivo>`, `npm run eval`, ou testar `/api/generate` /
  `/api/refine`.
- Testes **determinísticos** (compilador, layout, colorização, lint) **não gastam
  API** e podem rodar livremente.
- Acompanhar custo: rota `GET /api/usage` + painel "Uso & custo" na home.

## O que é o projeto

Pipeline que extrai um **`ProcessSpec`** (JSON com evidência) de documentos via LLM e
compila **BPMN 2.0** de forma determinística. Node/TypeScript, ESM (NodeNext).

- **Fonte da verdade = `ProcessSpec`** (Opção A). A edição pelo especialista é
  estrutural (muta o ProcessSpec → recompila). Edição livre de geometria só ao
  **"Congelar versão"** (snapshot `.bpmn`, sem re-layout).
- **Dois caminhos de layout:** com raias → `src/laneLayout.ts` (geometria própria);
  sem raias → `src/compiler.ts` + `bpmn-auto-layout`. O orchestrator escolhe por
  `hasLanes`.
- **Modo transcrição:** transcrição crua → **ata estruturada** (`MeetingMinutes`,
  IA) → Markdown (determinístico) → pipeline normal. São **duas chamadas de IA
  separadas** de propósito: o especialista revisa a ata antes da segunda, e cada
  requisição cabe no teto de 60s do Vercel Hobby.

## Comandos úteis

```bash
npm run web                             # app local (http://localhost:3000)
npm run dev -- <arquivo>                # CLI — GASTA API (pedir ok antes)
npm run dev -- <arquivo> --transcricao  # transcrição → ata → diagrama (2 chamadas)
npm run dev -- <arquivo> --so-ata       # para na ata (1 chamada)
npm run eval                            # avaliação — GASTA API (pedir ok antes)
npm run typecheck && npm run lint && npm run build
npm run typecheck:vercel    # valida as funções serverless em api/
```

## Deploy (Vercel)

- **Estático (`public/`) + funções serverless (`api/`)**; `vercel.json` com
  `framework: null`, `outputDirectory: public`, `buildCommand: vercel-build`.
- As funções `api/*.ts` importam de `../dist/*.js` (JS compilado pelo build).
- Persistência em **Supabase/Postgres** via `DATABASE_URL` (pooler 6543).
- `includeFiles` empacota deps que o tracer não detecta (`@napi-rs/canvas`, build do
  `pdfjs`). O `bpmnlint` é pulado no serverless (o `min-dash` só-ESM quebra o
  `require`); localmente funciona.

## Mapa de arquivos-chave

- `src/orchestrator.ts` — pipeline (extração → validação → compilação → layout →
  cor → lint).
- `src/httpHandlers.ts` — núcleo HTTP compartilhado (dev local + funções Vercel).
- `src/server.ts` — servidor do dev local (`npm run web`).
- `src/store.ts` — persistência Supabase/Postgres (async).
- `src/laneLayout.ts` — layout com raias/pools.
- `src/bpmnColor.ts` — colorização da DI com a paleta Alpar.
- `src/transcriptToMinutes.ts` — transcrição → ata estruturada (IA, tool use).
- `src/minutesMarkdown.ts` — ata estruturada → Markdown (determinístico).
- `src/textCleanup.ts` — mojibake e caracteres invisíveis, antes de gastar tokens.
- `public/` — frontend (index.html, app.js, styles.css); bpmn-js em `/vendor/*`.
- `prompts/` — prompts da IA (extract-process.md, refine-process.md,
  transcript-to-minutes.md).
- `docs/architecture.md` — arquitetura.
