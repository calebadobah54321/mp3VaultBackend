# Use Node.js 18 as base image
FROM node:18-slim

# Install required dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and install yt-dlp
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install --no-cache-dir yt-dlp

# Create and set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the port your app runs on
EXPOSE 3002

# Command to run the application
CMD ["node", "app.js"]