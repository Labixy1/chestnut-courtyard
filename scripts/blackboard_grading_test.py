#!/usr/bin/env python3
"""Contract tests for fair, tutoring-style blackboard grading."""

from cozy_server import (
    attach_frozen_rubric,
    blackboard_grade_needs_retry,
    blackboard_task_profile,
    finalize_blackboard_grade,
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


def main():
    reference = ["先进行线上A/B测试", "收集用户主观反馈"]
    question = attach_frozen_rubric({
        "date": "2026-08-12", "title": "模型上线验证",
        "question": "怎样验证新模型是否值得上线？", "standard_points": reference,
        "alignment_version": 4,
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
    assert question["reference_frozen_at"] and question["question_fingerprint"]

    answer = "我不会直接A/B放量，而是先让新模型只在影子模式处理真实流量，离线比较错误率和成本，达到阈值再逐步灰度。"
    context = {"question": question["question"], "reference": reference, "rubric": rubric}
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
        "minimal_revision": answer + "灰度阶段再记录用户反馈，异常率上升就回滚。",
    }
    retry = blackboard_grade_needs_retry(answer, context, result)
    assert not retry
    finalized = finalize_blackboard_grade(result, context)
    assert finalized["requirement_map"][0]["relation"] == "equivalent"
    assert finalized["total_score"] == 83
    assert "同一缺陷只归一个维度" in finalized["grading_policy"]
    assert [row["band"] for row in finalized["score_breakdown"]] == ["excellent", "solid", "solid", "solid"]

    invalid = {**result, "strengths": [], "correction_path": ""}
    assert blackboard_grade_needs_retry(answer, context, invalid)

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
        "minimal_revision": "只让每台设备定时下载服务器完整数据并不能保证不会冲突；还要记录删除墓碑与版本号，上传时比较版本，可合并字段自动合并，其余交给主人选择。",
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
    assert "do not subtract again" in skill
    print("blackboard grading test ok: v3 rubric; task profiles; score bands; equivalent reasoning; no double deduction")


if __name__ == "__main__":
    main()
