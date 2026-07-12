#!/bin/bash
# ==============================================================================
# Plausible Self-Hosted Auto-Install Script for Ubuntu 22.04 LTS
# ==============================================================================
set -e

# Configuration
DOMAIN="plausible.shadewalk.fit"
EMAIL="kieron.brewer@gmail.com" # Feel free to update this on your server

echo "========================================================================"
echo " Starting Plausible Analytics Setup for $DOMAIN"
echo "========================================================================"

# 1. Update system packages
echo "--> Updating system packages..."
sudo apt update && sudo apt upgrade -y

# 2. Install prerequisites
echo "--> Installing prerequisites..."
sudo apt install -y curl git nginx certbot python3-certbot-nginx gnupg lsb-release

# 3. Install Docker and Docker Compose
echo "--> Installing Docker..."
if ! command -v docker &> /dev/null; then
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt update
    sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
    echo "    Docker is already installed."
fi

# Ensure docker service runs
sudo systemctl enable docker
sudo systemctl start docker

# 4. Clone Plausible Self-Hosted Repository
echo "--> Cloning Plausible self-hosted repository..."
if [ ! -d "/opt/plausible" ]; then
    sudo git clone https://github.com/plausible/hosting /opt/plausible
else
    echo "    Plausible repo directory already exists."
fi

cd /opt/plausible

# 5. Generate configuration file (plausible-conf.env)
echo "--> Generating plausible-conf.env..."
SECRET_KEY=$(openssl rand -base64 64 | tr -d '\n')

sudo tee /opt/plausible/plausible-conf.env > /dev/null <<EOF
BASE_URL=https://$DOMAIN
SECRET_KEY_BASE=$SECRET_KEY
PORT=8000
EOF

# 6. Configure Nginx Reverse Proxy
echo "--> Configuring Nginx reverse proxy..."
NGINX_CONF="/etc/nginx/sites-available/plausible"

sudo tee $NGINX_CONF > /dev/null <<EOF
server {
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Host \$http_host;
    }
}
EOF

# Enable Nginx block and remove default
sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# 7. Obtain SSL Certificate with Certbot
echo "--> Obtaining SSL Certificate..."
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect

# 8. Start Plausible Docker Containers
echo "--> Booting up Plausible containers (this may take a minute)..."
sudo docker compose up -d

echo "========================================================================"
echo " Plausible setup complete!"
echo " Navigate to: https://$DOMAIN"
echo " Create your admin account and add 'shadewalk.fit' to start tracking."
echo "========================================================================"
