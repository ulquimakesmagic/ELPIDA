FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# These packages are also needed at runtime for the simulated chain and compiler.
RUN npm ci --include=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/local-data && chown node:node /app /app/local-data
ENV NODE_ENV=production
ENV HOST=0.0.0.0
USER node
CMD ["npm", "start"]
