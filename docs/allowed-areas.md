# 允许区域：用原版区域分工

`AllowedAreaAdapter.cs` 将日程表中的每个人物、每个区域格暴露为真实 UI 控件。它包裹原游戏 `AreaAllowedGUI.DoAreaSelector`，向当前控件发送鼠标事件；原方法决定是否修改区域。适配器不直接写人物设置。

```ts
import { assignAllowedArea, allowedArea } from '../agent/helpers/areas.ts';

await assignAllowedArea(game, pawnId, areaId);
console.log(await allowedArea(game, pawnId));
await assignAllowedArea(game, pawnId, null); // Unrestricted
```

低层定位器是 `actionId: 'schedule.area'`、`ownerId: pawnId`、`rowKey: String(areaId)`、`source: 'rp.allowed_area'`；不限制区域使用 `rowKey: 'unrestricted'`。先打开日程表。区域 ID 属于当前地图，不能将另一张地图的字典条目当作本图设置；读档后重查对象引用。Helper 会核对实际分配，重复调用不再点击。

创建、命名、反选和增减区域仍使用“Manage areas...”及原版区域画笔。调用者明确决定区域内容，Helper 不自动圈住人物或删除其他区域。

Pro-04 实测：创建一个全图允许区，仅去除三张研究台的锚点，并将 Talia 分配至此。她自主使用扫描器，正常进食、睡眠，其他人继续研究。没有反复发送优先扫描命令。该分工适用于本村当前台位；研究台移动或新增后需更新区域。

验证：真实 UI 分配、解除、重新分配、幂等，以及其他五人不受影响均已读回；四项 Helper 回归覆盖当前地图选择、幂等、结果未接受和会话改变。第一版适配只暴露控件但输入未反应，补接现有 Unity `Ignore` 事件处理后实机通过。
