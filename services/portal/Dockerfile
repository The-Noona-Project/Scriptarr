FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/portal/package.json services/portal/package.json

RUN npm install --workspace services/portal --include-workspace-root=false

COPY services/portal ./services/portal

WORKDIR /app/services/portal

EXPOSE 3003

CMD ["npm", "start"]

