---
name: build-skill
description: Create a reusable executable Skill when 阿栗 lacks a capability needed to complete an owner request.
---

# Build Skill

1. Reuse or compose existing tools before creating a Skill.
2. Require steward permission before creating executable code.
3. Create `SKILL.md`, `tool.json`, and `scripts/run.py` under `core/private_skills/<name>/`; never place instance-created Skills in the public built-in directory.
4. Accept JSON on stdin and return JSON with `ok` and `summary`.
5. Use narrow permissions and deterministic Python standard-library code.
6. Run a realistic example before registering the Skill.
