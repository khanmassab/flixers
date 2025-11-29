#!/bin/bash
# EC2 Setup Script for Flixers Backend
# Run this script on a fresh Ubuntu 22.04/24.04 EC2 instance

set -e

echo "=== Flixers EC2 Setup ==="

# Update system
echo "[1/6] Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Docker
echo "[2/6] Installing Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
rm get-docker.sh

# Install Docker Compose
echo "[3/6] Installing Docker Compose..."
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Install Git
echo "[4/6] Installing Git..."
sudo apt install -y git

# Create app directory
echo "[5/6] Creating app directory..."
sudo mkdir -p /opt/flixers
sudo chown $USER:$USER /opt/flixers

# Setup firewall
echo "[6/6] Configuring firewall..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 4000/tcp  # Backend (direct, optional)
sudo ufw --force enable

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Log out and log back in (for Docker group to take effect)"
echo "2. Clone your repository: cd /opt/flixers && git clone <your-repo-url> ."
echo "3. Create .env file: cp .env.example .env && nano .env"
echo "4. Start the application: docker-compose -f docker-compose.prod.yml up -d"
echo ""

