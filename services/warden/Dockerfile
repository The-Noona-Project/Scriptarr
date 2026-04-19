FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/warden/package.json services/warden/package.json

RUN npm install --workspace services/warden --include-workspace-root=false

COPY services/warden ./services/warden

WORKDIR /app/services/warden

EXPOSE 4001

CMD ["npm", "start"]

