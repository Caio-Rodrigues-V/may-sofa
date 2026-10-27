FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY SYSTEM-PROMPT.txt ./SYSTEM-PROMPT.txt

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
