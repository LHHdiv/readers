---
title: "第 23 章 · 工具参数校验 validation（宽松强转）"
date: 2026-07-01
summary: "Pi 让大模型\"自己调用工具\"（function calling）。但模型生成的参数本质上只是它\"随口说\"的一段 JSON 文本——它可能会把数字写成字符串、把布尔写成 `\"true\"`、把可选项写成 `null`。如果直接拿去用，轻则工具报错，重则破坏文件。本章讲 Pi 如何**宽松地**把这些\"自由文本 JS…"
tags:
  - pi
---
# 第 23 章 · 工具参数校验 validation（宽松强转）

> Pi 让大模型"自己调用工具"（function calling）。但模型生成的参数本质上只是它"随口说"的一段 JSON 文本——它可能会把数字写成字符串、把布尔写成 `"true"`、把可选项写成 `null`。如果直接拿去用，轻则工具报错，重则破坏文件。本章讲 Pi 如何**宽松地**把这些"自由文本 JSON"强转成正确类型，而不是一律拒绝。

## 1. 先建立直觉：为什么模型给的参数不可信

函数调用（见第 7 章）的对端是一个概率模型。它**不会**严格按照你给的 JSON Schema 输出。常见"翻车"现场：

- Schema 要 `number`，模型写了 `"42"`（字符串）。
- Schema 要 `boolean`，模型写了 `1` 或 `"true"`。
- Schema 里某字段可选（`required` 之外），模型却传了 `null`。
- Schema 要 `int`，模型写了 `42.0`。

如果 Pi 像严格 REST API 那样"类型不对就 400 拒绝"，那模型几乎每次都要重试，浪费 token 还打断思路。Pi 的选择是：**能救就救，救不了再报错**——这就是"宽松强转"（loose coercion）。

> **提示 · 黑话速查**
>
> - **TypeBox / JsonSchema**：描述"参数应该长什么样"的声明式 schema（类型、是否必填、子结构等）。
> - **校验（validation）**：检查一段数据是否符合 schema。
> - **强转（coercion）**：在类型不符时，尝试把它"变"成符合 schema 的类型（如 `"42"` → `42`）。

## 2. 校验入口与整体流程

两个对外函数都在 `packages/ai/src/utils/validation.ts`：

```ts
// packages/ai/src/utils/validation.ts:302-308
export function validateToolCall(tools, toolCall) {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
  return validateToolArguments(tool, toolCall);
}
```

核心流程在 `validateToolArguments`（`validation.ts:317-350`），按固定顺序执行：

```text
1. clone            结构化克隆参数，绝不改动模型原始输入（validation.ts:318）
2. normalizeOptionalNulls   清掉"可选字段里的 null"（validation.ts:319）
3. Value.Convert     按 TypeBox 做标准类型转换（validation.ts:320）
4. coerceWithJsonSchema   宽松强转（字符串"42"→数字等）（validation.ts:324）
5. Compile + Check  最终严格校验（validation.ts:322, 337）
6. 失败 → 抛出带路径的友好错误（validation.ts:341-349）
```

## 3. 逐步拆解

### 3.1 先克隆，绝不污染原始输入

```ts
// packages/ai/src/utils/validation.ts:318
const args = structuredClone(toolCall.arguments);
```

`structuredClone` 深拷贝一份。后面所有强转都在副本上做，模型最初给的 `toolCall.arguments` 始终原样保留——这对"调试时回看模型到底说了什么"很有用。

### 3.2 清理可选字段里的 `null`

```ts
// packages/ai/src/utils/validation.ts:240-269
function normalizeOptionalNulls(value, schema) {
  ...
  if (object[key] === null && !required.has(key) && ...) {
    delete object[key];   // 非必填又给了 null → 直接删掉
  }
}
```

模型常把"不想填"的字段写成 `null`。如果该字段不是 `required`，删掉它比保留 `null` 更安全（很多 schema 不允许 `null`）。注意它只删**可选**字段，必填字段的 `null` 会保留并交给后续校验去报错（明确定位问题）。

### 3.3 `Value.Convert`：TypeBox 的标准转换

```ts
// packages/ai/src/utils/validation.ts:320
Value.Convert(tool.parameters, args);
```

这是 TypeBox 自带的转换：比如 schema 声明 `Type.Number()`，而值是字符串 `"42"`，`Value.Convert` 会尝试把它转成数字 `42`。这一步已经能解决大部分"模型把数字写成字符串"的问题。

### 3.4 宽松强转：自己再兜一层

但 `Value.Convert` 不够用——它不处理 `"true"` → `true`、`1` → `true`、或 `null` → `""` 这类"跨类型"的宽松映射。于是 Pi 自己写了 `coerceWithJsonSchema`（`validation.ts:194-238`），逐层递归地处理：

