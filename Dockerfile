# Stage 1: Build the app
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Copy source and the eca-webview submodule
COPY src/ src/
COPY eca-webview/ eca-webview/
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY public/ public/

RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
