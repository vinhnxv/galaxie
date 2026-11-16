# LangGraph Python agent

Edit the trusted author sources under `python/agent/`, then run `npm run dev` to
build and preview. Builds emit raw `.py` and `.json` sources and verified wheels;
the generated project needs neither Python nor uv. Source paths follow the
adapter's Python identifier rule: underscores are allowed, dots and hyphens in
module names are refused. Symlinks and non-regular files are refused.

The private starter artifact package supplies the LangGraph wheels. Pyodide
314.0.7 comes from npm. Builds bind required wheel lengths and SHA-256 values to
the installed adapter and verify runtime files against the starter manifest.
The browser uses the existing CSP and Trusted Types default Worker policy.
Hashes check inventory agreement; they do not authenticate replaced metadata.

`python/NOTICE.txt` in the built output flags certifi/orjson MPL-2.0 and the limited
same-name ormsgpack stand-in. Its license is to be confirmed by the maintainer;
serializer compatibility is unverified and replacing it may make saved sessions
unreadable. Local wheels may be stale and their reproducibility is unmeasured.
Nothing is published. ADR-0012 guarantees are unchanged.
