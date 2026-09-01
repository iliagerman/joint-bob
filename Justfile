# Seed and serve a disposable local node with dummy data on http://localhost:8791.
dev:
    ./scripts/dev-local.sh

# Seed and serve two paired disposable nodes on :8791 and :8792.
dev-cluster:
    ./scripts/dev-local.sh cluster

# Rebuild the disposable local nodes from scratch.
dev-reset:
    node --import tsx scripts/dev-seed.ts --force --nodes 2

# Run the browser sanity suite against a seeded node.
test-ui:
    npm run test:ui

# Deploy the checked-out commit to this Mac.
update-local:
    ./scripts/deploy-installed-nodes.sh "$(git rev-parse HEAD)" local

# Deploy the checked-out commit to the configured SSH node.
update-homeserver:
    ./scripts/deploy-installed-nodes.sh "$(git rev-parse HEAD)" homeserver

# Deploy the checked-out commit to both nodes.
update:
    ./scripts/deploy-installed-nodes.sh "$(git rev-parse HEAD)" all

# Run the release gate, commit the notes it writes, and push main in one go.
push:
    ./scripts/push-main.sh
