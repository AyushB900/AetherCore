# Cloud development environment

Ordinary local development uses the README instructions. This cloud machine has a read-only home directory and network access through an egress proxy, so its tool caches, full JDK, and Maven proxy configuration live under `/workspace`.

```bash
cd /workspace/AetherCore
bash scripts/setup-cloud.sh
. /workspace/tools/aether-env.sh
./mvnw -s /workspace/tools/maven-settings.xml verify
```

The setup helper downloads a checksum-verified Temurin JDK 21 when needed, configures Maven to use the supplied egress proxy with the system Java certificate store, builds the application, installs portfolio test dependencies with the committed lockfile, and pulls service images. It creates ignored random local development credentials only when `.env` is absent. It never overwrites an existing `.env` or prints credential values. These local credentials are not a substitute for real deployment secret management.

Start the services and application:

```bash
cd /workspace/AetherCore
. /workspace/tools/aether-env.sh
docker compose up -d postgres redis kafka
set -a
. ./.env
set +a
java -jar target/aethercore-0.1.0.jar
```

In another shell with the same environment loaded, run `python3 scripts/demo.py` for functional validation. Java processes do not survive environment snapshots; restart the application and services when needed. Use the existing checkout: each cloud task is already isolated, so no extra Git worktree is needed.

For browser tests with the system Chromium:

```bash
cd /workspace/AetherCore/site
. /workspace/tools/aether-env.sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

The multi-stage Dockerfile accepts optional BuildKit secret mounts `maven_settings` and `java_truststore` for network-restricted builders. These are transient build configuration, not files copied into the runtime image. Normal local builds do not need them. In this cloud machine, the builder also needs the host proxy name mapped to its resolved address and host networking. TLS and artifact verification remain enabled.
