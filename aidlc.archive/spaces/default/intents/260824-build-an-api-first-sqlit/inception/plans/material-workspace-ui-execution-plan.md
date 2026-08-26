# Material Workspace UI Execution Plan

## Analysis
- **Project type**: Brownfield, framework-free browser client.
- **Transformation**: Substantial presentation-system refresh; behavior and API contracts remain unchanged.
- **User-facing impact**: Whole application shell on desktop and mobile.
- **Risk**: Medium; broad CSS can regress responsive layouts or obscure controls.

## Workflow
- Reuse completed reverse engineering.
- Record bounded requirements and implementation plan.
- Skip architecture/data/infrastructure design because DOM and API boundaries do not change.
- Use test-first CSS/DOM contracts, then browser verification at desktop and phone viewports.

## Implementation Sequence
1. Add a failing frontend contract test for Material tokens, desktop workspace, focus states, mobile safe-area navigation, and PWA cache version.
2. Replace visual tokens and add restrained Material-style component overrides.
3. Update browser theme colors and PWA cache name.
4. Run tests, syntax checks, typecheck, and build.
5. Restart the local Mac app behind existing Tailscale Serve.
6. Verify desktop and phone layouts in a real browser, including overflow and console errors.

## Success Criteria
All requirements in `aidlc-docs/inception/requirements/material-workspace-ui.md` pass with no dependency or server/API changes.
