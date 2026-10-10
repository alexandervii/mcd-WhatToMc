# MCP 集成说明

本文档说明"今天吃了唛~"Skill 实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。

## 1. 使用的 MCP Server

| 项目 | 说明 |
|---|---|
| MCP 名称 | `mcd-mcp` |
| 服务地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 认证方式 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 限流 | 每分钟 600 次请求，超出返回 429 |

完整脱敏配置示例见仓库根目录的 `mcp-config.example.json`（Token 使用环境变量占位符，不提交真实凭证）：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer ${MCD_MCP_TOKEN}"
      }
    }
  }
}
```

## 2. 使用的 Tool

本 Skill 主要使用以下 4 个 Tool：

| Tool | 用途 | 关键入参 |
|---|---|---|
| `list-nutrition-foods` | 获取全量餐品营养成分（能量、蛋白质、脂肪、碳水、钠、钙） | 无 |
| `query-nearby-stores` | 按城市/关键词定位附近门店，获取 `storeCode` | `beType`, `searchType`, `city`, `keyword` |
| `query-meals` | 查询门店当前可售卖餐品菜单、价格、标签、分类 | `storeCode`, `orderType`, `beType` |
| `query-meal-detail` | 查询餐品（套餐）详情与组成，用于营养求和 | `storeCode`, `orderType`, `beType`, `code` |

> 说明：`list-nutrition-foods` 提供营养维度数据，`query-meals` / `query-meal-detail` 提供价格与套餐组成维度数据。二者以餐品名称为键做关联合并，是"营养 + 价格"双重筛选的数据基础。

## 3. 调用流程

```
用户输入条件
      │
      ▼
① 解析需求：价格区间 / 口味 / 营养目标 / 热量区间 / 套餐类型 / 位置
      │
      ▼
② query-nearby-stores ──→ 获取 storeCode（需定位时）
      │
      ├──────────────────────────────────────┐
      ▼                                      ▼
③ list-nutrition-foods              ④ query-meals
   营养数据(kcal/蛋白/碳/脂)            菜单+价格+tags+分类
      │                                      │
      └──────────────┬───────────────────────┘
                     ▼
⑤（套餐时）query-meal-detail ──→ 拆包组成，营养求和
                     │
                     ▼
⑥ 合并映射 → 按条件过滤 → 排序
                     │
                     ▼
⑦ 输出推荐清单（价格/热量/蛋白质/碳水/脂肪 + 推荐理由）
```

## 4. 数据关联方式

- **营养数据源**：`list-nutrition-foods` 返回字段 `productName, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`。
- **价格数据源**：`query-meals` 返回 `meals{code:{name, currentPrice, originalPrice, discountType}}` 及 `categories[]`（含 tags 标签）。
- **关联键**：以 `productName` ↔ `name` 做映射（支持模糊匹配，如"可乐"↔"可乐中杯"，并处理全半角括号、规格词差异）。
- **套餐营养**：`query-meal-detail` 返回套餐组成项，逐项在营养表中匹配单品后累加求和。注意优先级——**套餐必须先拆包求和，再考虑单品模糊匹配**，否则"巨无霸三件套"会被误匹配成单品"巨无霸"的营养值（513kcal 而非真实 949kcal）。
- **营养估算兜底**：`list-nutrition-foods` 未覆盖部分新品（如"龙焰"系列、蘸酱炸鸡、新品雪冰/麦旋风等）。当主餐营养缺失时，按**品类近似匹配**（鸡腿堡/牛堡/鱼堡/鸡翅/卷/炸鸡/甜品/拼盘/乐园餐等）取同类已知单品的营养均值估算，并打 `estimated` 标记；前端明确标注「营养为同类餐品估算值」。酱料、小物等非正餐则合理留白（不展示营养）。

## 5. 业务价值

1. **解决"选择困难"**：把用户模糊的用餐诉求（预算、热量、营养、口味）转化为可执行的筛选条件，从真实菜单里给出可落地推荐。
2. **营养可视化**：把分散的营养数据与价格数据打通，让用户一眼看到每款餐品/套餐的"价格 + 热量 + 三大营养素"。
3. **数据实时可信**：全部数据来自麦当劳官方 MCP 实时返回，避免过时菜单与错误价格。
4. **无匹配兜底**：当没有餐品完全满足条件时，主动给出最接近的推荐并说明差异，提升体验闭环。
