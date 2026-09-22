# 真实场景用例

这里保留开发中在本机实测过的经营/战斗程序。从 `work/` 移入时只调整了 SDK import 路径。它们是固定 fixture 的流程用例，输出仍写入被忽略的 `work/` 和独立 profile。

这些片段的前置页面不同，不要自动并行执行。统一回归入口为 `scripts/verify.ps1`；下表用于定向复现经营步骤，点击前用 `ui.snapshot` 检查当前页面。

| 程序 | 实测前提和内容 |
|---|---|
| research-smoke.ts | 有 SimpleResearchBench 的 fixture；选择 TreeSowing 并开始 |
| semantic-smoke.ts | fixture 人物 Human664；12 点作息设 Sleep，再恢复 Anything |
| slider-smoke.ts | Options/Audio；改真实音量滑块并恢复 |
| bill-smoke.ts | 含 FueledStove71890；打开 Bills/Add bill |
| bill-details-smoke.ts | 简餐 Details 已打开；次数 12、材料搜索半径 25 |
| bill-mode-smoke.ts | 模式菜单已打开；选择目标库存模式 |
| prepare-economy.ts | 显式 fixture 模式；布置用于测试的土壤、商人与资金 |
| growing-smoke.ts | 16 格种植区已建，作物菜单已打开；水稻、扩至 20、缩回 16 |
| storage-start.ts | 地图可操作；真实划定 (145,138)…(147,140) 仓储区 |
| storage-smoke.ts | 仓储 Storage 页；清空、搜索/允许钢铁、Critical 优先级 |
| trade-start.ts | 商人 Human139097 存在；殖民者接交易任务并走到商人旁 |
| trade-verify.ts | Dialog_Trade 已打开；钢铁 10、布料 5，核对银币与请求去重 |
| construction-smoke.ts | 木墙材质菜单已打开；墙拖放、门、旋转床；`--resume` 跳过放墙 |
| movement-smoke.ts | 人物可征召；真实 Goto 并等待到达，再解除征召 |
| combat-smoke.ts | Starry 与 PolarBear38282；原近战任务造成伤害，结束恢复测试前存档 |

证据和存档名记录在 `docs/development-log.md`、`docs/1.0-ready.md`。fixture 的原生生成仅为测试准备，路径明确标为 `fixture`；被验收的经营操作走 UI。
