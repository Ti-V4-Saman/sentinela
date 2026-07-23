FROM node:20-alpine

WORKDIR /app

# Copy dependency specifications
COPY package*.json ./

# Install dependencies cleanly
RUN npm ci

# Copy source code
COPY . .

# Build production frontend bundle
RUN npm run build

EXPOSE 3001

# Start the Node.js backend server
CMD ["npm", "run", "server"]