```ts
// packages/ai/src/utils/validation.ts:59-131
function coercePrimitiveByType(value, type) {
  switch (type) {
    case "number":
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;   // "42" → 42
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    case "boolean":
      if (value === "true") return true;              // 字符串 "true" → true
      if (value === "false") return false;
      if (value === 1) return true;                   // 数字 1 → true
      ...
    case "string":
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      ...
  }
}
```

它会在每个字段上，根据 schema 声明的 `type` 做"尽量贴合"的转换。`coerceWithJsonSchema` 还会递归进入 `object` 的 `properties`（`validation.ts:224-231`）和 `array` 的 `items`（`validation.ts:233-235`），以及处理 `anyOf`/`oneOf` 联合类型（`validation.ts:175-192`）。

> **说明 · 为什么"宽松强转"而非"直接拒绝"？**
>
> 模型是概率性的，偶尔类型写错是常态而非异常。如果一律拒绝，会让 agent 陷入"工具调用失败 → 重试 → 再失败"的死循环，既烧钱又完不成任务。宽松强转把"明显是同一语义但写法不同"的情况（如 `"42"` 与 `42`）自动归一，只把**真正无法解释**的输入（如把 `"abc"` 当 number）交给严格校验去报错。这是一种"对模型宽容、对用户负责"的工程取舍。

### 3.5 最终严格校验

```ts
// packages/ai/src/utils/validation.ts:271-280
function getValidator(schema) {
  const cached = validatorCache.get(key);   // WeakMap 缓存编译结果
  if (cached) return cached;
  const validator = Compile(schema);         // 编译 schema 为快速校验器
  validatorCache.set(key, validator);
  return validator;
}
```

`Compile`（TypeBox）把 schema 编译成一个高性能校验器，并用 `WeakMap` 缓存（同一个 schema 只编译一次，`validation.ts:6`）。最后：

```ts
// packages/ai/src/utils/validation.ts:337-339
if (validator.Check(args)) {
  return args;   // 通过！返回（可能已被强转过的）参数
}
```

### 3.6 失败时的友好报错

```ts
// packages/ai/src/utils/validation.ts:341-349
const errors = validator.Errors(args)
  .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
  .join("\n") || "Unknown validation error";
throw new Error(
  `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`
);
```

`formatValidationPath`（`validation.ts:282-293`）会把 JSON 路径（`/foo/bar`）转成点路径（`foo.bar`），并补全 `required` 缺失的字段名，让模型能精准定位问题、自我修正。

## 4. 对照示例：模型把 42 写成 "42"

假设工具 `multiply` 的 schema 要求 `a: number, b: number`，模型实际生成：

```json
{ "a": "42", "b": 7 }
```

走校验流程：

| 步骤 | `a` 的值 | 说明 |
|------|---------|------|
| 原始输入 | `"42"` | 字符串，类型不符 |
| `Value.Convert` | `"42"` | TypeBox 标准转换尝试，可能已转成 `42` |
| `coercePrimitiveByType("42","number")` | `42` | `Number("42")` 有限 → 返回 `42`（`validation.ts:65-69`） |
| `Compile.Check` | `42` | 通过 |

而 `b = 7` 本来就对，原样保留。最终返回 `{ a: 42, b: 7 }`，工具正常执行。

> 如果模型写的是 `{ "a": "abc", "b": 7 }`，`Number("abc")` 是 `NaN`，`Number.isFinite` 为 false（`validation.ts:67`），强转失败；最终 `Check` 不过，抛出"Validation failed"，并把原始参数原样回显给模型去修。这就是"能救才救"的边界。

## 5. 在 agent 循环中的位置

参数校验不是独立运行的，它被工具执行前调用。回顾第 25 章会看到：`prepareToolCall` → `validateToolArguments(tool, preparedToolCall)`（`packages/agent/src/agent-loop.ts:618`）。也就是说，**每一轮模型发起工具调用，都会先过这一关**；校验失败不会让整个 agent 崩，而是被包成一条 `isError` 的工具结果回灌给模型（见 `agent-loop.ts:661-667` 的 catch）。

> **提示 · 一句话总结**
>
> 校验 = 克隆 → 清可选 null → 标准转换 → 宽松强转 → 严格校验 → 友好报错。目标只有一个：让"嘴瓢"的模型参数也能尽量跑起来。

## 自查清单

- [ ] 我能说出"宽松强转"和"直接拒绝"的区别，以及 Pi 为什么选前者。
- [ ] 我知道校验的 6 步流程（clone / normalize / Convert / coerce / Check / throw）。
- [ ] 我能在源码定位 `validateToolArguments`（`validation.ts:317`）与 `coercePrimitiveByType`（`validation.ts:59`）。
- [ ] 我能解释 `"42"` → `42` 在哪些行被处理。
- [ ] 我理解 `validatorCache` 用 `WeakMap` 缓存的意义（同 schema 只编译一次）。
- [ ] 我知道校验失败时参数是被"原样回显"给模型而非丢弃。
