#!/bin/sh
# Publishes the landing page to https://joint-bob.bobthebot.io, in the Sela AWS account (CLI
# profile `sela`). The first run creates the stack in infra.yaml: a private bucket, a CloudFront
# distribution and the DNS records. Later runs upload what changed and clear CloudFront's copies.
# Run `npm run landing` first if the films changed.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
STACK=joint-bob-landing

# Keys in the environment would win over the profile, so they are dropped for these calls.
cloud() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    aws --profile "${LANDING_AWS_PROFILE:-sela}" --region us-east-1 "$@"
}
output() {
  cloud cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

cloud cloudformation deploy --stack-name "$STACK" --template-file "$HERE/infra.yaml" \
  --no-fail-on-empty-changeset --tags project=joint-bob-landing
BUCKET="$(output BucketName)"
DISTRIBUTION="$(output DistributionId)"

# A browser asks again for the page and its code on every visit, and keeps a film for an hour.
# CloudFront keeps everything until the invalidation below.
cloud s3 sync "$HERE/media" "s3://$BUCKET/media" --delete --exclude ".DS_Store" \
  --cache-control "public, max-age=3600, s-maxage=31536000"
for entry in "index.html:text/html" "landing.css:text/css" "landing.js:text/javascript"; do
  cloud s3 cp "$HERE/${entry%%:*}" "s3://$BUCKET/${entry%%:*}" \
    --content-type "${entry##*:}; charset=utf-8" \
    --cache-control "public, max-age=0, s-maxage=31536000, must-revalidate"
done

cloud cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/*" \
  --query "Invalidation.[Id,Status]" --output text
echo "published: $(output Url)"
