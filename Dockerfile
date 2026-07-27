# syntax=docker/dockerfile:1

# --- Estágio de build: compila o TypeScript ---
# Node 24: precisa de >= 22.5 para o módulo nativo node:sqlite (persistência).
FROM node:24-bookworm AS build
WORKDIR /app

# Instala TODAS as dependências (inclui dev, para o tsc).
COPY package.json package-lock.json ./
RUN npm ci

# Copia o código e compila para dist/.
COPY tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
RUN npm run build

# --- Estágio de runtime: só o necessário para rodar ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Só as dependências de produção.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Artefatos compilados + assets que o servidor lê em runtime.
COPY --from=build /app/dist ./dist
COPY public ./public
COPY prompts ./prompts
COPY schemas ./schemas
COPY .bpmnlintrc ./.bpmnlintrc

# O banco SQLite vive aqui; monte um volume para persistir entre restarts.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Healthcheck simples: a home responde 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
