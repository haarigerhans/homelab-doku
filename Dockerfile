FROM node:22-alpine
WORKDIR /app
COPY server.js index.html icon.svg icon-192.png icon-512.png manifest.webmanifest ./
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
