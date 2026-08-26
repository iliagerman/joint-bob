# Managed project import execution plan

1. Add test-first coverage for copy, move, move-with-link, complete local contents, destination collision, UI controls, and Syncthing ignores.
2. Add a filesystem import module using Node filesystem primitives with explicit boundary validation and cross-device move support.
3. Extend project creation input with optional `sourcePath` and `importMode` fields and run the import before project registration.
4. Extend the Add project dialog with source-folder selection and the three requested operations.
5. Strengthen root and nested `node_modules` Syncthing exclusions while preserving local files.
6. Bump the PWA cache and update user documentation.
7. Run focused tests, typecheck, full tests, and build.
