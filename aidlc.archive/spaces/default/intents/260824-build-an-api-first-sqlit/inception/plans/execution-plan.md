# Execution Plan

## Scope and Risk
- **Transformation**: Existing project-creation UI behavior.
- **Affected components**: `public/index.html`, `public/app.js`, `public/sw.js`.
- **API/data model changes**: None.
- **Risk**: Low; rollback is a static-file revert.

## Stages
- [x] Workspace Detection
- [x] Reverse Engineering
- [x] Requirements Analysis
- [x] User Stories - Skipped; requirements are explicit and involve one user flow.
- [x] Workflow Planning
- [x] Application Design - Skipped; no new component or service.
- [x] Units Generation - Skipped; one small unit.
- [x] Functional and NFR Design - Skipped; straightforward native form behavior.
- [x] Infrastructure Design - Skipped; no infrastructure impact.
- [ ] Code Generation
- [ ] Build and Test

## Sequence
1. Replace full-path fields with type and editable base-folder controls.
2. Prefill bases and derive final paths in browser code.
3. Insert the API result into client project state immediately.
4. Bump PWA cache.
5. Typecheck and build.

## Success Criteria
- Personal and Work update both editable bases.
- Submission derives paths from base plus project name.
- Created project is rendered in the list without relying on a second fetch.
- TypeScript checks and build pass.
