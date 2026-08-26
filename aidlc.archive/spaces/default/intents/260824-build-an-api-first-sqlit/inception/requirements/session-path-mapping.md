# Session Path Mapping Requirements

## Intent Analysis
- **Request type**: Bug fix and feature enhancement
- **Scope**: Project persistence, session discovery, filesystem watching, project settings UI, deployment data
- **Complexity**: Moderate

## Problem
Projects can have different homeserver and Mac working-directory paths. Session discovery currently relies on incomplete one-way hardcoded root mappings. Sessions written under the unmapped path are invisible.

## Functional Requirements
1. Every synced project stores its exact homeserver path and exact Mac path as one project-level pair.
2. Pi and Claude session discovery always searches both paths.
3. Filesystem session watching always watches both paths.
4. Path handling is direction-neutral: either member of the pair represents the same project.
5. New synced projects persist the Mac path already submitted by the project form.
6. Existing projects can set or correct their Mac path from the project list.
7. Updating a mapping takes effect without restarting the service.
8. Existing homeserver projects receive explicit Mac mappings during deployment.
9. Hardcoded project-specific mappings are removed.

## Validation Requirements
- Empty Mac mappings are rejected at the HTTP boundary.
- Automated tests cover paired paths, reversed pairs, path normalization, and projects without a second path.
- Typecheck and build pass.
- Production API returns recent Internal Assistant sessions after deployment.

## Non-Functional Requirements
- No new runtime dependency.
- Preserve existing project records without a `macPath` field.
- Preserve current session ordering and 20-session response limit.
- Bump the PWA cache when frontend assets change.
