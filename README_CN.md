# Codex 对抗式代码审查 — Claude Code 技能

一个 Claude Code 技能，使用 **OpenAI Codex** 对 git 变更进行多轮对抗式代码审查。不再由 Claude 审查自己的代码，而是由独立模型从 5-10 个不同攻击面执行审查。

## 工作原理

```
Claude（调度器）→ Codex CLI（审查者）× 5-10 轮 → 结构化发现 → Claude 分诊（修复/询问/跳过）
```

1. **第 1-5 轮（强制）**：每轮使用不同视角 — 语义、失败路径、测试、复杂度、安全
2. **第 6-10 轮（条件触发）**：如果任一强制轮次发现问题，自动追加 5 轮 — 并发、性能、API 兼容性、安全边界、最终敌意扫描
3. **分诊**：Claude 将每个发现分类为 `fix-now`（立即修复）、`ask-user`（询问用户）或 `no-action`（不处理）

## 前置条件

- 安装 [Codex CLI](https://github.com/openai/codex)：`npm install -g @openai/codex`
- 配置 OpenAI 认证：`codex login`
- 支持 skill 的 Claude Code (CC)

## 安装方式

```bash
# 克隆到 Claude Code 全局技能目录
mkdir -p ~/.claude/skills
cp -r . ~/.claude/skills/reviewing-workspace-changes-adversarially
```

或者软链接：

```bash
git clone git@github.com:yizhisec/codex-adversarially-review.git
ln -s "$(pwd)/codex-adversarially-review" ~/.claude/skills/reviewing-workspace-changes-adversarially
```

## 使用方式

在 Claude Code 中用自然语言触发：

```
> 对抗式审查当前改动
> 审查这个分支
> adversarial review against main
```

或者直接命令行运行：

```bash
# 审查 working tree
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs

# 审查分支 vs main
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs --base main

# 指定关注点
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs "关注认证和权限"

# JSON 输出
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs --json
```

## 审查轮次

### 强制轮次（始终执行）

| 轮次 | 视角 | 关注点 |
|---|---|---|
| 1 | 语义与不变量 | 错误行为、合约违反、缺失守卫、误导性假设 |
| 2 | 失败路径与降级行为 | 空值处理、重试、部分失败、超时、回滚缺口 |
| 3 | 测试、可观测性与恢复 | 缺失断言、假阳性测试、弱日志/指标 |
| 4 | 重复、复杂度与不必要抽象 | DRY 违反、过度抽象、YAGNI、死代码 |
| 5 | 安全、范围与集成 | 敏感文件、跨文件一致性、用户可见回归 |

### 延续轮次（第 1-5 轮出现 needs-attention 时触发）

| 轮次 | 视角 | 关注点 |
|---|---|---|
| 6 | 并发与状态耦合 | 竞态条件、死锁、过期状态、重入 |
| 7 | 性能与重复计算 | N+1 查询、无界增长、内存泄漏 |
| 8 | API、Schema 与兼容性 | 破坏性变更、版本偏移、迁移风险 |
| 9 | 安全与信任边界 | 注入、认证绕过、权限提升、密钥泄露 |
| 10 | 最终敌意扫描 | 假设前面所有轮次都遗漏了某些问题 |

## 输出格式

每轮产出结构化 JSON：

```json
{
  "verdict": "approve | needs-attention",
  "summary": "简短的可发布/不可发布评估",
  "findings": [{
    "severity": "critical | high | medium | low",
    "title": "...",
    "body": "...",
    "file": "path/to/file.ts",
    "line_start": 42,
    "line_end": 58,
    "confidence": 0.92,
    "recommendation": "..."
  }],
  "next_steps": ["..."]
}
```

所有轮次的结果会去重合并，渲染为 markdown 输出。

## 项目结构

```
SKILL.md                    # Claude 行为规则
plugin.json                 # App-server 客户端标识
scripts/
├── codex-review.mjs        # 主入口：5-10 轮循环
├── lib/
│   ├── codex.mjs           # Codex app-server 客户端（来自 codex-plugin-cc）
│   ├── app-server.mjs      # JSON-RPC over stdio
│   ├── git.mjs             # Diff/上下文收集
│   ├── render.mjs          # 多轮结果渲染
│   └── ...                 # 辅助模块
├── prompts/
│   └── adversarial-review.md  # 每轮 prompt 模板
└── schemas/
    └── review-output.schema.json  # 结构化输出 schema
```

`scripts/lib/` 下的运行时模块改编自 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Apache 2.0 许可）。

## 许可证

MIT
