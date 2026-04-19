FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/scriptarr-logging ./packages/scriptarr-logging
COPY services/oracle/package.json services/oracle/package.json

RUN npm install --workspace services/oracle --include-workspace-root=false

COPY services/oracle ./services/oracle

WORKDIR /app/services/oracle

EXPOSE 3001

CMD ["npm", "start"]
