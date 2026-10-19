#!/usr/bin/env bash
# Cloud onboarding helper; ordinary local development can use Docker Compose directly.
set -euo pipefail
cd /workspace/AetherCore
mkdir -p /workspace/tools /workspace/.m2 /workspace/.docker
jdk_dir=/workspace/tools/jdk-21.0.12.1+1
if [ ! -x "$jdk_dir/bin/javac" ]; then
  download_dir=$(mktemp -d /tmp/aether-jdk.XXXXXX)
  trap 'rm -rf "$download_dir"' EXIT
  jdk_url='https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz'
  curl --fail --silent --show-error --location "$jdk_url" -o "$download_dir/jdk.tar.gz"
  curl --fail --silent --show-error --location "$jdk_url.sha256.txt" -o "$download_dir/jdk.sha256"
  python3 - "$download_dir" <<'PY'
import hashlib, pathlib, sys, tarfile
root=pathlib.Path(sys.argv[1])
archive=root/'jdk.tar.gz'
expected=(root/'jdk.sha256').read_text().split()[0]
if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected:
    raise SystemExit('JDK checksum verification failed')
with tarfile.open(archive) as t:
    t.extractall('/workspace/tools', filter='data')
PY
fi
cat > /workspace/tools/aether-env.sh <<'ENV'
export JAVA_HOME=/workspace/tools/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:$PATH"
export MAVEN_USER_HOME=/workspace/.m2
export DOCKER_CONFIG=/workspace/.docker
export npm_config_cache=/workspace/.npm
if [ -f /etc/ssl/certs/java/cacerts ]; then
  export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
fi
ENV
. /workspace/tools/aether-env.sh
python3 - <<'PY'
import os, urllib.parse, xml.etree.ElementTree as E
from pathlib import Path
import secrets
url=urllib.parse.urlsplit(os.environ.get('HTTPS_PROXY',''))
root=E.Element('settings', xmlns='http://maven.apache.org/SETTINGS/1.2.0')
E.SubElement(root,'localRepository').text='/workspace/.m2/repository'
if url.hostname:
    proxy=E.SubElement(E.SubElement(root,'proxies'),'proxy')
    fields=[('id','cloud-egress'),('active','true'),('protocol','http'),('host',url.hostname),
            ('port',str(url.port or 80)),('nonProxyHosts','localhost|127.0.0.1')]
    for name,value in fields: E.SubElement(proxy,name).text=value
    # Credentials, if required by another proxy, belong in secure user configuration.
    if url.username or url.password:
        raise SystemExit('Authenticated proxy requires secure Maven configuration; credentials were not copied')
E.ElementTree(root).write('/workspace/tools/maven-settings.xml')
local=Path('.env')
if not local.exists():
    fd=os.open(local,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        f.write('DB_PASSWORD='+secrets.token_hex(24)+'\nAETHER_API_KEY='+secrets.token_hex(32)+'\n')
PY
./mvnw -s /workspace/tools/maven-settings.xml -B -DskipTests package
npm ci --prefix site
# Pulling retains verified images; live services are started separately.
docker compose pull postgres redis kafka
