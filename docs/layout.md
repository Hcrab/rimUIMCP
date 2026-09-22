# 建筑布局观察

`agent/helpers/layout.ts` 的 `readBuildingGeometry(game)` 分页读取真实尺寸、朝向和占地矩形；`diningSeats(buildings)` 返回与用餐桌面正交相邻的候选座位。它是几何检查，不替代原版的路径、预约、危险和放置规则。Pro-04的1×2餐桌曾只有一个有效餐位，第三高科台曾与分析仪蓝图位置相撞；这些实际失败已加入回归用例。

