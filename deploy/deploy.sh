#!/bin/bash
# Deployment script for Flixers
# Run from project root directory

set -e

echo "=== Deploying Flixers ==="

# Check if .env exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found!"
    echo "Create .env with these variables:"
    echo "  DB_USER=flixers"
    echo "  DB_PASSWORD=your-strong-password"
    echo "  DB_NAME=flixers"
    echo "  GOOGLE_CLIENT_ID=your-client-id"
    echo "  JWT_SECRET=your-secret"
    echo "  REQUIRE_ENCRYPTION=true"
    exit 1
fi

# Pull latest code
echo "[1/4] Pulling latest code..."
git pull origin main

# Build images
echo "[2/4] Building Docker images..."
docker-compose -f docker-compose.prod.yml build

# Run database migrations
echo "[3/4] Running database migrations..."
docker-compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy

# Restart services
echo "[4/4] Starting services..."
docker-compose -f docker-compose.prod.yml up -d

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  - Nginx (reverse proxy): http://localhost:80"
echo "  - Backend API: http://localhost/api"
echo "  - WebSocket: ws://localhost/ws"
echo ""
docker-compose -f docker-compose.prod.yml ps
