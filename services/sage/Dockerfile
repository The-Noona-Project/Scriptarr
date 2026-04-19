FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/sage/package.json services/sage/package.json

RUN npm install --workspace services/sage --include-workspace-root=false

COPY services/sage ./services/sage

WORKDIR /app/services/sage

EXPOSE 3004

CMD ["npm", "start"]

