# 如何优化工具调用往返

## 核心原则

**最小化往返次数**。每次用户输入 `.` 都是一次往返，应当尽量减少。

## 反模式：逐个文件读取和修改

❌ **不好的做法**：
```
1. 读文件 A
2. 用户输入 .
3. 读文件 B
4. 用户输入 .
5. 改文件 A
6. 用户输入 .
7. 改文件 B
8. 用户输入 .
```

这样需要 7 次往返（4 次用户输入）。

## 正确模式：批量读取、批量修改

✅ **好的做法**：
```
1. 一次性读取所有需要的文件（A, B, C, D, E）
2. 用户输入 .
3. 一次性修改所有文件（A, B, C, D, E）
4. 完成
```

这样只需要 1 次往返（1 次用户输入）。

## 实施要点

### 1. 前期调查阶段已经明确了改动范围

如果你已经做过改动面评估，或者用户已经明确告诉你要改哪些文件，那么：

- **不要**逐个文件读取
- **应该**在一个 `<function_calls>` 块里一次性读取所有文件

### 2. 读取时要完整

- 如果文件不大（< 500 行），直接全文读取
- 如果文件很大，读取你需要修改的所有区域
- 宁可多读一些，也不要分多次读

### 3. 修改时要批量

- 把所有 `edit` 调用放在同一个 `<function_calls>` 块里
- 不要改一个文件就等用户输入
- 一次性完成所有修改

## 示例对比

### 不好的示例

用户说："改这 5 个文件"

```xml
<!-- 第 1 次调用 -->
<function_calls>
<invoke name="read">
<parameter name="filePath">file1.ts</parameter>
</invoke>
</function_calls>

<!-- 用户输入 . -->

<!-- 第 2 次调用 -->
<function_calls>
<invoke name="read">
<parameter name="filePath">file2.ts</parameter>
</invoke>
</function_calls>

<!-- 用户输入 . -->

<!-- 第 3 次调用 -->
<function_calls>
<invoke name="edit">
<parameter name="filePath">file1.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
</function_calls>

<!-- 用户输入 . -->

<!-- 第 4 次调用 -->
<function_calls>
<invoke name="edit">
<parameter name="filePath">file2.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
</function_calls>
```

**问题**：需要 4 次往返，效率低下。

### 好的示例

用户说："改这 5 个文件"

```xml
<!-- 第 1 次调用：批量读取 -->
<function_calls>
<invoke name="read">
<parameter name="filePath">file1.ts</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">file2.ts</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">file3.ts</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">file4.ts</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">file5.ts</parameter>
</invoke>
</function_calls>

<!-- 用户输入 . -->

<!-- 第 2 次调用：批量修改 -->
<function_calls>
<invoke name="edit">
<parameter name="filePath">file1.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
<invoke name="edit">
<parameter name="filePath">file2.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
<invoke name="edit">
<parameter name="filePath">file3.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
<invoke name="edit">
<parameter name="filePath">file4.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
<invoke name="edit">
<parameter name="filePath">file5.ts</parameter>
<parameter name="oldString">...</parameter>
<parameter name="newString">...</parameter>
</invoke>
</function_calls>
```

**优势**：只需要 1 次往返，效率最高。

## 特殊情况

### 文件太大需要分段读取

如果单个文件超过 2000 行，可能需要分段读取：

```xml
<function_calls>
<invoke name="read">
<parameter name="filePath">large-file.ts</parameter>
<parameter name="offset">1</parameter>
<parameter name="limit">500</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">large-file.ts</parameter>
<parameter name="offset">501</parameter>
<parameter name="limit">500</parameter>
</invoke>
<invoke name="read">
<parameter name="filePath">other-file.ts</parameter>
</invoke>
</function_calls>
```

**关键**：即使分段读取，也要在同一个 `<function_calls>` 块里完成。

### 需要根据第一个文件的内容决定后续操作

如果确实需要先读一个文件，根据内容再决定读哪些文件，那么分两次调用是合理的。但这种情况应该很少见。

大多数时候，你在改动面评估阶段就已经知道要改哪些文件了。

## 检查清单

在执行修改任务前，问自己：

- [ ] 我是否已经知道要改哪些文件？
- [ ] 我是否可以一次性读取所有这些文件？
- [ ] 我是否可以一次性完成所有修改？

如果三个答案都是"是"，那就应该批量操作。

## 总结

- **读取阶段**：一次性读取所有需要的文件
- **修改阶段**：一次性完成所有修改
- **目标**：将往返次数降到最低（理想情况是 1 次）
