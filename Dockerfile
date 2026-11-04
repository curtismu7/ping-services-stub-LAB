FROM node:26-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
ENV PORT=6300 HOST=0.0.0.0
EXPOSE 6300
CMD ["node", "server/src/index.js"]
