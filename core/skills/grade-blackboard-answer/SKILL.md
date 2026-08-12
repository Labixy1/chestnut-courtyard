---
name: grade-blackboard-answer
description: Grade open-ended blackboard answers like a strong political essay examiner and tutor. Give fair process credit, recognize valid alternative reasoning, explain what already works, and teach the owner how to strengthen or correct the answer.
---

# Grade Blackboard Answer

## Goal

Grade the submitted answer, not keyword overlap with a model answer. The owner should leave knowing what they already understood, why that reasoning has value, where the argument breaks, and how to make the next answer materially better.

## Workflow

1. Read the question first and independently form the expected reasoning before reading the submitted answer. Use the frozen `rubric` and `reference` as anchors, never as a keyword checklist.
2. Identify the question type before grading: explanation, comparison, decision/design, or reflection/transfer. Use its frozen `task_scoring_focus`; never force decision metrics onto an explanation question.
3. Judge four non-overlapping dimensions. Apply one main deduction to one defect: do not subtract again in another dimension merely because it has the same root cause.
4. For each dimension, select one supplied `score_bands` band first, then choose an integer inside that band. Do not invent an unanchored score.
5. Quote a short exact fragment for every positive score. Explain why that fragment is useful and how complete the reasoning currently is.
6. Compare each reference point only to diagnose coverage. Use `equivalent` when the owner gives a different but equally valid argument. A missing reference point does not automatically mean zero points.
7. If the answer is directionally right, teach along its existing line of thought: name the missing causal link, example, method, indicator, condition, or counterexample and show where to add it.
8. If the answer is directionally wrong, identify the exact inference that failed, explain why, then give a correction path in reasoning order. Do not merely reveal a model answer.
9. Produce a minimal revision that preserves the owner's conclusion, wording, and order wherever they remain defensible. Add only what is necessary to demonstrate a stronger answer.
10. Keep the frozen question, rubric, reference, score bands, and task profile unchanged. Never change the scoring standard after seeing the answer.

## Scoring

- `题意理解与核心判断` (20): Only whether the answer identifies the right object, task, and scope and forms a relevant, basically accurate judgment. Missing breadth or shallow support belongs elsewhere. Treat time-sensitive facts without reliable materials as unverified, not automatically wrong.
- `任务完成与要点覆盖` (30): Only whether explicit sub-questions and necessary analytical angles are covered and prioritized. A reasonable alternative point counts as equivalent. An included but underexplained point belongs to reasoning, not a second coverage deduction.
- `推理链条与证据支撑` (30): Only whether included claims are supported through causes, mechanisms, comparisons, conditions, facts, examples, or inference. An entirely absent point is handled only under coverage.
- `边界意识与迁移应用` (20): Whether the owner can show where the idea applies through a task-appropriate example, scenario, trade-off, check, constraint, or counterexample. Follow `task_scoring_focus`: explanation questions need conceptual boundaries/examples; comparison questions need common dimensions/trade-offs; decision questions need criteria/validation/boundaries; reflection questions need transferable principles/conditions.

Use the five frozen bands exactly: `excellent`, `solid`, `developing`, `weak`, and `absent`. The band must agree with the integer score. Short answers can score well when precise; length is never a criterion.

## Invalid Output

Retry instead of returning any of the following:

- Treats `reference` wording as mandatory or gives zero merely because a reference phrase is absent.
- Says a concept is absent when that concept appears in the answer.
- Gives generic advice such as “补充具体方案和指标” without naming the missing reasoning link, action, example, or observation.
- Demands metrics, rollout steps, product data, or company information that the detected question type did not ask for.
- Marks a time-sensitive fact wrong without support from the supplied materials or another reliable source.
- Uses empty praise, encouragement, or repeated diagnosis in place of explanation.
- Rewrites the owner's conclusion or fabricates claims they did not make.
- Returns a `minimal_revision` that has little wording overlap with the submitted answer.
- Gives a directionally wrong answer no correction path, or a directionally sound answer no explanation of what already works.

## Output Contract

Return JSON only:

```json
{
  "score_breakdown": [
    {"rubric_id": "comprehension", "criterion": "题意理解与核心判断", "max": 20, "awarded": 0, "band": "absent", "evidence": "原答案短引；本项零分时为空", "reason": "对象、任务、范围与核心判断是否准确", "teaching": "怎样校准题意、范围、判断或概念"},
    {"rubric_id": "coverage", "criterion": "任务完成与要点覆盖", "max": 30, "awarded": 0, "band": "absent", "evidence": "原答案短引", "reason": "明确子任务和必要角度覆盖到什么程度", "teaching": "还需补哪一个真正缺失的任务或角度"},
    {"rubric_id": "reasoning", "criterion": "推理链条与证据支撑", "max": 30, "awarded": 0, "band": "absent", "evidence": "原答案短引", "reason": "已有观点的原因、机制、比较、条件或证据质量", "teaching": "应补上的推理连接、例证或反证"},
    {"rubric_id": "transfer", "criterion": "边界意识与迁移应用", "max": 20, "awarded": 0, "band": "absent", "evidence": "原答案短引", "reason": "能否按当前题型说明适用范围并迁移理解", "teaching": "可直接加入的例子、场景、取舍、验证、限制或反例"}
  ],
  "score_summary": "一句话概括当前水平和最值得提升处",
  "requirement_map": [
    {
      "reference_point": "逐字复制一条 reference",
      "relation": "covered|partial|equivalent|not_covered|off_track",
      "evidence": "原答案短引；not_covered 或 off_track 时为空",
      "assessment": "它与参考思路是什么关系，为什么",
      "teaching": "怎样利用、补充或纠正这一处"
    }
  ],
  "strengths": [{"evidence": "原答案短引", "why_good": "这处思考好在哪里、为什么有价值"}],
  "direction": "correct|partly_correct|misdirected",
  "correction_path": "方向正确时给升级顺序；方向错误时说明错误推理并给纠正顺序",
  "priority_fix": "最优先提升的一件事，写清动作和判断标准",
  "minimal_revision": "保留原答案顺序与主张的补强版",
  "next_question": "可选的一道针对性练习",
  "next_question_reference": ["可选的练习参考要点"]
}
```

`score_breakdown` must exactly match the supplied frozen rubric. Select each row's `band` from its frozen `score_bands` before choosing `awarded`; they must agree. `requirement_map` must exactly match the supplied reference order. Do not return `standard_points`, `polished_answer`, generic `diagnosis`, or generic `thinking_directions`.
