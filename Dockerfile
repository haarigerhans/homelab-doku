FROM node:22-alpine
WORKDIR /app
COPY server.js index.html ./
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
