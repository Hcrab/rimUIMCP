# Helper 使用指南

这些模块把重复的观察与界面操作组合起来，帮助脚本把精力放在经营目标与战术决策上。从下表挑选需要的模块，直接从对应 `.ts` 文件导入。安装连接见 [README](../../README.md)，请求与执行语义见 [架构指南](../../architecture.md)。

## 按任务选择

| 模块 | 常用入口 | 用途 | 执行方式与使用要点 |
| --- | --- | --- | --- |
| [observe](observe.ts) | queryAll / inventoryNear / inventoryPermissionsNear / recordValues | 通用分页、周边库存、禁用标志与人物记录 | 读取；queryAll 默认同 tick 校验，调用方安排暂停，或显式 sameTick:false |
| [pawns](pawns.ts) | readAllPawns | 读取完整人物列表并保留分页证据 | 读取；多页时由 pauseForConsistency 回调暂停，返回 resumeRequired |
| [colony-inspection](colony-inspection.ts) | inspectColony | 人物、物品、房间、屋顶、仓储与心情巡检 | 读取；传当前 lease.expectedColonists；报告覆盖缺口与混合 tick |
| [inspection-summary](inspection-summary.ts) | formatInspectionSummary | 把巡检报告变成易读摘要 | 纯格式化 |
| [pawn](pawn.ts) | selectPawn / ensureDrafted / prioritize | 选人、征召与指定工作 | 真实 UI；工作接收后由调用方观察完成 |
| [work](work.ts) | setPriority / setPriorities | 设置人物工作优先级 | 真实 UI；开启手动优先级，0–4；0 禁用 |
| [schedule](schedule.ts) | readSchedule / ensureSchedule | 读取与设置 24 小时作息 | 读取 / 真实 UI；小时顺序为 0–23 |
| [equipment](equipment.ts) | wear | 指定装备或衣物并确认实际归属 | 真实 UI + runAndWatch 推进时间 |
| [health](health.ts) | worseningConditions | 逐个健康状况比较新增或恶化 | 纯计算 |
| [bed](bed.ts) | ensureBedOwner | 通过床位归属窗口分配并读回 | 真实 UI；调用方选择床和人物 |
| [custody](custody.ts) | custodyExitAlert / readCustodyExitAlert | 持续跟踪被收容人物的离开迹象 | 计算 / 读取；调用方维护 tracked 集合 |
| [architect](architect.ts) | selectTool / designateRectangle / ensureBuildings / ensureBuildingLine | 选择建造工具、矩形指定与建筑布局 | 真实 UI；单独 selectTool 后继续操作时由调用方持有 sequence |
| [areas](areas.ts) | allowedArea / assignAllowedArea | 读取与指定当前地图允许区域 | 读取 / 真实 UI；按人物与地图定位 |
| [growing](growing.ts) | ensureGrowingZone | 创建种植矩形并选择作物 | 真实 UI；allowPartial 控制是否接受地形造成的缺格 |
| [layout](layout.ts) | occupiedRect / overlaps / diningSeats / readBuildingGeometry | 占地几何、冲突与候选餐位分析 | 计算 / 读取；路径与使用条件由游戏规则判定 |
| [navigation](navigation.ts) | showMap | 通过世界地图对象切换到目标地图 | 真实 UI；提供 mapId、tileId、worldObjectId 并读回 |
| [production](production.ts) | ensureBill | 配置配方、重复方式、数量与原料 | 真实 UI；调用方给 stationId、recipe、menuLabel 及目标字段 |
| [food](food.ts) | ensureFoodPolicy / configureHopper | 人物食物政策与料斗原料设置 | 真实 UI；读取实际人物 ID 和目标政策 |
| [storage](storage.ts) | stockpileSettings / ensureStockpile | 仓储读取、物品筛选与优先级 | 读取 / 真实 UI；只更新计划涉及的物品允许项和优先级 |
| [resources](resources.ts) | readResources | 汇总地面和指定人物容器中的资源 | 读取；提供 pawnIds、home 和可选 radius |
| [research](research.ts) | ensureResearch / researchProgress | 选择科研项目与读取阶段进度 | 真实 UI / 读取；调用方给项目 ID |
| [science](science.ts) | scannerCandidate / runScannerShift | 选择合适研究人员执行限时扫描班次 | 计算 / 真实 UI + 时间推进；明确工人、扫描器、截止时间 |
| [tactical](tactical.ts) | setDoorHoldOpen / moveDrafted | 门保持开启指令与征召移动 | 真实 UI；保持开启指令与门实际打开状态分别观察 |
| [letters](letters.ts) | classifyLetters / readLetterBatch | 把待处理信件分为延后与紧急 | 计算 / 读取；调用方决定暂停和关闭信件 |
| [flow](flow.ts) | runAndWatch | 运行一段时间并按状态、信件或自定义条件返回 | 时间控制；finally 尝试暂停，返回停止原因与观察 |
| [supervision](supervision.ts) | guardSupervisedGame / connectSupervised / latchHandoff | 可选规划/执行角色交接与恢复前威胁检查 | SDK 调用包装与本地控制文件；operator 受检查，director 使用原 SDK |
| [selection](selection.ts) | selectThing | 选择具体地图对象并验证引用 | 真实 UI |
| [ui-text](ui-text.ts) | UI_TEXT / requireLocalizedNode / selectorForUiNode | 匹配常用中英文标签并构造明确选择条件 | 纯计算；使用当前快照和角色、所有者等条件 |

## 组合一个流程

先连接 SDK 并读取当前 session、地图和目标对象，再用 `queryAll` 或 `readAllPawns` 收集需要的数据。用对象 ID 指定人物和建筑；用当前 UI 快照定位菜单和控件。把依赖同一界面的连续动作放进短 `game.sequence`，之后根据返回证据读回结果。

`ensure*` 通常先检查现状，再修改需要调整的项目；返回细节以各函数签名和实现为准。建造蓝图、接受工作和实际完工是不同阶段，调用方可分别设置观察条件。多步操作已完成的部分会保留，失败后从实际状态继续。

## 安排游戏时间

大多数 UI 配置模块主要负责下令。`equipment.wear`、`science.runScannerShift` 会推进受监控的游戏时间；`flow.runAndWatch` 负责运行和停止原因。让同一个执行者统筹时间，可以把观察、下令和后续验证衔接起来。

`queryAll` 默认校验同 tick；先暂停可获得稳定多页数据。需要运行中观察时显式设置 `sameTick:false`，结合返回 pages 判断时段。`readAllPawns` 的分页重启通过调用方提供的 pauseForConsistency 暂停；返回 resumeRequired 后由调用方恢复。`inspectColony` 直接记录混合 tick 与 coverage gaps，适合后台巡检。

## 把当前殖民地配置传进来

人物 ID、建筑 ID、坐标、科研项目与原料由调用脚本提供。`inspectColony(game, lease)` 的 lease 可携带 sessionId、worldEpoch、expectedColonists；expectedColonists 使用当前殖民地的 `{id,name}[]`，省略时使用文件顶部保留的历史参考名单。`supervision` 另用调用方指定的 control.json 做角色交接；这是可选组织方式，普通 `connect()` 同样适用。

## 添加一个 Helper

写清楚输入是谁、需要哪个界面、是否推进时间、如何读回和返回什么证据。把可以独立验证的筛选/计算与 GUI 操作分开，复用 `ui-text` 和 `selection` 的定位能力。注释优先解释选择原因、时间副作用与结果含义。单元测试可以使用 SDK mock；具体菜单、布局和 Mod 兼容性再用隔离实机存档验证。
