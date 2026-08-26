# Requirements

## Intent Analysis
- **Request type**: Feature enhancement and bug fix
- **Scope**: Browser project form and project-list state
- **Complexity**: Simple

## Functional Requirements
1. New project form offers Personal and Work choices.
2. User enters a free-text project name.
3. Personal and Work choices prefill their corresponding homeserver base folder.
4. Syncthing setup prefills the corresponding Mac base folder.
5. Both base-folder values remain editable.
6. Final homeserver and Mac project paths append the project name to the selected/edited bases.
7. A successfully created project appears immediately in the projects list and becomes selected.
8. Existing API validation and persistence remain authoritative.

## Defaults
- Personal homeserver base: `/home/ilia/Work/personal_projects`
- Personal Mac base: `/Users/iliagerman/Work/personal_projects`
- Work homeserver base: `/home/ilia/Work/Sela`
- Work Mac base: `/Users/iliagerman/Work/Sela`

These values follow existing path mappings in `src/pi-service.ts` and are editable before submission.

## Non-Functional Requirements
- Native accessible form controls; no new dependency.
- Stable `data-testid` values for new controls.
- Existing project APIs remain compatible.
- PWA cache version must change with static asset updates.

## Extension Configuration
User requested implementation without further questions. Optional resiliency, security, and property-based-testing extensions are skipped for this local UI enhancement.
