FROM docker:29-cli AS docker-cli

FROM node:24-slim

WORKDIR /app

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY package.json package-lock.json ./
COPY packages/scriptarr-logging ./packages/scriptarr-logging
COPY services/warden/package.json services/warden/package.json

RUN npm install --workspace services/warden --include-workspace-root=false

COPY services/warden ./services/warden

WORKDIR /app/services/warden

EXPOSE 4001

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4001/health',{signal:AbortSignal.timeout(4000)}).then((response)=>{if(!response.ok){process.exit(1);}}).catch(()=>process.exit(1));"]

CMD ["npm", "start"]
