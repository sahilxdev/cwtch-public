FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY relay/src ./src
COPY extension/shared /app/extension/shared
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
