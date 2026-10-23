FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npx tsc

FROM node:20-alpine
RUN apk add --no-cache android-tools && npm install -g ask-cli
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY skill ./skill
CMD ["node", "dist/server.js"]
