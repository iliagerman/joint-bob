#!/usr/bin/env node

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("GNU bash (Joint Bob supervised shell)\n");
  process.exitCode = 0;
} else {
  // Node's SQLite warning would otherwise precede every agent command's output.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && String(warning?.message ?? warning).startsWith("SQLite")) return;
    emitWarning.call(process, warning, ...rest);
  };
  const { runSupervisedShell } = await import("../scripts/supervised-shell.mjs");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    const result = await runSupervisedShell({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, signal: controller.signal, onData: data => process.stdout.write(data) });
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Supervised shell failed"}\n`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", abort); process.off("SIGTERM", abort);
  }
}
