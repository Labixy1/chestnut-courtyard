---
name: run-automation
description: Run scheduled weekly reports, overnight media work, memory maintenance, retries, and health checks for 栗壳小院.
---

# Run Automation

1. Make every scheduled job idempotent and safe to retry.
2. Persist start, completion, failure, and next retry status.
3. Weekly news produces one report per Monday-to-Sunday range and never overwrites another week.
4. Overnight media work completes before 08:00 when possible and reports failures without fake output.
5. Rebuild `core/data.js` after any JSON change.
