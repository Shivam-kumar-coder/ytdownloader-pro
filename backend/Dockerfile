FROM node:18-alpine

# Install Python, pip, and yt-dlp dependencies
RUN apk update && apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    && pip3 install --upgrade yt-dlp

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

CMD ["node", "server.js"]
