# Handoff — continuar o BPMN Pipeline (colar no novo chat)

> Cole este documento inteiro no início da próxima conversa. Ele dá o contexto
> pra retomar sem reler tudo.

## Contexto rápido

Projeto em `c:\Users\Micro\Documents\Alpar projetos\BPMN` (`bpmn-pipeline`,
repo `github.com/pedrofamaral/BPMN`): pipeline que extrai um `ProcessSpec` (JSON
com evidência) de documentos via LLM e compila **BPMN 2.0** de forma
determinística. Node/TypeScript. **Fonte da verdade = `ProcessSpec`** (Opção A):
edição é estrutural; edição livre de geometria só ao "Congelar versão".

**Decisão de deploy:** vai para o **Vercel** (restrição de trabalho), apesar do
fit ruim (é um servidor contínuo + chamadas de IA de ~1 min). Por isso a migração
em 3 frentes abaixo.

## O que já está pronto

Tudo com `typecheck`/`lint`/`build` limpos, no GitHub.

- Fase 2 completa: ingestão `.pdf`/`.docx`, `bpmnlint` no pipeline, evals
  (`npm run eval`), edição no Modeler + "Congelar versão", **raias/pools
  desenhados** (`src/laneLayout.ts`), export `.bpmn`/SVG/PNG.
- Relatório de **uso/custo** (`src/pricing.ts` + painel na home).
- **✅ Frente 1 do Vercel — banco migrado para Supabase (Postgres):**
  `src/store.ts` reescrito com a lib `postgres`, conexão via `DATABASE_URL`
  (pooler Transaction do Supabase, porta 6543, `prepare:false`, `ssl:'require'`),
  schema auto-criado on-connect. Todas as funções viraram `async`; `server.ts`
  ajustado. **Testado e validado** (smoke test + app real gravando no Supabase).

## O que falta — Deploy no Vercel

### Frente 2 — Servidor → funções serverless (o trabalho principal)

O `src/server.ts` é um `http.createServer` contínuo; o Vercel **não roda isso**.
Precisa:
- Criar funções em **`api/`** (uma por rota): `api/generate.ts`, `api/refine.ts`,
  `api/extract-text.ts`, `api/usage.ts`, `api/projects/[...].ts`,
  `api/projects/[id]/freeze.ts`. Reaproveitam `orchestrator.ts` e `store.ts`
  (que já estão prontos e async).
- **Empacotar os assets do bpmn-js dentro de `public/`** — hoje o servidor os
  serve de `node_modules/bpmn-js/dist` (`/vendor/bpmn-modeler.js` e
  `/vendor/assets/*`), que não existe no estático do Vercel. Copiar o
  `bpmn-modeler.production.min.js` e a pasta `assets/` para `public/vendor/` (via
  script de build) e ajustar os caminhos no `public/index.html`.
- `vercel.json` com a config de build/rotas.
- **Streaming + `maxDuration`**: `/api/generate` e `/api/refine` usam streaming
  NDJSON e levam ~1 min — configurar `export const maxDuration = 300` (ou o teto
  do plano) e confirmar que o streaming funciona na função serverless.
- **Manter o `server.ts` para dev local** (`npm run web`) — as funções `api/`
  são só para o Vercel. As duas camadas compartilham `store`/`orchestrator`.

### Frente 3 — Plano Vercel Pro (timeouts)

A extração leva ~1 min. Hobby corta em ~60s; **Pro** permite `maxDuration` até
300s. Provavelmente exige o plano **Pro** do Vercel. (O Supabase pode ficar no
**free** — NANO/0.5 GB dá conta.)

### Configuração no Vercel (você faz na conta)

- New Project → conectar o repo `pedrofamaral/BPMN`.
- **Environment Variables:** `DATABASE_URL` (a mesma do `.env`, pooler 6543),
  `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `MAX_OUTPUT_TOKENS`.
- Plano **Pro** pelos timeouts.

## Outras pendências (independentes do deploy)

Podem ser feitas antes ou depois do Vercel:
- **Colorir o BPMN** (hoje sai preto e branco) — colorir na DI gerada no servidor
  (`src/laneLayout.ts` para o caminho com raias; pós-processar o XML do
  `bpmn-auto-layout` para o caminho sem raias). Paleta alinhada ao CSS do app
  (azul `#124e80`, teal `#17a99b`, amber `#b7791f`). Vantagem de fazer na DI: o
  `.bpmn` exportado já sai colorido.
- **Validar o visual** no navegador: raias limpas, edição+congelar, export PNG.
- **Evals com documentos reais** do Marcos (`.pdf`/`.docx`), salvar gabaritos em
  `evaluations/expected/`, rodar `npm run eval`, decidir Fable × Sonnet com o
  painel de custo.
- **Message flows entre pools** no `src/laneLayout.ts` (setas interno ↔ externo).

## Comandos úteis

```bash
npm run web                 # app local (usa o Supabase via DATABASE_URL do .env)
npm run dev -- <arquivo>    # CLI (gera arquivos, NÃO salva no banco)
npm run eval                # avaliação de qualidade
npm run typecheck && npm run lint && npm run build
```

## Mapa dos arquivos-chave

- `src/server.ts` — servidor HTTP atual (vira base das funções `api/` na Frente 2)
- `src/store.ts` — **persistência Supabase/Postgres (pronto, async)**
- `src/orchestrator.ts` — pipeline (extração→validação→compilação→layout→lint)
- `src/laneLayout.ts` — layout com raias/pools (onde colorir com raias)
- `src/pricing.ts` — preços por modelo (custo)
- `public/` — frontend (index.html, app.js, styles.css); bpmn-js vem de node_modules
- `.env` — `DATABASE_URL`, `ANTHROPIC_API_KEY`, etc. (local, gitignored)

## Lembretes

- **Rotacionar a `ANTHROPIC_API_KEY`** (circulou em chat). O `.env` é gitignored.
- Repo **privado**.
- Não migrar de volta pra SQLite — o Supabase é o banco daqui pra frente.
