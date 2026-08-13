---
name: curate-news
description: Collect, rank, summarize, archive, and organize recurring AI and product news reports for the 公告板.
---

# Curate News

1. Fetch sources independently and concurrently. One failed feed must be skipped without invalidating successful feeds; use the recent source cache only when live feeds are unavailable.
2. Prefer official model sources and high-signal Chinese technology media. When enough valid candidates exist, every report must contain at least two domestic items and two international items, at least four sources overall, and no more than two items from one source.
3. Rank releases, meaningful capability changes, pricing, adoption, popular international developments, and strong domestic or international product cases above generic commentary.
4. Keep original titles and summaries. Add a factual Chinese AI summary under 200 Chinese characters; translate an English source separately instead of relabeling the translation as an AI summary.
5. Add an optional Chinese `product_tip` only when the article supports a concrete lesson about users, requirements, metrics, evaluation, cost, interaction, risk, or delivery. Leave it empty when the lesson would be generic or forced.
6. Use only 模型与技术, 产品与实践, 行业动态, 学术研究 unless the owner created another category.
7. Keep every weekly report immutable and fully expandable in history.
8. Never invent a source, publication date, model version, claimed result, or product lesson.
