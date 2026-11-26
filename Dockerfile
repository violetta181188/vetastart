FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --strict-ssl=true && mkdir -p /var/data && chown node:node /var/data

COPY --chown=root:node . .
RUN chmod -R g+rX /app

ENV NODE_ENV=production
ENV VETASTART_DB_PATH=/var/data/vetastart.sqlite
ENV VETASTART_PERSISTENT_DATA_DIR=/var/data

USER node

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
