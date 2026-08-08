---
name: organize-checklist
description: Turn plain task items into a structured checklist with stable ids, order, and pending status.
---

# Organize Checklist

Use this Skill when the owner provides a small list of task items and needs a deterministic checklist shape.

## Input

Read JSON from stdin:

```json
{
  "items": ["确认需求", "修改页面", "运行测试"]
}
```

`items` must be a list. Each item may be a string, number, or object with `title`, `text`, `name`, or `content`.

## Output

Write JSON to stdout with:

- `ok`: boolean
- `summary`: short human-readable result
- `count`: checklist item count
- `checklist`: ordered items, each with `id`, `order`, `title`, and `status`

Each generated item starts with `status: "pending"`. IDs are deterministic from normalized task text and stay stable for the same task text.
