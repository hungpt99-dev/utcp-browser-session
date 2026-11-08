# Screenshots

Every image in this directory was captured from a running instance by
`scripts/capture.mjs`:

```bash
npm run build
xvfb-run -a node scripts/capture.mjs
```

The script starts the fixture website and a real runtime, loads the unpacked
extension into Chromium, then drives the product through the UI:

1. pair the extension from its popup,
2. sign in to the fixture site,
3. enable the site through the dashboard form and start discovery,
4. click around the site so the extension records its API,
5. generate drafts, open the inspector, approve and execute a tool,
6. open the execution inspector and the security centre.

| File | View |
| --- | --- |
| `01-extension-popup.png` | Extension popup: connected, one approved domain capturing |
| `02-dashboard-overview.png` | Overview with a live run: 10 discovered APIs, 1 approved tool, 1 execution |
| `03-websites-discovery.png` | Websites view with the discovered endpoint table |
| `04-tool-approval.png` | Tool inspector for a draft write tool, input schema visible |
| `05-tool-execution.png` | The same tool approved and executed from the inspector |
| `06-execution-inspector.png` | Execution record: sanitized metadata and redacted preview |
| `07-security-center.png` | Audit trail, paired browsers, revoked tools |
| `demo.gif` | 34 s recording of the workflow above |

These are not mockups. The runtime is local, the data comes from the fixture
site, and the JSON in the inspector is the real response.
