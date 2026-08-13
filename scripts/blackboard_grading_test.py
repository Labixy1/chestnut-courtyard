#!/usr/bin/env python3
"""Contract tests for fair, tutoring-style blackboard grading."""

from cozy_server import (
    attach_frozen_rubric,
    blackboard_grade_needs_retry,
    blackboard_has_uncalibrated_numbers,
    blackboard_has_unsupported_specifics,
    blackboard_revision_distinct_from_ideal,
    blackboard_revision_needs_repair,
    blackboard_task_profile,
    finalize_blackboard_grade,
    normalize_blackboard_grade_candidate,
    valid_blackboard_ideal_answer,
    valid_blackboard_next_practice,
    valid_blackboard_next_practice_outline,
    valid_blackboard_plain_language_coaching,
    valid_blackboard_personalized_revision,
    qualify_blackboard_illustrative_numbers,
    sanitize_blackboard_unsupported_specifics,
)


def score_rows(answer: str):
    return [
        {"rubric_id": "comprehension", "criterion": "题意理解与核心判断", "max": 20, "awarded": 18, "band": "excellent",
         "evidence": "影子模式处理真实流量", "reason": "准确回应了如何低风险验证新模型。",
         "teaching": "把立场补成先无用户影响验证，再逐步扩大暴露。"},
        {"rubric_id": "coverage", "criterion": "任务完成与要点覆盖", "max": 30, "awarded": 23, "band": "solid",
         "evidence": "离线比较错误率和成本", "reason": "覆盖效果与成本，但还没有用户反馈。",
         "teaching": "在灰度阶段记录用户反馈，补足主观体验角度。"},
        {"rubric_id": "reasoning", "criterion": "推理链条与证据支撑", "max": 30, "awarded": 25, "band": "solid",
         "evidence": "达到阈值再逐步灰度", "reason": "指标、通过线和上线顺序形成因果链。",
         "teaching": "解释阈值为什么要按任务风险分层设置。"},
        {"rubric_id": "transfer", "criterion": "边界意识与迁移应用", "max": 20, "awarded": 17, "band": "solid",
         "evidence": "不会直接A/B放量", "reason": "识别了直接暴露真实用户的风险。",
         "teaching": "记录灰度异常率，并设置异常上升时的回滚条件。"},
    ]


def interview_revision(seed: str, subject: str) -> str:
    return (
        f"判断：{seed}。我的核心判断是，{subject}不能直接放量，而应先用低风险方式证明质量收益，再决定是否扩大。"
        "拆解：1. 先定义真实用户任务和旧方案基线。2. 让新旧方案在同一批样本上对照，并按任务风险分层。"
        "3. 对高风险任务增加人工确认和审计记录，确保模型能力提升不会带来不可逆副作用。"
        "验证：记录任务完成率、关键错误率、P95 延迟、单次成本和用户反馈，并为不同风险层设置明确通过阈值。"
        "边界：若严重错误未清零、敏感数据不合规或故障后无法回滚，即使平均效果更好也不能上线；结果状态未知时先查询而不是盲目重试。"
        "例子：可以先用影子模式处理真实流量，与旧模型离线比较错误率和成本；达到阈值后只灰度低风险任务，异常率上升立即回滚。"
    )


def learning_outputs(subject: str) -> dict:
    return {
        "plain_language_coaching": {
            "what_the_question_wants": f"这题不是让你背名词，而是要说明{subject}怎样形成可执行、可验证并且有边界的判断。",
            "answer_steps": [
                f"先用一句话给出{subject}的核心判断，不要从背景铺垫开始。",
                "再把判断拆成对象、动作和原因，让面试官听见完整推理链。",
                "最后给验证方法、失败边界和一个具体例子，证明方案能落地。",
            ],
            "remember": [
                f"{subject}要同时回答为什么做、怎么做和怎样确认做对了。",
                "没有边界和失败处理的方案，只是演示，不是可上线的产品判断。",
            ],
            "memory_hook": "先判断，再拆解；用验证收口，用边界兜底。",
        },
        "next_question": f"如果你负责{subject}，怎样用一个失败案例证明评测与回滚机制真正有效？",
        "next_question_reference": [
            "先说明要验证的失败风险和预期阻断结果",
            "再描述触发失败、记录证据和判断严重度的方法",
            "最后给出修复、复测、回滚与重新放量的条件",
        ],
        "next_question_ideal_answer": interview_revision(
            f"我会先选取{subject}中影响真实用户任务的失败案例，并冻结预期阻断结果", f"{subject}的失败案例验证"),
    }


