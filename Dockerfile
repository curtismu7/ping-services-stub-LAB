FROM node:26-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY standalone-ui.css ./
COPY web/src/top-menu/top-menu.css ./top-menu.css
COPY deploy/pf-rootCA.pem ./deploy/pf-rootCA.pem
COPY docs/talk-track.md ./docs/talk-track.md
# The shared local PingFederate serves a mkcert cert; trust the current root (kept fresh by deploy/pf-rootCA.pem).
ENV NODE_EXTRA_CA_CERTS=/app/deploy/pf-rootCA.pem
ENV PORT=6300 HOST=0.0.0.0
EXPOSE 6300
CMD ["node", "server/src/index.js"]
