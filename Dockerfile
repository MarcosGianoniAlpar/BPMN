# syntax=docker/dockerfile:1

# Imagem para AUTO-HOSPEDAGEM (VM, servidor da empresa, docker-compose).
# O deploy em uso hoje e o Vercel — estatico + funcoes serverless, que nao usa
# este arquivo. Ele existe como saida caso o Vercel deixe de servir: aqui roda o
# servidor Node inteiro (src/server.ts), sem o teto de 60s por requisicao.
#
# O estado NAO vive no container: projetos, versoes e contador de uso ficam no
# Postgres (DATABASE_URL). Backup e `npm run backup`, nao copiar volume.

# --- Estagio de build: compila o TypeScript e junta os assets do bpmn-js ---
# Node 24: o package.json exige >= 22.5.
FROM node:24-bookworm AS build
WORKDIR /app

# Instala TODAS as dependencias (inclui dev, para o tsc).
COPY package.json package-lock.json ./
RUN npm ci

# Copia o codigo e compila para dist/.
COPY tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
COPY scripts ./scripts
COPY public ./public
# copy:vendor traz o bpmn-js de node_modules para public/vendor. Sem este passo o
# frontend carrega sem o Modeler e o diagrama simplesmente nao renderiza.
RUN npm run copy:vendor && npm run build

# --- Estagio de runtime: so o necessario para rodar ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# So as dependencias de producao.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Artefatos compilados + assets que o servidor le em runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY prompts ./prompts
COPY schemas ./schemas
COPY .bpmnlintrc ./.bpmnlintrc

# O servidor nao escreve em disco (o estado vai para o Postgres), entao nao ha
# volume a montar e da para rodar sem privilegio.
USER node

EXPOSE 3000

# Healthcheck simples: a home responde 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
