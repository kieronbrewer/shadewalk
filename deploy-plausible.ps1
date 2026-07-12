# deploy-plausible.ps1
# Automates the provisioning and setup of a self-hosted Plausible instance on DigitalOcean.

$ErrorActionPreference = "Stop"

# 1. Load DigitalOcean Token from local .env
if (Test-Path ".env") {
    Get-Content ".env" | Foreach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $name, $value = $line.split('=', 2)
            if ($name -and $value) {
                [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
            }
        }
    }
}

$token = [System.Environment]::GetEnvironmentVariable("DIGITALOCEAN_TOKEN", "Process")
if (-not $token) {
    Write-Error "DIGITALOCEAN_TOKEN is missing from your .env file. Please add it first."
}

# 2. Generate local SSH Key if it does not exist
$sshKeyPath = "$Home\.ssh\id_do_temp"
$pubKeyPath = "$sshKeyPath.pub"
if (-not (Test-Path $sshKeyPath)) {
    Write-Host "--> Generating temporary SSH key pair..."
    mkdir -Force "$Home\.ssh"
    # Run ssh-keygen (silent, no passphrase)
    & ssh-keygen -t ed25519 -N '""' -f $sshKeyPath -q
}
$pubKey = (Get-Content $pubKeyPath).Trim()

# 3. Upload public SSH Key to DigitalOcean account
Write-Host "--> Registering SSH key with DigitalOcean..."
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}
$sshKeyBody = @{
    "name" = "ShadeWalk Temp Key"
    "public_key" = $pubKey
} | ConvertTo-Json -Compress

try {
    $response = Invoke-RestMethod -Uri "https://api.digitalocean.com/v2/account/keys" -Method Post -Headers $headers -Body $sshKeyBody
    $keyId = $response.ssh_key.id
    Write-Host "    Key registered successfully (ID: $keyId)."
} catch {
    # If key already exists in DO account, let's fetch it
    $fingerprint = & ssh-keygen -E md5 -lf $sshKeyPath
    # Format fingerprint
    if ($fingerprint -match "MD5:([a-f0-9:]+)") {
        $fp = $Matches[1]
        try {
            $response = Invoke-RestMethod -Uri "https://api.digitalocean.com/v2/account/keys/$fp" -Method Get -Headers $headers
            $keyId = $response.ssh_key.id
            Write-Host "    Found existing registered key (ID: $keyId)."
        } catch {
            Write-Error "Failed to upload or fetch SSH key from DigitalOcean: $_"
        }
    } else {
        Write-Error "Failed to get fingerprint of local SSH key."
    }
}

# 4. Create the $6/month regular CPU Droplet
Write-Host "--> Creating $6/mo Ubuntu Droplet (nyc1 datacentre)..."
$dropletBody = @{
    "name" = "Plausible"
    "region" = "nyc1"
    "size" = "s-1vcpu-1gb"
    "image" = "ubuntu-22-04-x64"
    "ssh_keys" = @($keyId)
} | ConvertTo-Json -Compress

$response = Invoke-RestMethod -Uri "https://api.digitalocean.com/v2/droplets" -Method Post -Headers $headers -Body $dropletBody
$dropletId = $response.droplet.id
Write-Host "    Droplet creation initiated (ID: $dropletId)."

# 5. Wait for IPv4 assignment
Write-Host "--> Waiting for Droplet to boot and assign an IP address..."
$ip = $null
$attempts = 0
while (-not $ip -and $attempts -lt 24) {
    Start-Sleep -Seconds 5
    $response = Invoke-RestMethod -Uri "https://api.digitalocean.com/v2/droplets/$dropletId" -Method Get -Headers $headers
    $networks = $response.droplet.networks.v4
    if ($networks) {
        $publicNetwork = $networks | Where-Object { $_.type -eq "public" }
        if ($publicNetwork) {
            $ip = $publicNetwork.ip_address
        }
    }
    $attempts++
}

if (-not $ip) {
    Write-Error "Timeout waiting for Droplet IP address. Check your DigitalOcean console."
}
Write-Host "    Droplet IP: $ip"

# 6. Add DNS A-record to shadewalk.fit
Write-Host "--> Adding DNS record for plausible.shadewalk.fit pointing to $ip..."
$dnsBody = @{
    "type" = "A"
    "name" = "plausible"
    "data" = $ip
    "ttl" = 3600
} | ConvertTo-Json -Compress

try {
    Invoke-RestMethod -Uri "https://api.digitalocean.com/v2/domains/shadewalk.fit/records" -Method Post -Headers $headers -Body $dnsBody
    Write-Host "    DNS record created successfully."
} catch {
    Write-Host "    DNS record may already exist, proceeding..."
}

# 7. Wait for SSH to boot up and run setup commands
Write-Host "--> Waiting for SSH on Droplet to become responsive (approx 30s)..."
Start-Sleep -Seconds 30

Write-Host "--> Connecting to Droplet at $ip to install Plausible..."
# Bypass needrestart dialog & fetch the automated setup script
$remoteCommand = "sudo sed -i 's/#\`$nrconf{restart} = '\''i'\'';/\`$nrconf{restart} = '\''a'\'';/g' /etc/needrestart/needrestart.conf; curl -sSL https://raw.githubusercontent.com/kieronbrewer/shadewalk/main/setup-plausible.sh | bash"

# Run ssh with StrictHostKeyChecking disabled
ssh -i $sshKeyPath -o StrictHostKeyChecking=no root@$ip $remoteCommand

Write-Host "========================================================================"
Write-Host " Deployment Complete!"
Write-Host " Visit: https://plausible.shadewalk.fit"
Write-Host "========================================================================"
