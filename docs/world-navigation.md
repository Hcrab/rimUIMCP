# 世界地图桥接

`game.state.world({originTileId, cursor, limit})` 返回世界物体、聚落与势力、选中物体、路线规划器状态。分页显式返回 `nextCursor` 和 `truncated`。`angularDistanceDegrees` 只用于球面位置排序，不是商队行程估计。

`game.state.worldTile(tileId, layerId)` 返回坐标、相邻地块和原始 Tile 对象引用；继续通过只读字段查询探索生物群系、道路等。

打开世界地图用 `game.ui.panel('world').open()`，重复调用保持打开。`game.world.reveal(tileId)` 移动游戏内镜头；`game.world.click(tileId, {button:'right'})` 将地块投影为游戏内部屏幕坐标，通过原版 OnGUI MouseDown/MouseUp 处理。没有操作系统输入，也不直接调用商队或路线命令。

通常流程：选中家园 → Form caravan → 在世界地图右键目的地 → `world.overlay` 中 Accept → 原版商队对话框选择人员与物资 → Send。商队抵达后通过原版贸易窗口购买，再从世界地图下达返程。

点击只说明输入已处理；随后读 `selectedObjectIds`、`route.waypoints` 或对话框验证结果。原版路线规划器计算实际时间，不能用地块编号差或球面距离冒充行程时间。窗口阻挡、加载中、地块越界、图层不符分别返回明确错误。

世界视图和选中世界物体参与 UI 引用失效；读档或重启之后所有旧 ObjectRef/控件快照必须重新获取。

商队的 `Automatically select travel supplies` 使用贴近文字的复选框。桥接按原版缩窄后的实际矩形捕获控件；Pro-04在原窗口已验证关闭、恢复及取消编队。见 runs/pro-04/checkbox-world-verified.json。
