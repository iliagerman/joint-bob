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
