# WorkBuddy 开发上下文

本项目使用 WorkBuddy 开发完成。以下为开发过程中的关键对话上下文记录，用于核验 WorkBuddy 专项奖励联动条件。

## 开发目标

创建一个麦当劳餐品推荐 Skill，名称"今天吃了唛~"（`jintian-chile-me`）。用户输入想要的类型（价格区间、口味、营养搭配、热量、套餐等条件），Agent 调用麦当劳 MCP（mcd-mcp）获取真实餐品列表，结合用户条件筛选最适配的餐品，并输出价格、热量、蛋白质、碳水、脂肪信息；无匹配时给出最接近的推荐。

## 开发过程要点

1. **阅读官方文档**：先阅读了麦当劳程序员创意开发大赛 README（<https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/README.md>），明确了必选文件清单：
   - `README.md`（项目介绍、安装、示例、目标用户）
   - `CONTEST_DECLARATION.md`（参赛声明，原文不可改动）
   - `MCP_INTEGRATION.md`（MCP 集成说明）
   - 源代码（形式不限，本项目的 Skill 主体为 `SKILL.md`）
   - `workbuddy.md`（WorkBuddy 联动奖励，非必须）
2. **调研 MCP 工具**：阅读 mcd-mcp-server 使用指南，确认工具清单与数据字段：
   - `list-nutrition-foods`：营养数据（`productName, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`）
   - `query-nearby-stores`：门店定位（返回 `storeCode`）
   - `query-meals`：菜单 + 价格（`name, currentPrice, originalPrice, discountType, tags`）
   - `query-meal-detail`：套餐组成
3. **实测 MCP 数据**：实际调用了 `list-nutrition-foods`、`query-nearby-stores`、`query-meals`，确认真实返回结构与字段，据此设计"营养表 + 价格表按名称关联"的合并筛选逻辑，以及套餐营养求和方案。
4. **产出文件**：在项目目录下按文档要求创建全部文件，Skill 主体采用标准 SKILL.md 格式（含 frontmatter 的 name/description 与触发词）。
5. **交付 Web 演示**：额外产出一个豆包式对话推荐网页（`web/index.html` + `web/server.js`）。后端用 Node 零依赖直连 `https://mcp.mcd.cn`（Streamable HTTP，`tools/call`），实时拉菜单/营养/套餐数据；前端通过 `/api/recommend` 交互。另附命令行演示脚本 `demo.py`（内置快照，可离线跑通）。

## 关键技术决策

- **营养与价格双数据源合并**：`list-nutrition-foods` 管营养、`query-meals` 管价格，以餐品名称为键做模糊匹配关联，实现"价格 + 热量 + 三大营养素"一体输出。
- **套餐营养求和**：套餐营养不在营养表直接给出，通过 `query-meal-detail` 拆包组成项后逐项求和。**套餐必须先拆包求和、再模糊匹配**（否则会被误匹配成单品营养值）。
- **营养估算兜底**：`list-nutrition-foods` 未覆盖部分新品，主餐营养缺失时按品类近似匹配取同类单品均值估算，打 `estimated` 标记，前端标注「估算」；酱料/小物等非正餐合理留白。
- **无匹配兜底**：没有完全满足条件的餐品时，返回"最接近"推荐并说明差异维度与差距。

## 环境

- 开发工具：WorkBuddy
- MCP：mcd-mcp（`https://mcp.mcd.cn`，Streamable HTTP）
- 测试门店示例：麦当劳北京东华门大街(景泰蓝)餐厅（storeCode: 1951020）
