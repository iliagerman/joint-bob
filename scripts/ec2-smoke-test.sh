#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-sela}"
AWS_REGION="${AWS_REGION:-$(aws configure get region --profile "${AWS_PROFILE}")}"
AWS_REGION="${AWS_REGION:-us-west-2}"
KEEP_INSTANCE="${KEEP_INSTANCE:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_ROOT="${ROOT}/deploy/aws-ec2-test"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_DIR="${JOINT_BOB_EC2_TEST_DIR:-${HOME}/.joint-bob-ec2-tests/${RUN_ID}}"
STATE_PATH="${ARTIFACT_DIR}/terraform.tfstate"
TF_DATA_DIR="${ARTIFACT_DIR}/terraform-data"

for tool in aws curl ssh scp ssh-keygen tar terraform; do command -v "${tool}" >/dev/null 2>&1 || { echo "${tool} is required" >&2; exit 1; }; done
mkdir -p "${ARTIFACT_DIR}"
chmod 700 "${ARTIFACT_DIR}"
operator_ip="${JOINT_BOB_TEST_PUBLIC_IP:-$(curl -4 -fsS https://checkip.amazonaws.com | tr -d '[:space:]')}"
[[ "${operator_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "Could not determine operator IPv4 address" >&2; exit 1; }
allowed_cidr="${operator_ip}/32"

export AWS_PROFILE AWS_REGION TF_DATA_DIR
terraform -chdir="${TF_ROOT}" init -input=false
terraform -chdir="${TF_ROOT}" apply -auto-approve -input=false -state="${STATE_PATH}" -var="aws_region=${AWS_REGION}" -var="allowed_cidr=${allowed_cidr}"
instance_id="$(terraform -chdir="${TF_ROOT}" output -state="${STATE_PATH}" -raw instance_id)"
public_ip="$(terraform -chdir="${TF_ROOT}" output -state="${STATE_PATH}" -raw public_ip)"
availability_zone="$(terraform -chdir="${TF_ROOT}" output -state="${STATE_PATH}" -raw availability_zone)"
printf '%s\n' "${instance_id}" > "${ARTIFACT_DIR}/instance-id"
printf '%s\n' "${public_ip}" > "${ARTIFACT_DIR}/public-ip"
chmod 600 "${ARTIFACT_DIR}/instance-id" "${ARTIFACT_DIR}/public-ip"

destroy() {
  terraform -chdir="${TF_ROOT}" destroy -auto-approve -input=false -state="${STATE_PATH}" -var="aws_region=${AWS_REGION}" -var="allowed_cidr=${allowed_cidr}"
}
failed=true
cleanup() {
  local status=$?
  if [ "${KEEP_INSTANCE}" != 1 ] || [ "${failed}" = true ]; then destroy || true; fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

aws ec2 wait instance-status-ok --instance-ids "${instance_id}" --profile "${AWS_PROFILE}" --region "${AWS_REGION}"
key_path="${ARTIFACT_DIR}/id_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "${key_path}"
chmod 600 "${key_path}" "${key_path}.pub"
ssh_options=(-i "${key_path}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${ARTIFACT_DIR}/known_hosts" -o ConnectTimeout=10)
push_key() {
  aws ec2-instance-connect send-ssh-public-key --instance-id "${instance_id}" --availability-zone "${availability_zone}" --instance-os-user ubuntu --ssh-public-key "file://${key_path}.pub" --profile "${AWS_PROFILE}" --region "${AWS_REGION}" >/dev/null
}
for _ in {1..30}; do
  push_key
  ssh "${ssh_options[@]}" "ubuntu@${public_ip}" true 2>/dev/null && break
  sleep 5
done
push_key
ssh "${ssh_options[@]}" "ubuntu@${public_ip}" 'cloud-init status --wait; sudo loginctl enable-linger ubuntu; mkdir -p ~/joint-bob-source'

COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.pi-mobile-web --exclude=.joint-bob --exclude=.pi-mobile-web-attachments --exclude=.master-bob-release --exclude=.joint-bob-release -czf "${ARTIFACT_DIR}/joint-bob-source.tar.gz" -C "${ROOT}" .
chmod 600 "${ARTIFACT_DIR}/joint-bob-source.tar.gz"
push_key
scp "${ssh_options[@]}" "${ARTIFACT_DIR}/joint-bob-source.tar.gz" "ubuntu@${public_ip}:joint-bob-source.tar.gz"
push_key
ssh "${ssh_options[@]}" "ubuntu@${public_ip}" 'set -e; rm -rf ~/joint-bob-source; mkdir ~/joint-bob-source; tar -xzf ~/joint-bob-source.tar.gz -C ~/joint-bob-source; cd ~/joint-bob-source; export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; bash scripts/install-service.sh'

push_key
ssh "${ssh_options[@]}" "ubuntu@${public_ip}" "sudo openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes -subj '/CN=${public_ip}' -keyout /etc/ssl/private/joint-bob.key -out /etc/ssl/certs/joint-bob.crt >/dev/null 2>&1; sudo tee /etc/nginx/sites-available/joint-bob >/dev/null <<'NGINX'
server {
  listen 8443 ssl;
  ssl_certificate /etc/ssl/certs/joint-bob.crt;
  ssl_certificate_key /etc/ssl/private/joint-bob.key;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection 'upgrade';
  }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/joint-bob /etc/nginx/sites-enabled/joint-bob; sudo rm -f /etc/nginx/sites-enabled/default; sudo nginx -t; sudo systemctl restart nginx"

base_url="https://${public_ip}:8443"
for _ in {1..60}; do curl -kfsS "${base_url}/api/health" >/dev/null 2>&1 && break; sleep 2; done
username="ec2admin"
password="$(openssl rand -base64 30 | tr -d '/+=')Aa1!"
printf 'url=%s\nusername=%s\npassword=%s\n' "${base_url}" "${username}" "${password}" > "${ARTIFACT_DIR}/credentials.txt"
chmod 600 "${ARTIFACT_DIR}/credentials.txt"
BASE_URL="${base_url}" TEST_USERNAME="${username}" TEST_PASSWORD="${password}" NODE_TLS_REJECT_UNAUTHORIZED=0 node --input-type=module <<'NODE'
const base = process.env.BASE_URL;
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
};
const initial = await request("/api/auth/status");
if (!initial.body.setupRequired) throw new Error("Fresh node did not require administrator setup");
const setup = await request("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.env.TEST_USERNAME, password: process.env.TEST_PASSWORD }) });
const cookie = setup.response.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("Setup did not return a session cookie");
const preferences = await request("/api/preferences", { headers: { Cookie: cookie } });
await request("/api/preferences", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": setup.body.csrfToken }, body: JSON.stringify({ ...preferences.body, theme: "dark" }) });
await request("/api/settings", { headers: { Cookie: cookie } });
NODE

push_key
ssh "${ssh_options[@]}" "ubuntu@${public_ip}" 'export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; systemctl --user restart joint-bob.service'
for _ in {1..60}; do curl -kfsS "${base_url}/api/health" >/dev/null 2>&1 && break; sleep 2; done
BASE_URL="${base_url}" TEST_USERNAME="${username}" TEST_PASSWORD="${password}" NODE_TLS_REJECT_UNAUTHORIZED=0 node --input-type=module <<'NODE'
const login = await fetch(`${process.env.BASE_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.env.TEST_USERNAME, password: process.env.TEST_PASSWORD }) });
if (!login.ok) throw new Error(`Login after restart returned ${login.status}`);
const body = await login.json();
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
const preferences = await fetch(`${process.env.BASE_URL}/api/preferences`, { headers: { Cookie: cookie } });
const saved = await preferences.json();
if (!preferences.ok || saved.theme !== "dark" || !body.csrfToken) throw new Error("SQLite preferences did not survive restart");
NODE

failed=false
printf '\nEC2 smoke test passed.\nURL: %s\nCredentials: %s\n' "${base_url}" "${ARTIFACT_DIR}/credentials.txt"
printf 'Destroy: AWS_PROFILE=%q AWS_REGION=%q TF_DATA_DIR=%q terraform -chdir=%q destroy -auto-approve -state=%q -var=%q -var=%q\n' "${AWS_PROFILE}" "${AWS_REGION}" "${TF_DATA_DIR}" "${TF_ROOT}" "${STATE_PATH}" "aws_region=${AWS_REGION}" "allowed_cidr=${allowed_cidr}"
if [ "${KEEP_INSTANCE}" != 1 ]; then destroy; fi
trap - EXIT INT TERM
