# Production Deployment Guide - AWS t3.medium

## Prerequisites

1. AWS EC2 t3.medium instance (or larger)
2. Domain name (optional but recommended)
3. SSH access to EC2 instance
4. Environment variables configured

## Step 1: Launch EC2 Instance

1. Go to AWS Console → EC2 → Launch Instance
2. Choose:
   - **AMI**: Ubuntu Server 22.04 LTS or 24.04 LTS
   - **Instance Type**: t3.medium (2 vCPU, 4GB RAM)
   - **Storage**: 30GB gp3 (recommended)
   - **Security Group**: Allow ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
   - **Key Pair**: Create/download a key pair

## Step 2: Initial Server Setup

SSH into your instance:
```bash
ssh -i your-key.pem ubuntu@your-ec2-ip
```

Run the setup script:
```bash
cd /opt/flixers
git clone <your-repo-url> .
chmod +x deploy/setup-ec2.sh
./deploy/setup-ec2.sh

# Log out and back in (for Docker group)
exit
ssh -i your-key.pem ubuntu@your-ec2-ip
```

## Step 3: Configure Environment Variables

```bash
cd /opt/flixers
cp .env.example .env
nano .env
```

**Required variables:**
- `JWT_SECRET` - Generate a strong random secret (min 32 chars)
- `GOOGLE_CLIENT_ID` - Your Google OAuth client ID
- `DB_PASSWORD` - Strong database password
- `ALLOWED_ORIGINS` - Comma-separated list of your domains

**Generate JWT_SECRET:**
```bash
openssl rand -base64 32
```

## Step 4: Deploy Application

```bash
cd /opt/flixers
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

This will:
1. Pull latest code
2. Build Docker images
3. Run database migrations
4. Start all services

## Step 5: Verify Deployment

Check services:
```bash
docker-compose -f docker-compose.prod.yml ps
```

Test health endpoint:
```bash
curl http://localhost/health
```

Check logs:
```bash
docker-compose -f docker-compose.prod.yml logs -f backend
```

## Step 6: Configure SSL/HTTPS (Optional but Recommended)

### Option A: Using Let's Encrypt with Certbot

```bash
# Install certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx -y

# Get certificate (replace with your domain)
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Auto-renewal is set up automatically
```

### Option B: Using AWS Certificate Manager + ALB

1. Create certificate in ACM
2. Set up Application Load Balancer
3. Configure HTTPS listener
4. Point domain to ALB

## Step 7: Set Up Monitoring

### Basic Monitoring Commands

```bash
# Check service status
docker-compose -f docker-compose.prod.yml ps

# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Check resource usage
docker stats

# Check disk space
df -h
```

### Set Up CloudWatch (Optional)

1. Install CloudWatch agent
2. Configure logs and metrics
3. Set up alarms for:
   - High CPU usage
   - High memory usage
   - Disk space
   - Service health

## Step 8: Backup Strategy

### Database Backups

```bash
# Manual backup
docker-compose -f docker-compose.prod.yml exec postgres pg_dump -U flixers flixers > backup_$(date +%Y%m%d).sql

# Restore backup
docker-compose -f docker-compose.prod.yml exec -T postgres psql -U flixers flixers < backup_20250101.sql
```

### Automated Backups (Cron)

Create `/opt/flixers/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/opt/flixers/backups"
mkdir -p $BACKUP_DIR
docker-compose -f /opt/flixers/docker-compose.prod.yml exec -T postgres pg_dump -U flixers flixers > $BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).sql
# Keep only last 7 days
find $BACKUP_DIR -name "backup_*.sql" -mtime +7 -delete
```

Add to crontab:
```bash
crontab -e
# Add: 0 2 * * * /opt/flixers/backup.sh
```

## Troubleshooting

### Services won't start
```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs

# Check environment variables
docker-compose -f docker-compose.prod.yml config
```

### Out of memory
```bash
# Check memory usage
free -h
docker stats

# Restart services
docker-compose -f docker-compose.prod.yml restart
```

### Database connection issues
```bash
# Check PostgreSQL logs
docker-compose -f docker-compose.prod.yml logs postgres

# Test connection
docker-compose -f docker-compose.prod.yml exec postgres psql -U flixers -d flixers -c "SELECT 1;"
```

### WebSocket issues
```bash
# Check backend logs
docker-compose -f docker-compose.prod.yml logs backend

# Check nginx logs
docker-compose -f docker-compose.prod.yml logs nginx
```

## Security Checklist

- [ ] Strong `JWT_SECRET` set (not default)
- [ ] Strong `DB_PASSWORD` set (not default)
- [ ] `ALLOWED_ORIGINS` configured (not `*`)
- [ ] SSL/HTTPS configured
- [ ] Firewall configured (only necessary ports open)
- [ ] Regular security updates: `sudo apt update && sudo apt upgrade`
- [ ] Database backups configured
- [ ] Logs monitored for suspicious activity

## Cost Optimization

- Use Reserved Instances for 1-3 year commitment (saves ~30-60%)
- Monitor CloudWatch metrics to right-size instance
- Set up auto-scaling if traffic grows
- Use S3 for backups (cheaper than EBS snapshots)

## Next Steps

1. Set up domain DNS pointing to EC2 IP
2. Configure SSL certificate
3. Set up monitoring and alerts
4. Configure automated backups
5. Set up CI/CD for deployments
6. Consider adding a second instance for high availability
