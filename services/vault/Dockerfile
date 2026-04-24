FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/scriptarr-access ./packages/scriptarr-access
COPY packages/scriptarr-logging ./packages/scriptarr-logging
COPY services/vault/package.json services/vault/package.json

RUN npm install --workspace services/vault --include-workspace-root=false

COPY services/vault ./services/vault

WORKDIR /app/services/vault

EXPOSE 3005

CMD ["npm", "start"]
