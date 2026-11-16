# Starter Python agent guidance

Own the private LangGraph-lane wheel distribution and build-time verification.
The package root reads its manifest; `src/build.ts` exports build helpers.

Keep the wheel set derived from the adapter inventory. Never import a galaxie
runtime or adapter package here, publish this package, or weaken ADR-0012 controls.
Run the distribution conformance tests and both repository typechecks.
