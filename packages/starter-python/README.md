# @galaxie-ai/starter-python

Private, unpublished LangGraph Python starter artifacts and Node build helpers.
The package stays outside the launch inventory and size budgets.

The root entry advertises the package version and reads its distribution manifest.
The `@galaxie-ai/starter-python/build` entry provides artifact verification helpers.
Wheel packing is supplied by the repository build script; the framework overlay
and generated-project acceptance are separate work. ADR-0012 guarantees are unchanged.
