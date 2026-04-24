FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/scriptarr-access ./packages/scriptarr-access
COPY packages/scriptarr-logging ./packages/scriptarr-logging
COPY services/moon/package.json services/moon/package.json

RUN npm install --workspace services/moon --include-workspace-root=false

COPY services/moon ./services/moon

WORKDIR /app/services/moon

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
