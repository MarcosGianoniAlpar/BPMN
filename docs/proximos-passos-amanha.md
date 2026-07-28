# To-do — próximos passos (BPMN Pipeline)

> Handoff de trabalho. As **regras de trabalho** (fluxo `dev`→PROD, mostrar antes
> de commitar, consultar antes de gastar API) estão no `CLAUDE.md` na raiz.

## Onde estamos (contexto)

- **Deploy no Vercel funcionando** em `MarcosGianoniAlpar/BPMN` (time Alpar, **Hobby**).
  Estático (`public/`) + funções serverless (`api/`), banco no Supabase. Geração de
  `.txt`/`.pdf`/`.docx` funciona ponta a ponta.
- **Colorização do BPMN** com a paleta Alpar já entregue (`src/bpmnColor.ts`).
- **Branch `dev`** criado; trabalhar nele (Preview), PROD só com aprovação.

## Decisões travadas

- **Sem plano Pro no Vercel por enquanto** → geração (~1 min) estoura o teto de 60s
  do Hobby na PROD. Uso real fica limitado até rever isso.
- **Modelo fixo: `claude-sonnet-5`** (sem evals / sem trocar de modelo por ora).
- **Key da API é da empresa** → consultar antes de qualquer geração/refino/eval.

## Para fazer amanhã

### 1. Custo sempre à vista  ·  não gasta API
Deixar o custo/uso visível o tempo todo (hoje só no painel da home).
- **Badge fixo no header** (home + workspace): total acumulado em US$, atualiza a
  cada geração (puxa de `GET /api/usage`).
- **Custo da geração atual** inline no resultado: "esta geração: US$ X · N tokens".
- Só frontend + rota existente.

### 2. Message flows entre pools  ·  precisa extensão de modelo (+1 geração p/ validar)
Desenhar as setas (tracejadas) entre o processo interno e os pools externos.
- **Porém:** o `ProcessSpec` **não liga nó ↔ participante externo** hoje. Precisa:
  - adicionar `message_flows` no schema (`schemas/process-spec.schema.json`) + regenerar tipos;
  - ensinar o **prompt de extração** a preenchê-los (`prompts/extract-process.md`, `refine-process.md`);
  - desenhar `bpmn:MessageFlow` no `src/laneLayout.ts` (interno ↔ pool externo).
- **Validação:** desenho com **spec sintético** (sem API) agora; extração real com
  **1 geração** só quando aprovado.

### 3. Diagrama compartilhado / colaborativo  ·  IDEIA NOVA — discutir antes
Objetivo: **duas pessoas contribuírem** no mesmo diagrama. Há 3 níveis, do mais
leve ao mais pesado — decidir o alvo antes de construir:
- **(a) Link compartilhável de um projeto salvo** — URL tipo `/?project=<id>` que
  abre um projeto do Supabase. Ambos veem/editam e salvam **versões**. Leve, encaixa
  no que já existe (modelo projeto→versões). *Colaboração assíncrona.*
- **(b) Colaboração por versões com identidade** — cada pessoa adiciona/edita e
  "congela" versões; registrar **quem** fez cada versão. Médio.
- **(c) Co-edição em tempo real** (tipo Google Docs) — presença + merge simultâneo.
  **Pesado e com atrito no Vercel**: serverless não mantém WebSocket; exigiria um
  serviço de realtime (Supabase Realtime / Liveblocks / Ably) + CRDT (ex.: Yjs) no
  bpmn-js. Provavelmente fora do escopo atual, mas vale mapear.
- **Recomendação inicial:** mirar **(a)** — entrega "compartilhado" real com custo
  baixo; evoluir pra (b)/(c) se precisar.

## Backlog (quando der)

- **Repo privado** — `MarcosGianoniAlpar/BPMN` está **público**; é código da empresa.
- **Limpar caracteres estranhos** da extração de PDF (ex.: `Ata de Reuni��o` —
  fonte do título sem Unicode; pós-processamento cosmético).
- **Confirmar streaming NDJSON** no Vercel (barra de progresso ao vivo).
- **Restaurar lint no serverless** (fixar `min-dash` numa versão com build CJS).
- **Validar visual** no navegador: raias limpas, edição + congelar, export PNG colorido.
- **OCR** para PDF escaneado (fase futura).

## Comandos

```bash
npm run web                 # app local (http://localhost:3000)
npm run dev -- <arquivo>    # CLI — GASTA API (pedir ok antes)
npm run eval                # avaliação — GASTA API (pedir ok antes)
npm run typecheck && npm run lint && npm run build
npm run typecheck:vercel    # valida as funções serverless em api/
```
