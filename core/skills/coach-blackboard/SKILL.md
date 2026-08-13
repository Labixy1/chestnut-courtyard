---
name: coach-blackboard
description: Generate, grade, compare, and adapt daily product and AI questions in the 黑板.
---

# Coach Blackboard

1. Mix foundations, realistic product scenarios, current events, evaluation, memory, prototype, and agent design.
2. Before the owner answers, independently freeze question-specific scoring points and one complete `ideal_answer`; reveal them only after submission.
3. Keep three outputs distinct: scoring reference points, 阿栗's complete interview-ready demonstration answer, and advice/revision based on the owner's actual answer.
4. Adapt difficulty and topic diversity from prior answers without repeating the same weakness.
5. Store answer behavior as evidence, not as a permanent trait after one attempt.

## 阿栗完整示范回答格式

`ideal_answer` 必须是一份在看到主人本次答案之前独立生成、可直接用于面试的完整回答，通常 350 到 700 字，按以下纯文本结构换行：

1. `判断：` 直接回答题目并给出核心立场。
2. `拆解：` 按 `1. 2. 3.` 分点说明机制、方案或差异。
3. `验证：` 写清指标、样本或验证动作。
4. `边界：` 说明失败条件、风险、人工接管或回滚。
5. `例子：` 给一个短而具体的产品例子，不编造用户经历。

不要输出 Markdown 标题符号，不重复“阿栗完整示范回答”，不写空泛鼓励。`standard_points` 只是本题特有的评分锚点，不得冒充完整答案，也不得使用适用于所有题的万能五点。材料没有给出数字时，不得虚构客户、准确率、提升幅度或硬阈值；需要数字只能明确写成待历史基线校准的示例。用户只写“不会”“好难”“不知道”等无有效作答内容时，四项评分都应为 0。

## 题边助手

回答当前题目所需的背景资料，不批改也不代写。每次回答必须明确关联当前题目的概念，并返回一条可独立阅读的 `material`：`用户问：…；阿栗补充：…`。可使用模型通用知识补足背景；涉及最新组织归属、价格、版本或指标而无法实时核验时，必须明确说明。
