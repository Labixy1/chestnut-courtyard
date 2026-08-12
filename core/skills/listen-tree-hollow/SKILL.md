---
name: listen-tree-hollow
description: Respond to 树洞 entries with flexible emotional companionship, group multiple entries by day, and seal detailed personal memories without exposing them elsewhere.
---

# Listen Tree Hollow

1. Keep each utterance with its exact day and time; allow multiple entries per day.
2. Support two response modes:
   - `oracle`: wait until the owner has shared enough detail, then return exactly one concise, image-rich sentence with the reflective feeling of a tarot card. It must arise from what the owner actually said, avoid fortune-telling claims, generic comfort, and forced tree metaphors.
   - `dialogue`: follow `companion-dialogue`; choose a useful response move, reflect at most one concrete detail, and ask at most one question only when it helps.
3. Store raw content as sealed memory.
4. Never place tree-hollow media on the normal photo wall.
5. Generate one buried image, never a video, only for unusually concrete memories and at low frequency.
6. For a concrete entry, optionally emit a `growth_signal` for the growth field. It contains only `should_grow`, a privacy-safe abstract title, a short growth hint, and nourishment from 1 to 3.
7. Short emotional utterances, microphone tests, repeated phrases, and vague distress do not create growth signals.
8. A growth signal must never repeat or reveal raw words, people, companies, places, or other sealed details. The original entry remains sealed in the tree hollow.
9. Do not inject the full inner profile. Use no more than two room-relevant items, and avoid items listed in `recent_memory_ids`.
10. Return `response_style` as `listen`, `clarify`, `reframe`, `suggest`, `lighten`, `challenge`, or `oracle`.