def personalized_interview_revision(answer: str) -> str:
    return (
        f"判断：你原答案中的“{answer}”方向正确，关键价值是先隔离风险再用证据决定是否上线；我会保留这条主线，并把缺少的用户反馈和停止条件补齐。"
        "拆解：先说明目标任务和旧模型基线，再解释影子模式为什么能在不影响用户的情况下收集同分布结果；随后按高低风险任务分层，把低风险任务放入小流量灰度，高风险任务继续人工复核。"
        "验证：同一批请求同时记录新旧模型的关键错误、完成时间、单次成本和人工接管，并在灰度阶段增加用户反馈；通过线要在测试前确定，不能看完结果再移动标准。"
        "边界：敏感数据不合规、严重错误无法拦截、异常发生后不能回滚时，即使平均分更高也停止上线；未知执行状态先查询，禁止重复触发有副作用的动作。"
        "例子：报告分析可以先让新模型在后台影子处理，与现有结果逐条对照；证据稳定后只开放低风险摘要任务，一旦关键错误上升就自动回到旧模型，并保留失败样本复盘。"
    )


def main():
    reference = ["先进行线上A/B测试", "收集用户主观反馈"]
    question = attach_frozen_rubric({
        "date": "2026-08-12", "title": "模型上线验证",
        "question": "怎样验证新模型是否值得上线？", "standard_points": reference,
        "ideal_answer": interview_revision("我会先使用影子模式验证", "新模型上线"),
        "alignment_version": 5,
    })
    rubric = question["rubric"]
    assert [row["criterion"] for row in rubric] == [
        "题意理解与核心判断", "任务完成与要点覆盖", "推理链条与证据支撑", "边界意识与迁移应用"
    ]
    assert [row["max"] for row in rubric] == [20, 30, 30, 20]
    assert sum(row["max"] for row in rubric) == 100
    assert question["rubric_version"] == 3
    assert question["task_type"] == "decision"
    assert all(len(row["score_bands"]) == 5 for row in rubric)
    assert question["answer_independent"] is True
    assert valid_blackboard_ideal_answer(question["ideal_answer"])
    paraphrased_revision = interview_revision("先验证它能否改善用户任务，再比较质量成本和延迟", "模型接入")
    assert valid_blackboard_personalized_revision(
        paraphrased_revision,
        "我会先看它是否能改善用户任务，再和现有模型比较质量、成本和延迟，小范围灰度达到阈值后上线。")
    assert not valid_blackboard_personalized_revision(
        interview_revision("先检查完全无关的页面配色和字体", "视觉设计"),
        "用删除墓碑和版本向量处理多端同步冲突。")
    assert blackboard_has_uncalibrated_numbers("验证：准确率必须达到99.5%，单日超过50次就暂停。", {})
    assert not blackboard_has_uncalibrated_numbers("例子：示例阈值为99.5%，实际需由历史基线校准。", {})
    assert blackboard_has_uncalibrated_numbers(
        "验证：授权匹配率目标>99.5%，日志至少保留1年。",
        {"question": "怎样设计授权治理框架？", "materials": [], "reference": []})
    assert blackboard_has_uncalibrated_numbers(
        "验证：准确率目标>95%。",
        {"question": "怎样评测？", "materials": [], "reference": ["准确率目标>95%。"]})
    qualified = qualify_blackboard_illustrative_numbers("验证：准确率必须达到99.5%，单日超过50次就暂停。", {})
    assert "数字仅为示例" in qualified and not blackboard_has_uncalibrated_numbers(qualified, {})
    assert blackboard_has_unsupported_specifics("准入要求 ISO 27001 或 CNVD 资质。", {})
    assert not blackboard_has_unsupported_specifics(
        "资料明确要求 ISO 27001。", {"materials": ["本题资料明确要求 ISO 27001。"]})
    sanitized = sanitize_blackboard_unsupported_specifics("准入要求 ISO 27001 或 CNVD 资质。", {})
    assert "ISO" not in sanitized and "CNVD" not in sanitized and "企业安全资质" in sanitized
    assert question["reference_frozen_at"] and question["question_fingerprint"]

    answer = "我不会直接A/B放量，而是先让新模型只在影子模式处理真实流量，离线比较错误率和成本，达到阈值再逐步灰度。"
    context = {"question": question["question"], "reference": reference, "rubric": rubric,
               "ideal_answer": question["ideal_answer"]}
    result = {
        "score_breakdown": score_rows(answer),
        "score_summary": "走了更谨慎的有效验证路径，主要可补用户反馈。",
        "requirement_map": [
            {"reference_point": reference[0], "relation": "equivalent",
             "evidence": "影子模式处理真实流量，离线比较错误率和成本",
             "assessment": "没有照抄线上A/B，但完成同分布对照且风险更低。",
             "teaching": "把影子结果与旧模型做对照，并记录同任务错误率和成本。"},
            {"reference_point": reference[1], "relation": "not_covered", "evidence": "",
             "assessment": "还没有收集用户主观体验反馈。",
             "teaching": "在小流量灰度中访谈用户并记录满意度与问题类型。"},
        ],
        "strengths": [{"evidence": "达到阈值再逐步灰度", "why_good": "把通过条件与上线节奏连成了决策链。"}],
        "direction": "correct",
        "correction_path": "保留影子模式路径，补上分层阈值和灰度阶段用户反馈。",
        "priority_fix": "为高低风险任务分别设置错误率阈值，并记录灰度用户反馈。",
        "personalized_revision": personalized_interview_revision(answer),
        **learning_outputs("新模型上线验证"),
    }
    retry = blackboard_grade_needs_retry(answer, context, result)
    assert not retry
    finalized = finalize_blackboard_grade(result, context)
    assert finalized["requirement_map"][0]["relation"] == "equivalent"
    assert finalized["total_score"] == 83
    assert "同一缺陷只归一个维度" in finalized["grading_policy"]
    assert [row["band"] for row in finalized["score_breakdown"]] == ["excellent", "solid", "solid", "solid"]
    assert valid_blackboard_plain_language_coaching(finalized["plain_language_coaching"], question["question"])
    assert valid_blackboard_next_practice(finalized, context)
    outline_only = {**finalized, "next_question_ideal_answer": ""}
    assert valid_blackboard_next_practice_outline(outline_only, context)
    assert not valid_blackboard_next_practice(outline_only, context)
    assert blackboard_revision_distinct_from_ideal(result["personalized_revision"], question["ideal_answer"])
    assert not blackboard_revision_distinct_from_ideal(question["ideal_answer"], question["ideal_answer"])
    assert blackboard_grade_needs_retry(
        answer, context, {**result, "personalized_revision": question["ideal_answer"],
                          "minimal_revision": question["ideal_answer"]})
    assert blackboard_revision_needs_repair(
        answer, context, {**result, "personalized_revision": question["ideal_answer"],
                          "minimal_revision": question["ideal_answer"]})
    assert not blackboard_revision_needs_repair(answer, context, result)

    drifted = {**result,
        "score_breakdown": [{**row, "criterion": "近义评分项", "band": "weak",
                             "evidence": "先使用低风险影子方式"}
                            if index == 0 else row for index, row in enumerate(result["score_breakdown"])],
        "requirement_map": [{**row, "reference_point": "近义参考点",
                             "evidence": "先用影子流量验证"}
                            if index == 0 else row for index, row in enumerate(result["requirement_map"])],
        "strengths": [{"evidence": "逐步放量前要过门槛", "why_good": "把验证结果与上线节奏连成决策链。"}],
    }
    normalized = normalize_blackboard_grade_candidate(drifted, answer, context)
    assert normalized["score_breakdown"][0]["criterion"] == rubric[0]["criterion"]
    assert normalized["score_breakdown"][0]["band"] == "excellent"
    assert normalized["requirement_map"][0]["reference_point"] == reference[0]
    assert all(not row.get("evidence") or row["evidence"] in answer for row in normalized["score_breakdown"])
    assert normalized["requirement_map"][0]["evidence"] in answer
    assert normalized["strengths"][0]["evidence"] in answer
    assert not blackboard_grade_needs_retry(answer, context, normalized)
    terse_advice = {**result, "requirement_map": [
        {**result["requirement_map"][0], "teaching": "继续优化"},
        result["requirement_map"][1],
    ]}
    repaired_advice = normalize_blackboard_grade_candidate(terse_advice, answer, context)
    assert "执行对象" in repaired_advice["requirement_map"][0]["teaching"]
    assert not blackboard_grade_needs_retry(answer, context, repaired_advice)
    unsafe_advice = {**result, "priority_fix": "按 ISO 27001 或 CNVD 资质分级准入。"}
    safe_advice = normalize_blackboard_grade_candidate(unsafe_advice, answer, context)
    assert "ISO" not in safe_advice["priority_fix"] and "CNVD" not in safe_advice["priority_fix"]

    sparse_result = {**result, "score_breakdown": [
        {**row, "awarded": 26, "band": "solid"} if row["rubric_id"] == "coverage" else row
        for row in result["score_breakdown"]
    ], "requirement_map": [
        {"reference_point": reference[0], "relation": "partial", "evidence": "影子模式处理真实流量",
         "assessment": "只覆盖了一个局部验证动作。", "teaching": "补充完整测试范围并设置回滚条件。"},
        {"reference_point": reference[1], "relation": "not_covered", "evidence": "",
         "assessment": "尚未涉及用户反馈。", "teaching": "增加访谈并记录反馈类型。"},
    ]}
    sparse_finalized = finalize_blackboard_grade(sparse_result, context)
    assert next(row for row in sparse_finalized["score_breakdown"] if row["rubric_id"] == "coverage")["awarded"] == 19

    invalid = {**result, "strengths": [], "correction_path": ""}
    assert blackboard_grade_needs_retry(answer, context, invalid)
    assert blackboard_grade_needs_retry(answer, context, {**result, "plain_language_coaching": {}})
    assert blackboard_grade_needs_retry(answer, context, {**result, "next_question_ideal_answer": "只有提纲"})

    wrong_answer = "只要每台设备定时下载服务器完整数据就不会冲突。"
    wrong_reference = ["记录删除墓碑", "按版本合并并发修改"]
    wrong_question = attach_frozen_rubric({
        "date": "2026-08-12", "question": "多端同步怎样避免删除数据复活和并发冲突？",
        "standard_points": wrong_reference, "alignment_version": 4,
    })
    wrong_context = {"question": wrong_question["question"], "reference": wrong_reference, "rubric": wrong_question["rubric"]}
    wrong_result = {
        "score_breakdown": [
            {"rubric_id": "comprehension", "criterion": "题意理解与核心判断", "max": 20, "awarded": 4, "band": "weak",
             "evidence": "每台设备定时下载", "reason": "注意到了多设备状态，但把覆盖下载误当成冲突合并。",
             "teaching": "先区分下载最新状态与合并并发修改是两件事。"},
            {"rubric_id": "coverage", "criterion": "任务完成与要点覆盖", "max": 30, "awarded": 0, "band": "absent",
             "evidence": "", "reason": "删除防复活和并发合并两个任务都没有回答。",
             "teaching": "分别补写删除墓碑和版本冲突合并规则。"},
            {"rubric_id": "reasoning", "criterion": "推理链条与证据支撑", "max": 30, "awarded": 3, "band": "weak",
             "evidence": "定时下载服务器完整数据", "reason": "有同步动作，但不能推出旧删除不会复活。",
             "teaching": "解释旧设备上传时服务器为什么需要识别删除墓碑和版本号。"},
            {"rubric_id": "transfer", "criterion": "边界意识与迁移应用", "max": 20, "awarded": 1, "band": "weak",
             "evidence": "每台设备", "reason": "意识到有多个副本，但方案会覆盖离线修改。",
             "teaching": "设置版本比较、冲突记录和人工选择，禁止直接整库覆盖。"},
        ],
        "score_summary": "识别了多设备同步场景，但把拉取覆盖误当成冲突解决，方向需要纠正。",
        "requirement_map": [
            {"reference_point": wrong_reference[0], "relation": "off_track", "evidence": "",
             "assessment": "定时下载不能表达某条记录已经被删除，旧设备仍可能重新上传它。",
             "teaching": "记录删除墓碑及删除版本，并在所有设备确认后再清理。"},
            {"reference_point": wrong_reference[1], "relation": "not_covered", "evidence": "",
             "assessment": "原答案没有处理两台设备同时修改同一记录的情况。",
             "teaching": "比较版本并记录冲突，让可合并字段自动合并，其余交给主人选择。"},
        ],
        "strengths": [{"evidence": "每台设备", "why_good": "已经意识到问题来自多个状态副本，而不是单机保存。"}],
        "direction": "misdirected",
        "correction_path": "先否定整库覆盖能解决冲突的假设，再分别设计删除墓碑、版本比较和冲突处理。",
        "priority_fix": "先画出旧设备离线后重新上传已删除记录的时序，再定义墓碑判断规则。",
        "personalized_revision": interview_revision(wrong_answer + "我会改用删除墓碑与版本号", "多端同步"),
        **learning_outputs("多端同步冲突"),
    }
    assert not blackboard_grade_needs_retry(wrong_answer, wrong_context, wrong_result)
    assert finalize_blackboard_grade(wrong_result, wrong_context)["direction"] == "misdirected"

    assert blackboard_task_profile("什么是上下文工程，为什么重要？")["type"] == "explain"
    assert "不强求" in blackboard_task_profile("什么是上下文工程，为什么重要？")["focus"]
    assert blackboard_task_profile("比较 Cursor 和 Trae 的差异与适用场景")["type"] == "compare"
    assert blackboard_task_profile("复盘这次项目，你学到了什么？")["type"] == "reflection"
    assert blackboard_task_profile("复盘这次项目为什么失败？")["type"] == "reflection"
    assert blackboard_task_profile("上下文工程是什么？")["type"] == "explain"
    assert blackboard_task_profile("怎样决定 Agent 是否可以自动删除数据？")["type"] == "decision"

    invalid_band = {**result, "score_breakdown": [{**row, "band": "weak"} if index == 0 else row for index, row in enumerate(result["score_breakdown"])]}
    assert blackboard_grade_needs_retry(answer, context, invalid_band)

    source = open(__file__.replace("scripts/blackboard_grading_test.py", "scripts/cozy_server.py"), encoding="utf-8").read()
    skill = open(__file__.replace("scripts/blackboard_grading_test.py", "core/skills/grade-blackboard-answer/SKILL.md"), encoding="utf-8").read()
    assert "同一根因只能归入一个主要扣分维度" in source
    assert "3600 if staged_blackboard_grading" in source
    assert "staged_blackboard_grading = is_blackboard_grading" in source
    assert "generate_blackboard_next_ideal_answer" in source
    assert "next_question_ideal_answer" in source
    assert "temperature=0.25" in source
    assert "temperature=0.1 if is_blackboard_grading else 0.2 if is_blackboard_reference" in source
    assert "do not subtract again" in skill
    assert "plain_language_coaching" in skill and "next_question_ideal_answer" in skill
    print("blackboard grading test ok: v3 rubric; tutoring contract; complete next-practice answer; no double deduction")


if __name__ == "__main__":
    main()
